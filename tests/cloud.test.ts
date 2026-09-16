import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, freshDocument, Document } from "../server/gateway";
import { createSeed } from "../miniprogram/domain/seed";
import { initialState } from "../server/policy";

function fixture(stage: "trial" | "production" = "trial") {
  let doc = freshDocument(stage, "epoch-1"), tail = Promise.resolve(), sequence = 0;
  const deleted: string[] = [];
  let failDelete = false;
  const gateway = createGateway({ stage, appid: "test-app", bootstrapOpenid: "owner",
    uuid: () => "uuid-" + ++sequence,
    async transact(fn) {
      let done!: () => void;
      const wait = tail;
      tail = new Promise<void>(r => { done = r; });
      await wait;
      try { const next = structuredClone(doc); const result = await fn(next); doc = next; return result; }
      finally { done(); }
    },
    async upload(path) { return "cloud://test/" + path; },
    async urls(ids) { return ids.map(id => "https://temporary.example/" + encodeURIComponent(id)); },
    async deleteFiles(ids) { if (failDelete) throw new Error("storage unavailable"); deleted.push(...ids); },
  });
  const call = (openid: string, event: any) => gateway(event, { OPENID: openid, APPID: "test-app" });
  const command = (openid: string, command: any, extra = {}) => call(openid, { operation: "command", requestId: "request-" + ++sequence, epoch: doc.epoch, command, ...extra });
  const join = (openid: string, studentNo: string) => command(openid, { type: "join", form: { name: openid, studentNo, classId: doc.state.classes[0]?.id } });
  return { call, command, join, gateway, deleted, state: () => doc, replace: (next: Document) => { doc = next; }, failDelete: (v: boolean) => { failDelete = v; } };
}

test("云端初始化不导入任何演示成员或记录，正式环境也不导入演示课表", () => {
  for (const stage of ["trial", "production"] as const) {
    const s = initialState(stage);
    for (const key of ["members", "applications", "records", "plans", "availability", "drafts"] as const) assert.equal(s[key].length, 0);
  }
  assert.equal(initialState("production").courses.length, 0);
  assert.equal(initialState("production").classes.length, 0);
});

test("只接受可信微信上下文，不接受客户端冒用管理员或伪造 AppID", async () => {
  const f = fixture();
  await assert.rejects(f.gateway({ operation: "snapshot", OPENID: "owner" }, {}), /微信身份/);
  await assert.rejects(f.gateway({ operation: "snapshot" }, { OPENID: "owner", APPID: "other-app" }), /AppID/);
  await f.join("applicant", "20261001");
  assert.equal(f.state().state.members.length, 0);
  await assert.rejects(f.command("applicant", { type: "generate", week: 1 }, { actorId: "admin-initial", role: "admin" }), /当前成员/);
  const view: any = await f.call("applicant", { operation: "snapshot" });
  assert.equal(view.state.courses.length, 0);
  assert.equal(view.state.applications.length, 1);
  assert.equal(view.state.applications[0].identityKey, "self");
});

test("管理员按允许的 OpenID 初始化；申请跨设备可见，审核后同一微信免重复加入", async () => {
  const f = fixture();
  await f.join("owner", "20260001");
  assert.equal(f.state().state.members[0].role, "admin");
  await f.join("applicant", "20261001");
  await f.join("second", "20261002");
  const manager: any = await f.call("owner", { operation: "snapshot" });
  assert.equal(manager.state.applications.filter((a: any) => a.status === "pending").length, 2);
  const id = f.state().state.applications.find(a => a.identityKey === "applicant")!.id;
  await f.command("owner", { type: "review", ids: [id], decision: "approved", reason: "" });
  const anotherPhone: any = await f.call("applicant", { operation: "snapshot" });
  assert.equal(anotherPhone.state.actorId, "member-" + id);
  assert.equal(anotherPhone.state.members.find((m: any) => m.identityKey === "self").role, "member");
  assert.ok(!JSON.stringify(anotherPhone.state).includes('"identityKey":"owner"'));
  assert.equal(anotherPhone.state.applications.length, 1);
});

