import test from "node:test";
import assert from "node:assert/strict";
import { createPhotos } from "../server/v2/photos";
import { createGatewayV2 } from "../server/v2/gateway";
import { MemoryRepository, EMPTY_WORKSPACE } from "../server/v2/memory";
import { ApiRequest, CLEAR_CONFIRMATION, Entity } from "../miniprogram/domain/v2/protocol";
const prefix = "pg://xuedu-photos/";
const row = (id: string, data: Record<string, unknown>, extra: Partial<Entity> = {}): Entity => ({ id, epoch: "old-epoch", version: 1, data, ...extra });
function setup() {
  const files = new Map<string, Uint8Array>();
  const uploaded: { path: string; bytes: Uint8Array; options: { contentType: string; upsert: boolean } }[] = [];
  const removed: string[][] = [], listed: { path: string; limit: number; withDelimiter: boolean }[] = [], signed: { paths: string[]; expires: number }[] = [];
  let listOverride: unknown, removeFailure = false, uploadFailure = false, signOverride: unknown;
  const bucket = {
    async upload(path: string, bytes: Uint8Array, options: { contentType: string; upsert: boolean }) {
      uploaded.push({ path, bytes, options });
      if (uploadFailure) return { data: null, error: { message: "private SDK diagnostics" } };
      files.set(path, bytes); return { data: { path }, error: null };
    },
    async list(path: string, options: { limit: number; withDelimiter: boolean }) {
      listed.push({ path, ...options });
      if (listOverride !== undefined) return { data: listOverride, error: null };
      const found = [...files.keys()].filter(key => key.startsWith(path)).sort();
      return { data: { objects: found.slice(0, options.limit).map(name => ({ name })), folders: [], hasNext: found.length > options.limit }, error: null };
    },
    async remove(paths: string[]) {
      removed.push(paths);
      if (removeFailure) return { data: null, error: { message: "private SDK diagnostics" } };
      paths.forEach(path => files.delete(path)); return { data: paths.map(name => ({ name })), error: null };
    },
    async createSignedUrls(paths: string[], expires: number) {
      signed.push({ paths, expires });
      return { data: signOverride === undefined ? paths.slice().reverse().map(path => ({ path, fullSignedURL: "https://private.example/signed/" + path, error: null })) : signOverride, error: null };
    },
  };
  const photos = createPhotos(bucket, value => new Uint8Array(Buffer.from(value, "base64")));
  const course = { id: "course", semesterId: "semester", name: "课程", teacher: "教师", nature: "必修", classIds: ["class"], classroom: "101", weekday: 1, start: 1, end: 2, weeks: [1], expected: 30 };
  const repository = new MemoryRepository({ ...EMPTY_WORKSPACE, epoch: "old-epoch", version: 1, activeSemesterId: "semester", maxExecutionMs: 3000 }, {
    members: [row("admin", { role: "admin", active: true, classId: "class", name: "管理员", studentNo: "001" }, { studentNo: "001" })],
    bindings: [row("binding", {}, { identityKey: "wx-admin", memberId: "admin" })],
    classes: [row("class", { name: "班级", grade: "25", major: "自动化", active: true })],
    semesters: [row("semester", { name: "学期", startDate: "2026-09-07", weeks: 20, days: 7, periods: 14, edition: "", grades: ["25"] })],
    occurrences: [row("occurrence", { course, status: "active" }, { semesterId: "semester", week: 1, date: "2026-09-07" })],
    tasks: [row("task", { course, classes: [{ id: "class", name: "班级", grade: "25", major: "自动化" }], occurrenceId: "occurrence", date: "2026-09-07", status: "confirmed", memberName: "管理员" }, { semesterId: "semester", week: 1, memberId: "admin" })],
  });
  let id = 0, now = Date.parse("2026-09-07T03:00:00Z");
  const gateway = createGatewayV2({ repository, appid: "app", bootstrapOpenid: "wx-admin", photos, maxExecutionMs: 3000, uuid: () => "uuid-" + ++id, now: () => now });
  const call = async (operation: string, payload: Record<string, unknown> = {}, extra: Partial<ApiRequest> = {}) => gateway({ protocolVersion: 2, operation, epoch: (await repository.workspace()).epoch, semesterId: "semester", requestId: "request-" + ++id, payload, ...extra }, { OPENID: "wx-admin", APPID: "app" });
  return { files, uploaded, removed, listed, signed, photos, repository, call, advance: (ms: number) => now += ms, list: (data: unknown) => listOverride = data, removeFailure: (value: boolean) => removeFailure = value, uploadFailure: (value: boolean) => uploadFailure = value, signatures: (data: unknown) => signOverride = data };
}

