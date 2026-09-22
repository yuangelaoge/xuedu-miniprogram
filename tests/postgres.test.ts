import test from "node:test";
import assert from "node:assert/strict";
import { postgresTransaction, postgresPhotos, PgRpc } from "../server/postgres";
import { createGateway, Document } from "../server/gateway";

function fixture() {
  let document: Document | undefined, revision = 0, commits = 0;
  const db: PgRpc = {
    async rpc(name, args) {
      if (name === "xuedu_read_workspace") {
        document ||= structuredClone(args.p_initial as Document);
        return { data: structuredClone({ revision, document }), error: null };
      }
      commits++;
      if (args.p_revision !== revision) return { data: false, error: null };
      document = structuredClone(args.p_document as Document);
      revision++;
      return { data: true, error: null };
    },
  };
  return { db, transact: postgresTransaction(db, "trial", () => "epoch-1"),
    state: () => document!, revision: () => revision, commits: () => commits };
}

test("PG CAS 防止并发写覆盖，提交后清除请求身份", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 5 }, (_, i) => f.transact(async doc => {
    doc.receipts.push("request-" + i); doc.state.actorId = "private-actor"; doc.version++;
  })));
  assert.equal(f.state().receipts.length, 5);
  assert.equal(f.state().version, 5);
  assert.equal(f.state().state.actorId, "");
  assert.equal(f.revision(), 5);
});

test("PG 只读不提交，业务抛错不保存半成品", async () => {
  const f = fixture();
  await f.transact(async () => undefined);
  await assert.rejects(f.transact(async doc => { doc.receipts.push("bad"); throw new Error("deny"); }), /deny/);
  assert.equal(f.commits(), 0);
  assert.deepEqual(f.state().receipts, []);
});

test("PG 清理冻结即使未改变业务版本也参与 CAS", async () => {
  const f = fixture();
  let first = true;
  await assert.rejects(f.transact(async doc => {
    if (first) { first = false; await f.transact(async other => { other.cleaning = true; }); }
    if (doc.cleaning) throw new Error("frozen");
    doc.version++;
  }), /frozen/);
  assert.equal(f.state().cleaning, true);
  assert.equal(f.state().version, 0);
});

test("PG 不重放提交结果不明的请求，不向客户端泄露数据库错误", async () => {
  let commits = 0;
  const f = fixture();
  const transact = postgresTransaction({ async rpc(name, args) {
    if (name === "xuedu_commit_workspace") { commits++; return { data: null, error: "private database details" }; }
    return f.db.rpc(name, args);
  } }, "trial", () => "epoch-1");
  await assert.rejects(transact(async doc => { doc.version++; }), error => {
    assert.doesNotMatch(String(error), /private database/); return true;
  });
  assert.equal(commits, 1);
});

test("PG 诊断只暴露受限错误码，不泄露服务端详情或注入字符串", async () => {
  for (const code of ["42501", "unsafe secret token content"]) {
    const transact = postgresTransaction({ async rpc() {
      return { data: null, error: { code, message: "private SQL", details: "private row" } };
    } }, "trial", () => "epoch-1");
    await assert.rejects(transact(async () => undefined), error => {
      assert.doesNotMatch(String(error), /private|unsafe|secret/);
      if (code === "42501") assert.match(String(error), /42501/);
      return true;
    });
  }
});

test("PG 适配层运行真实网关，拒绝冒充身份并去重并发请求", async () => {
  const f = fixture();
  const gateway = createGateway({ stage: "trial", appid: "app", bootstrapOpenid: "owner", transact: f.transact,
    uuid: () => "epoch-1", upload: async () => "unused", deleteFiles: async () => {}, urls: async () => [] });
  await assert.rejects(gateway({ operation: "snapshot", OPENID: "owner" }, {}), /微信身份/);
  const context = { OPENID: "owner", APPID: "app" };
  const snapshot: any = await gateway({ operation: "snapshot" }, context);
  const event = { operation: "command", epoch: snapshot.epoch, requestId: "same-request",
    command: { type: "join", form: { name: "测试管理员", studentNo: "20260001", classId: f.state().state.classes[0].id } } };
  await Promise.all([gateway(event, context), gateway(event, context)]);
  assert.equal(f.state().state.members.length, 1);
  assert.equal(f.state().state.members[0].role, "admin");
  assert.equal(f.state().version, 1);
});