test("并发审核不重复建人，重放同一请求不会重复操作", async () => {
  const f = fixture(); await f.join("owner", "20260001"); await f.join("applicant", "20261001");
  const id = f.state().state.applications.at(-1)!.id;
  const approve = { type: "review", ids: [id], decision: "approved", reason: "" };
  const results = await Promise.allSettled([f.command("owner", approve), f.command("owner", approve)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.state().state.members.length, 2);
  const c = { type: "role", id: "member-" + id, role: "leader" };
  await f.command("owner", c, { requestId: "same-request" });
  const version = f.state().version;
  await f.command("owner", c, { requestId: "same-request" });
  assert.equal(f.state().version, version);
});

test("照片只允许上传自己的待完成任务，文件绑定微信身份与任务，明细脱敏", async () => {
  const f = fixture(); const doc = f.state(); doc.state = createSeed();
  doc.state.members[0].identityKey = "applicant";
  doc.state.members[1].identityKey = "second";
  doc.state.members[7].identityKey = "owner";
  f.replace(doc);
  const task = doc.state.plans[0].tasks.find(t => t.memberId === "m0")!;
  const event = { operation: "photo", epoch: doc.epoch, taskId: task.id, base64: "/9j/AAAA" };
  await assert.rejects(f.call("second", event), /任务不可上传/);
  const file: any = await f.call("applicant", event);
  assert.ok(file.fileID.includes("/trial/epoch-1/"));
  assert.equal(f.state().files[0].owner, "applicant");
  const view: any = await f.call("second", { operation: "snapshot" });
  assert.equal(view.state.members.find((m: any) => m.id === "m0").studentNo, "");
  assert.equal(view.state.drafts.length, 0);
  await assert.rejects(f.call("second", { operation: "photoUrls", epoch: doc.epoch, recordId: "missing" }), /无权查看/);
});

test("清理需管理员和准确确认；试用清理删除照片、保留配置、作废旧客户端写入", async () => {
  const f = fixture(); await f.join("owner", "20260001"); await f.join("applicant", "20261001");
  f.state().files.push({ id: "cloud://test/trial/a", task: "task", owner: "applicant" });
  const beforeCourses = f.state().state.courses.length;
  const plan: any = await f.call("owner", { operation: "cleanupPreview" });
  await assert.rejects(f.call("applicant", { operation: "cleanup", ...plan, confirmation: "清空试用数据" }), /当前成员/);
  await assert.rejects(f.call("owner", { operation: "cleanup", ...plan, confirmation: "yes" }), /明确确认/);
  await assert.rejects(f.call("owner", { operation: "cleanup", ...plan, version: -1, confirmation: "清空试用数据" }), /数据已变化/);
  await f.call("owner", { operation: "cleanup", ...plan, confirmation: "清空试用数据" });
  assert.equal(f.state().state.members.length, 1);
  assert.equal(f.state().state.applications.length, 0);
  assert.equal(f.state().state.courses.length, beforeCourses);
  assert.deepEqual(f.deleted, ["cloud://test/trial/a"]);
  await assert.rejects(f.command("owner", { type: "generate", week: 1 }, { epoch: plan.epoch }), /已重置/);
});

test("清理照片失败时保留清单并冻结写入，管理员重进后可以重试", async () => {
  const f = fixture(); await f.join("owner", "20260001");
  f.state().files.push({ id: "cloud://trial/a", task: "task", owner: "owner" });
  const plan: any = await f.call("owner", { operation: "cleanupPreview" });
  f.failDelete(true);
  await assert.rejects(f.call("owner", { operation: "cleanup", ...plan, confirmation: "清空试用数据" }), /storage/);
  assert.equal(f.state().files.length, 1);
  await assert.rejects(f.join("applicant", "20261001"), /正在清理/);
  await f.call("owner", { operation: "snapshot" });
  f.failDelete(false);
  const retry: any = await f.call("owner", { operation: "cleanupPreview" });
  await f.call("owner", { operation: "cleanup", ...retry, confirmation: "清空试用数据" });
  assert.equal(f.state().cleaning, false);
});

test("正式环境硬性禁止试用清理，客户端不能通过传 stage 改变目标", async () => {
  const f = fixture("production");
  await assert.rejects(f.call("owner", { operation: "cleanup", stage: "trial", confirmation: "清空试用数据" }), /仅允许/);
  const data: any = await f.call("owner", { operation: "snapshot", stage: "trial" });
  assert.equal(data.stage, "production");
  assert.equal(f.deleted.length, 0);
});