test("photo integration uploads decoded bytes only into current epoch and reads signed URLs through record authorization", async () => {
  const f = setup();
  const uploaded = await f.call("photo", { taskId: "task", base64: Buffer.from([255, 216, 255, 217]).toString("base64") });
  assert.equal(f.uploaded.length, 1); assert.match(f.uploaded[0].path, /^cloud\/old-epoch\/stable-[a-f0-9]{64}\.jpg$/);
  assert.deepEqual([...f.uploaded[0].bytes], [255, 216, 255, 217]); assert.deepEqual(f.uploaded[0].options, { contentType: "image/jpeg", upsert: true });
  const photoId = String(uploaded.data.fileID), photo = (await f.repository.get("photos", photoId))!;
  assert.equal(photo.data.storageId, prefix + f.uploaded[0].path);
  const metrics = { expected: 30, actual: 30, late: 0, early: 0, sleep: 0, phone: 0, talk: 0, other: 0 };
  const submitted = await f.call("command", { type: "recordSubmit", taskId: "task", metrics, photos: [photoId] }, { expectedVersion: 1 });
  const record = (submitted.data.changed as Entity[]).find(entity => entity.data.firstSubmittedAt)!;
  const urls = await f.call("photoUrls", { recordId: record.id });
  assert.deepEqual(urls.data.urls, ["https://private.example/signed/" + f.uploaded[0].path]);
  assert.deepEqual(f.signed[0], { paths: [f.uploaded[0].path], expires: 300 });
  assert.equal(JSON.stringify(urls).includes("wx-admin"), false);
});

test("photo adapter rejects invalid paths, overlarge images, malformed signatures and SDK upload failure", async () => {
  const f = setup();
  await assert.rejects(f.photos.upload("cloud/old-epoch/../future.jpg", "aGVsbG8="), /业务目录/);
  await assert.rejects(f.photos.upload("public/file.jpg", "aGVsbG8="), /业务目录/);
  await assert.rejects(f.photos.upload("cloud/old-epoch/large.jpg", Buffer.alloc(512001).toString("base64")), /500KB/);
  f.uploadFailure(true); await assert.rejects(f.call("photo", { taskId: "task", base64: "aGVsbG8=" }), /照片上传失败/);
  assert.equal((await f.repository.query("photos", {})).items.length, 0);
  f.signatures([{ path: "cloud/old-epoch/photo.jpg", fullSignedURL: "http://unsafe.example/photo.jpg" }]);
  await assert.rejects(f.photos.urls([prefix + "cloud/old-epoch/photo.jpg"]), /链接无效/);
  f.signatures([{ path: "cloud/other-epoch/photo.jpg", fullSignedURL: "https://private.example/other" }]);
  await assert.rejects(f.photos.urls([prefix + "cloud/old-epoch/photo.jpg"]), /链接无效/);
});

