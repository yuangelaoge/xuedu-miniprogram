import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, freshDocument, Document } from "../server/gateway";
import { createSeed } from "../miniprogram/domain/seed";
import { initialState } from "../server/policy";

function fixture(stage: "trial" | "production" = "trial") {
  let doc = freshDocument(stage, "epoch-1"), tail = Promise.resolve(), sequence = 0;
  const deleted: string[] = [];
  let failDelete = false;
  let clock = 0, failList = false;
  const photos = new Set<string>();
  const gateway = createGateway({ stage, appid: "test-app", bootstrapOpenid: "owner",
    uuid: () => "uuid-" + ++sequence,
    now: () => clock,
    async listResetFiles() { if (failList) throw new Error("list unavailable"); return [...photos].slice(0, 20); },
    async transact(fn) {
      let done!: () => void;
      const wait = tail;
      tail = new Promise<void>(r => { done = r; });
      await wait;
      try { const next = structuredClone(doc); const result = await fn(next); doc = next; return result; }
      finally { done(); }
    },
    async upload(path) { const id = "cloud://test/" + path; photos.add(id); return id; },
    async urls(ids) { return ids.map(id => "https://temporary.example/" + encodeURIComponent(id)); },
    async deleteFiles(ids) { if (failDelete) throw new Error("storage unavailable"); deleted.push(...ids); ids.forEach(id => photos.delete(id)); },
  });
  const call = (openid: string, event: any) => gateway(event, { OPENID: openid, APPID: "test-app" });
  const command = (openid: string, command: any, extra = {}) => call(openid, { operation: "command", requestId: "request-" + ++sequence, epoch: doc.epoch, command, ...extra });
  const join = (openid: string, studentNo: string) => command(openid, { type: "join", form: { name: openid, studentNo, classId: doc.state.classes[0]?.id } });
  return { call, command, join, gateway, deleted, photos, advance: () => { clock += 11000; }, failList: (v: boolean) => { failList = v; }, state: () => doc, replace: (next: Document) => { doc = next; }, failDelete: (v: boolean) => { failDelete = v; } };
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

test("首位管理员可补充真实试用班级，重复调用不覆盖，创建管理员后关闭", async () => {
  const f = fixture();
  const event = { operation: "bootstrapClass", epoch: "epoch-1", schoolClass: { grade: "25", major: "自动化", name: "25自动化" } };
  await assert.rejects(f.call("other", { ...event, OPENID: "owner" }), /无权/);
  await assert.rejects(f.call("owner", { ...event, epoch: "old" }), /已重置/);
  await assert.rejects(f.call("owner", { ...event, schoolClass: { ...event.schoolClass, grade: "99" } }), /班级资料无效/);
  const first: any = await f.call("owner", event);
  assert.equal(first.created, true);
  const version = f.state().version;
  const second: any = await f.call("owner", event);
  assert.equal(second.classId, first.classId);
  assert.equal(second.created, false);
  assert.equal(f.state().version, version);
  assert.equal(f.state().state.members.length, 0);
  await assert.rejects(f.call("owner", { ...event, schoolClass: { ...event.schoolClass, major: "other" } }), /专业不一致/);
  f.state().cleaning = true;
  await assert.rejects(f.call("owner", event), /正在清理/);
  f.state().cleaning = false;
  await f.command("owner", { type: "join", form: { name: "测试管理员", studentNo: "20250001", classId: first.classId } });
  assert.equal(f.state().state.members[0].classId, first.classId);
  await assert.rejects(f.call("owner", event), /管理员已创建/);
  await assert.rejects(fixture("production").call("owner", event), /无权/);
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

test("管理员修正无课程的新班级名称保持身份引用，不允许成员或历史班级修改", async () => {
  const f = fixture();
  const c: any = await f.call("owner", { operation: "bootstrapClass", epoch: "epoch-1", schoolClass: { grade: "25", major: "自动化", name: "25自动化" } });
  await f.command("owner", { type: "join", form: { name: "测试管理员", studentNo: "20250001", classId: c.classId } });
  await assert.rejects(f.command("other", { type: "renameUnusedClass", id: c.classId, name: "25自动化3班" }), /当前成员/);
  await f.command("owner", { type: "renameUnusedClass", id: c.classId, name: "25自动化3班" });
  assert.equal(f.state().state.classes.find(x => x.id === c.classId)?.name, "25自动化3班");
  assert.equal(f.state().state.members[0].classId, c.classId);
  const used = f.state().state.courses[0].classIds[0];
  await assert.rejects(f.command("owner", { type: "renameUnusedClass", id: used, name: "new" }), /已有课程/);
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

test("彻底重置需初始化微信与准确确认，冻结写入并清空全部业务含管理员和未登记照片", async () => {
  const f = fixture(); await f.join("owner", "20250001"); await f.join("other", "20250002");
  f.photos.add("registered-photo"); f.photos.add("orphan-photo");
  f.state().files.push({ id: "registered-photo", owner: "owner", task: "old" });
  await assert.rejects(f.call("other", { operation: "resetAllPreview" }), /初始化微信/);
  const plan: any = await f.call("owner", { operation: "resetAllPreview" });
  await assert.rejects(f.call("owner", { operation: "resetAllBegin", ...plan, confirmation: "yes" }), /确认文字/);
  await assert.rejects(f.call("owner", { operation: "resetAllBegin", ...plan, version: -1, confirmation: "清空全部业务数据" }), /数据已变化/);
  assert.equal(f.state().cleaning, undefined);
  const start: any = await f.call("owner", { operation: "resetAllBegin", ...plan, confirmation: "清空全部业务数据" });
  assert.ok((await f.call("owner", { operation: "resetAllStep", ...start }) as any).waitMs > 0);
  await assert.rejects(f.command("owner", { type: "generate", week: 2 }), /正在清理/);
  const current: any = await f.call("owner", { operation: "resetAllPreview" });
  await assert.rejects(f.call("owner", { operation: "cleanup", ...current, confirmation: "清空试用数据" }), /不能切换/);
  f.advance();
  f.failDelete(true);
  await assert.rejects(f.call("owner", { operation: "resetAllStep", ...start }), /storage/);
  assert.equal(f.state().state.members.length, 1);
  f.failDelete(false);
  assert.equal((await f.call("owner", { operation: "resetAllStep", ...start }) as any).done, false);
  f.failList(true);
  await assert.rejects(f.call("owner", { operation: "resetAllStep", ...start }), /list/);
  assert.equal(f.state().cleaning, true);
  f.failList(false);
  const done: any = await f.call("owner", { operation: "resetAllStep", ...start });
  assert.equal(done.done, true);
  for (const value of Object.values(f.state().state)) if (Array.isArray(value)) assert.equal(value.length, 0);
  assert.equal(f.state().state.activeSemesterId, "");
  assert.equal(f.state().files.length, 0); assert.equal(f.state().receipts.length, 0);
  assert.notEqual(f.state().epoch, plan.epoch);
  assert.equal(f.photos.size, 0); assert.equal(f.deleted.length, 2);
  assert.equal((await f.call("owner", { operation: "resetAllStep", ...start }) as any).done, true);
  await assert.rejects(f.command("owner", { type: "join", form: { name: "old", studentNo: "20250001", classId: "old" } }, { epoch: plan.epoch }), /已重置/);
});

test("彻底重置后仅原微信可建立真实空白学期与班级并重新成为管理员，不恢复演示数据", async () => {
  const f = fixture(); await f.join("owner", "20250001");
  const plan: any = await f.call("owner", { operation: "resetAllPreview" });
  const start: any = await f.call("owner", { operation: "resetAllBegin", ...plan, confirmation: "清空全部业务数据" });
  f.advance(); await f.call("owner", { operation: "resetAllStep", ...start });
  const event = { operation: "bootstrapWorkspace", epoch: f.state().epoch,
    semester: { id: "new", name: "真实学期", startDate: "2026-09-07", weeks: 20, grades: ["25"], days: 5, periods: 14, edition: "学督" },
    schoolClass: { grade: "25", major: "自动化", name: "25自动化3班" } };
  await assert.rejects(f.call("other", event), /无权/);
  await assert.rejects(f.call("owner", { ...event, semester: { ...event.semester, startDate: "2026-09-08" } }), /周一/);
  assert.equal(f.state().state.semesters.length, 0);
  await f.call("owner", event);
  assert.equal(f.state().state.courses.length, 0);
  assert.equal(f.state().state.members.length, 0);
  await f.join("owner", "20250001");
  assert.equal(f.state().state.members[0].role, "admin");
  await assert.rejects(f.call("owner", event), /不是空白/);
  await assert.rejects(fixture("production").call("owner", { operation: "resetAllPreview" }), /仅限试用/);
});

test("换届清空不按年份：保留所有管理员身份，清空全部年度业务和照片，旧请求失效", async () => {
  const f = fixture();
  f.state().state = createSeed();
  const admin = f.state().state.members.find(m => m.role === "admin")!;
  admin.identityKey = "owner";
  f.state().state.members.push({ ...admin, id: "second-admin", identityKey: "other-admin", studentNo: "20259999", active: false });
  const admins = structuredClone(f.state().state.members.filter(m => m.role === "admin"));
  f.photos.add("registered"); f.photos.add("orphan-from-old-year");
  f.state().files.push({ id: "registered", task: "task", owner: "owner" });
  const plan = await f.call("owner", { operation: "businessClearPreview" }) as import("../miniprogram/domain/business-clear").BusinessClearPreview;
  assert.equal(plan.administrators, 2); assert.ok(plan.members > 0);
  assert.equal(f.deleted.length, 0); assert.equal(f.state().cleaning, undefined);
  await assert.rejects(f.call("owner", { operation: "businessClearBegin", ...plan, confirmation: "清空试用数据" }), /确认文字/);
  await assert.rejects(f.call("owner", { operation: "businessClearBegin", ...plan, version: -1, confirmation: "清空业务数据，保留管理员" }), /数据已变化/);
  const start = await f.call("owner", { operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }) as { jobId: string };
  assert.ok((await f.call("owner", { operation: "businessClearStep", ...start }) as { waitMs: number }).waitMs > 0);
  await assert.rejects(f.command("owner", { type: "generate", week: 1 }), /正在清理/);
  await assert.rejects(f.call("owner", { operation: "cleanup", ...plan, confirmation: "清空试用数据" }), /不能切换/);
  await assert.rejects(f.call("owner", { operation: "resetAllBegin", epoch: f.state().epoch, version: f.state().version, confirmation: "清空全部业务数据" }), /先完成/);
  f.advance();
  await f.call("owner", { operation: "businessClearStep", ...start });
  const done = await f.call("owner", { operation: "businessClearStep", ...start }) as { done: boolean; snapshot: { state: import("../miniprogram/domain/types").AppState } };
  assert.equal(done.done, true);
  assert.equal(done.snapshot.state.actorId, admin.id);
  assert.deepEqual(f.state().state.members, admins.map(m => ({ ...m, classId: "" })));
  for (const key of ["semesters", "classes", "courses", "records", "applications", "availability", "plans", "drafts"] as const) assert.equal(f.state().state[key].length, 0, key);
  assert.equal(f.state().state.audit.length, 1);
  assert.equal(f.state().state.audit[0].action, "清空业务数据");
  assert.equal(f.state().state.activeSemesterId, "");
  assert.equal(f.photos.size, 0); assert.equal(f.state().files.length, 0); assert.equal(f.state().receipts.length, 0);
  assert.notEqual(f.state().epoch, plan.epoch);
  const version = f.state().version;
  assert.equal((await f.call("owner", { operation: "businessClearStep", ...start }) as { done: boolean }).done, true);
  assert.equal(f.state().version, version, "响应丢失后的重试不再次清空");
  await assert.rejects(f.command("owner", { type: "generate", week: 1 }, { epoch: plan.epoch }), /已重置/);
  await assert.rejects(f.call("other-admin", { operation: "businessClearPreview" }), /当前成员/);
});

test("换届清空仅管理员可用，正式环境也支持但不能通过客户端切换环境", async () => {
  const f = fixture("production"); f.state().state = createSeed();
  f.state().state.members.forEach(m => { m.identityKey = m.id; });
  const admin = f.state().state.members.find(m => m.role === "admin")!;
  for (const m of f.state().state.members.filter(m => m.role !== "admin")) {
    for (const operation of ["businessClearPreview", "businessClearBegin", "businessClearStep"]) {
      await assert.rejects(f.call(m.id, { operation, role: "admin", actorId: admin.id }), /无权/);
    }
  }
  const plan = await f.call(admin.id, { operation: "businessClearPreview", stage: "trial" }) as import("../miniprogram/domain/business-clear").BusinessClearPreview;
  assert.equal(plan.stage, "production");
  const start = await f.call(admin.id, { operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }) as { jobId: string };
  f.advance(); await f.call(admin.id, { operation: "businessClearStep", ...start });
  assert.equal(f.state().stage, "production"); assert.equal(f.state().state.members[0].id, admin.id);
});

test("换届照片清理分批、失败冻结可恢复，并发步骤不重复扫目录", async () => {
  const f = fixture(); await f.join("owner", "20250001");
  for (let i = 0; i < 43; i++) f.photos.add("photo-" + i);
  let plan = await f.call("owner", { operation: "businessClearPreview" }) as import("../miniprogram/domain/business-clear").BusinessClearPreview;
  const start = await f.call("owner", { operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }) as { jobId: string };
  f.advance(); f.failDelete(true);
  await assert.rejects(f.call("owner", { operation: "businessClearStep", ...start }), /storage/);
  assert.equal(f.state().cleaning, true); assert.equal(f.state().state.semesters.length, 1);
  f.failDelete(false); f.failList(true);
  await assert.rejects(f.call("owner", { operation: "businessClearStep", ...start }), /list/);
  assert.equal(f.state().businessClear?.lease, undefined);
  f.failList(false);
  plan = await f.call("owner", { operation: "businessClearPreview" }) as import("../miniprogram/domain/business-clear").BusinessClearPreview;
  assert.equal(plan.jobId, start.jobId);
  assert.deepEqual(await f.call("owner", { operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }), start);
  const steps = await Promise.all([f.call("owner", { operation: "businessClearStep", ...start }), f.call("owner", { operation: "businessClearStep", ...start })]) as { waitMs: number }[];
  assert.ok(steps.some(s => s.waitMs > 0)); assert.equal(f.photos.size, 23);
  await f.call("owner", { operation: "businessClearStep", ...start }); assert.equal(f.photos.size, 3);
  await f.call("owner", { operation: "businessClearStep", ...start }); assert.equal(f.photos.size, 0);
  assert.equal(f.state().cleaning, true, "删除后须再核查目录为空");
  await f.call("owner", { operation: "businessClearStep", ...start }); assert.equal(f.state().cleaning, false);
});

test("清空后管理员可重建学期和课表，恢复本人班级前不可听课，原成员需重新申请", async () => {
  const f = fixture(); await f.join("owner", "20250001"); await f.join("applicant", "20250002");
  const id = f.state().state.applications.at(-1)!.id;
  await f.command("owner", { type: "review", ids: [id], decision: "approved", reason: "" });
  const semester = { ...f.state().state.semesters[0], id: "new-semester" };
  const plan = await f.call("owner", { operation: "businessClearPreview" }) as import("../miniprogram/domain/business-clear").BusinessClearPreview;
  const start = await f.call("owner", { operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }) as { jobId: string };
  f.advance(); await f.call("owner", { operation: "businessClearStep", ...start });
  await f.command("owner", { type: "createSemester", value: semester });
  const av = { semesterId: semester.id, memberId: "admin-initial", week: 1, slots: ["1:1"], note: "", optedIn: true, updatedAt: "" };
  await assert.rejects(f.command("owner", { type: "availability", value: av }), /真实班级/);
  const c = { id: "new-class", grade: semester.grades[0], major: "真实专业", name: "真实班级" };
  const course = { id: "new-course", semesterId: semester.id, name: "真实课程", teacher: "教师", nature: "必修", classIds: [c.id], classroom: "101", weekday: 1, start: 1, end: 1, weeks: [1], expected: 40 };
  await f.command("owner", { type: "import", text: JSON.stringify({ classes: [c], courses: [course] }) });
  await assert.rejects(f.command("owner", { type: "restoreAdminClass", classId: "missing" }), /真实班级/);
  await assert.rejects(f.command("applicant", { type: "restoreAdminClass", classId: c.id }), /当前成员/);
  await f.command("owner", { type: "restoreAdminClass", classId: c.id });
  await assert.rejects(f.command("owner", { type: "restoreAdminClass", classId: c.id }), /已设置/);
  await f.command("owner", { type: "availability", value: av });
  await f.command("owner", { type: "generate", week: 1 });
  assert.equal(f.state().state.drafts[0].tasks.length, 0, "恢复后仍不能听自己的班级");
  await f.join("applicant", "20250002");
  assert.equal(f.state().state.applications[0].status, "pending");
  assert.equal(f.state().state.members.length, 1);
});

test("换届清空任务超时后可重新领取步骤，旧任务及旧 epoch 不得继续操作", async () => {
  const f = fixture(); await f.join("owner", "20250001");
  const plan = await f.call("owner", { operation: "businessClearPreview" }) as import("../miniprogram/domain/business-clear").BusinessClearPreview;
  const start = await f.call("owner", { operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }) as { jobId: string };
  f.state().businessClear!.lease = { token: "timed-out-worker", until: 10000 };
  assert.ok((await f.call("owner", { operation: "businessClearStep", ...start }) as { waitMs: number }).waitMs > 0);
  await assert.rejects(f.call("owner", { operation: "businessClearStep", jobId: "different" }), /任务不存在/);
  await assert.rejects(f.call("owner", { operation: "businessClearStep" }), /标识/);
  f.photos.add("late-in-flight-photo"); f.advance();
  await f.call("owner", { operation: "businessClearStep", ...start });
  assert.equal(f.photos.size, 0);
  await f.call("owner", { operation: "businessClearStep", ...start });
  await assert.rejects(f.call("owner", { operation: "businessClearBegin", ...plan, confirmation: "清空业务数据，保留管理员" }), /数据已变化/);
});

test("不支持目录核查的后端拒绝换届清空，不冻结或删除任何业务", async () => {
  const doc = freshDocument("trial", "epoch"); let touched = false;
  const gateway = createGateway({ stage: "trial", appid: "app", bootstrapOpenid: "owner", uuid: () => "id",
    async transact(fn) { touched = true; return fn(doc); }, async upload() { return "unused"; }, async urls() { return []; }, async deleteFiles() { touched = true; },
  });
  for (const operation of ["businessClearPreview", "businessClearBegin", "businessClearStep"]) {
    await assert.rejects(gateway({ operation }, { OPENID: "owner", APPID: "app" }), /不支持完整照片核查/);
  }
  assert.equal(touched, false);
});