test("PG 照片校验环境路径、私有签名有效期和返回顺序", async () => {
  const calls: any[] = [];
  const photos = postgresPhotos({
    async upload(path, _data, options) { calls.push(options); return { data: { path }, error: null }; },
    async remove(paths) { calls.push(paths); return { data: [], error: null }; },
    async createSignedUrls(paths, ttl) { calls.push(ttl); return {
      data: paths.map(path => ({ path, fullSignedURL: "https://storage.example/" + path, error: null })).reverse(), error: null }; },
  }, "trial");
  const id = await photos.upload("trial/epoch-1/photo-1.jpg", new Uint8Array());
  assert.equal(id, "pg://xuedu-photos/trial/epoch-1/photo-1.jpg");
  assert.deepEqual(calls[0], { contentType: "image/jpeg", upsert: false });
  assert.deepEqual(await photos.urls([id, id.replace("photo-1", "photo-2")]), [
    "https://storage.example/trial/epoch-1/photo-1.jpg", "https://storage.example/trial/epoch-1/photo-2.jpg"]);
  assert.equal(calls[1], 300);
  await assert.rejects(photos.deleteFiles([id.replace("trial/", "production/")]), /路径/);
  await assert.rejects(photos.urls(["pg://other/trial/epoch-1/photo-1.jpg"]), /标识/);
  await assert.rejects(photos.upload("trial/../photo.jpg", new Uint8Array()), /路径/);
});

test("彻底重置扫描全部试用目录含孤儿照片，拒绝越界路径和不完整清单", async () => {
  let response: any = { folders: [], objects: [{ name: "trial/old-epoch/orphan.jpg" }], hasNext: true };
  let error: unknown = null;
  const photos = postgresPhotos({
    async list(path, options) { assert.equal(path, "trial/"); assert.deepEqual(options, { limit: 20, withDelimiter: false }); return { data: response, error }; },
    async upload() { return { data: null, error: null }; },
    async remove() { return { data: [], error: null }; },
    async createSignedUrls() { return { data: [], error: null }; },
  }, "trial");
  assert.deepEqual(await photos.listResetFiles(), ["pg://xuedu-photos/trial/old-epoch/orphan.jpg"]);
  response = { folders: [], objects: [{ name: "production/old-epoch/orphan.jpg" }], hasNext: false };
  await assert.rejects(photos.listResetFiles(), /路径/);
  response = { folders: [], objects: [], hasNext: true };
  await assert.rejects(photos.listResetFiles(), /核查失败/);
  response = { folders: [], objects: [], hasNext: false };
  error = { secret: "do-not-return" };
  await assert.rejects(photos.listResetFiles(), /核查失败/);
  error = null;
  assert.deepEqual(await photos.listResetFiles(), []);
});

test("PG CAS 上的换届清空并发开始及步骤共享一个任务，不重复删照片", async () => {
  const f = fixture(); let sequence = 0, now = 0;
  const photos = new Set(["old-photo"]), deleted: string[] = [];
  const gateway = createGateway({ stage: "trial", appid: "app", bootstrapOpenid: "owner", transact: f.transact,
    uuid: () => "id-" + ++sequence, now: () => now,
    async listResetFiles() { return [...photos]; },
    async upload() { return "unused"; }, async urls() { return []; },
    async deleteFiles(ids) { deleted.push(...ids); ids.forEach(id => photos.delete(id)); },
  });
  const context = { OPENID: "owner", APPID: "app" };
  await gateway({ operation: "snapshot" }, context);
  await gateway({ operation: "command", epoch: "epoch-1", requestId: "create-admin", command: {
    type: "join", form: { name: "管理员", studentNo: "20250001", classId: f.state().state.classes[0].id },
  } }, context);
  const plan = await gateway({ operation: "businessClearPreview" }, context) as import("../miniprogram/domain/business-clear").BusinessClearPreview;
  const results = await Promise.allSettled([1, 2].map(() => gateway({ operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }, context)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const jobId = f.state().businessClear!.id; now = 11000;
  const steps = await Promise.all([1, 2].map(() => gateway({ operation: "businessClearStep", jobId }, context))) as { waitMs: number }[];
  assert.ok(steps.some(s => s.waitMs > 0)); assert.deepEqual(deleted, ["old-photo"]);
  await gateway({ operation: "businessClearStep", jobId }, context);
  assert.equal(f.state().cleaning, false); assert.equal(f.state().state.actorId, "");
  assert.equal(f.state().state.classes.length, 0); assert.equal(f.state().state.members.length, 1);
});

test("正式业务照片清空仅扫描 production 前缀，不接受试用照片标识", async () => {
  const photos = postgresPhotos({
    async list(path) { assert.equal(path, "production/"); return { data: { folders: [], objects: [{ name: "trial/epoch/photo.jpg" }], hasNext: false }, error: null }; },
    async upload() { return { data: null, error: null }; },
    async remove() { throw new Error("must not delete"); }, async createSignedUrls() { return { data: [], error: null }; },
  }, "production");
  await assert.rejects(photos.listResetFiles(), /路径/);
  await assert.rejects(photos.deleteFiles(["pg://xuedu-photos/trial/epoch/photo.jpg"]), /路径/);
});