for (const [name, result] of [
  ["cross epoch", { objects: [{ name: "cloud/future/photo.jpg" }], folders: [], hasNext: false }],
  ["nested folder", { objects: [], folders: [{ name: "unexpected/" }], hasNext: false }],
  ["empty truncated page", { objects: [], folders: [], hasNext: true }],
  ["missing truncation metadata", { objects: [], folders: [] }],
] as const) test("photo clearing fails closed on " + name, async () => {
  const f = setup(); f.list(result);
  const start = await f.call("clearBegin", { confirmation: CLEAR_CONFIRMATION }, { expectedVersion: 1 }); f.advance(4001);
  await assert.rejects(f.call("clearStep", { jobId: start.data.jobId }), /清理|轮次/);
  assert.equal(f.removed.length, 0); assert.equal((await f.repository.workspace()).epoch, "old-epoch");
  assert.ok((await f.repository.workspace()).maintenance); assert.deepEqual(f.listed[0], { path: "cloud/old-epoch/", limit: 20, withDelimiter: false });
});

test("photo cleanup retries failed SDK removal in bounded batches, includes orphans, never removes future epoch", async () => {
  const f = setup();
  for (let i = 0; i < 23; i++) f.files.set(`cloud/old-epoch/orphan-${i}.jpg`, new Uint8Array([1]));
  f.files.set("cloud/future/keep.jpg", new Uint8Array([2]));
  const begin = await f.call("clearBegin", { confirmation: CLEAR_CONFIRMATION }, { expectedVersion: 1 }); const jobId = begin.data.jobId; f.advance(4001);
  f.removeFailure(true);
  await assert.rejects(f.call("clearStep", { jobId }, { requestId: "retry-id" }), /删除失败/);
  assert.equal(f.files.size, 24); assert.ok((await f.repository.workspace()).maintenance);
  f.removeFailure(false); f.advance(4001);
  await f.call("clearStep", { jobId }, { requestId: "retry-id" });
  assert.equal(f.files.size, 4);
  for (let i = 0; i < 20; i++) { const response = await f.call("clearStep", { jobId }); if (response.data.done) break; }
  const current = await f.repository.workspace(); assert.notEqual(current.epoch, "old-epoch"); assert.equal(current.maintenance, "");
  assert.deepEqual([...f.files.keys()], ["cloud/future/keep.jpg"]);
  assert.ok(f.removed.every(paths => paths.length <= 20 && paths.every(path => path.startsWith("cloud/old-epoch/"))));
  const deletions = f.removed.length;
  assert.equal((await f.call("clearStep", { jobId })).data.done, true);
  await assert.rejects(f.call("clearStep", { jobId }, { epoch: "old-epoch" }), /刷新/);
  assert.equal(f.removed.length, deletions);
});

test("photo signed URL adapter preserves requested ordering and rejects unknown/missing entries", async () => {
  const f = setup();
  const paths = ["cloud/old-epoch/first.jpg", "cloud/old-epoch/second.png"];
  const urls = await f.photos.urls(paths.map(path => prefix + path));
  assert.deepEqual(urls, paths.map(path => "https://private.example/signed/" + path));
  f.signatures([{ path: paths[0], fullSignedURL: "https://private.example/first", error: null }]);
  await assert.rejects(f.photos.urls(paths.map(path => prefix + path)), /链接无效/);
  await assert.rejects(f.photos.list("cloud/"), /固定旧轮次/);
  assert.equal(f.listed.length, 0);
});


test("content-addressed retries reuse one object; changed bytes use a different path; legacy paths never upsert", async () => {
  const f=setup(), base64=Buffer.from([255,216,255,217]).toString("base64");
  const request={requestId:"same-upload"};const first=await f.call("photo",{taskId:"task",base64},request);
  const again=await f.call("photo",{taskId:"task",base64},request);assert.equal(first.data.fileID,again.data.fileID);assert.equal(f.uploaded.length,1);
  await f.call("photo",{taskId:"task",base64});assert.equal(f.files.size,1);
  await f.call("photo",{taskId:"task",base64:Buffer.from([255,216,1,255,217]).toString("base64")});assert.equal(f.files.size,2);
  await f.photos.upload("cloud/old-epoch/legacy.jpg",base64);assert.equal(f.uploaded.at(-1)!.options.upsert,false);
});
