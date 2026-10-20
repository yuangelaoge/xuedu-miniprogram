import test from "node:test";
import assert from "node:assert/strict";
import { exportTxt, reportSheets } from "../miniprogram/domain/reports";
import { createGatewayV2 } from "../server/v2/gateway";
import { EMPTY_WORKSPACE, MemoryRepository } from "../server/v2/memory";
import { ApiRequest, CLEAR_CONFIRMATION, Entity, Resource } from "../miniprogram/domain/v2/protocol";

const initialTime = Date.parse("2026-09-14T04:00:00Z");
const metrics = { expected: 30, actual: 29, late: 0, early: 0, sleep: 0, phone: 0, talk: 0, other: 0 };
const row = (id: string, data: Record<string, unknown>, extra: Partial<Entity> = {}): Entity => ({ id, epoch: "epoch1", version: 1, data, ...extra });
function fixture(extra: Partial<Record<Resource, Entity[]>> = {}, blank = false) {
  const course = { id: "course1", semesterId: "s1", name: "数学", teacher: "老师", nature: "必修", classIds: ["c2"], classroom: "101", weekday: 1, start: 1, end: 2, weeks: [2], expected: 30 };
  const seed: Partial<Record<Resource, Entity[]>> = blank ? {} : {
    classes: [row("c1", { name: "25自动化3班", grade: "25", major: "自动化", active: true }), row("c2", { name: "25计科1班", grade: "25", major: "计科", active: true })],
    members: [row("admin", { name: "管理员", studentNo: "001", classId: "c1", role: "admin", active: true }, { studentNo: "001" }), row("member", { name: "成员", studentNo: "002", classId: "c1", role: "member", active: true }, { studentNo: "002" })],
    bindings: [row("ba", {}, { identityKey: "oa", memberId: "admin" }), row("bm", {}, { identityKey: "om", memberId: "member" })],
    semesters: [row("s1", { name: "2026秋", startDate: "2026-09-07", weeks: 20, days: 7, periods: 14, edition: "", grades: ["25"], status: "active" })],
    semester_classes: [row("sc1", {}, { semesterId: "s1", parentId: "c1" }), row("sc2", {}, { semesterId: "s1", parentId: "c2" })],
    courses: [row("course1", { name: "数学", course, active: true }, { semesterId: "s1" })],
    course_versions: [row("cv1", { course, active: true, sequence: 1 }, { parentId: "course1", semesterId: "s1", date: "2026-09-07" })],
    occurrences: [row("course1:2026-09-14", { course, classes: [{ id: "c2", name: "25计科1班", grade: "25", major: "计科" }], classLabel: "25计科1班", status: "active", originalDate: "2026-09-14" }, { semesterId: "s1", week: 2, parentId: "course1", date: "2026-09-14" })],
    tasks: [row("t1", { occurrenceId: "course1:2026-09-14", course, classes: [{ id: "c2", name: "25计科1班", grade: "25", major: "计科" }], classLabel: "25计科1班", memberName: "成员", memberId: "member", date: "2026-09-14", status: "confirmed" }, { semesterId: "s1", week: 2, memberId: "member", parentId: "plan1" })],
    availability: [row("av1", { slots: ["1:1", "1:2", "2:1", "2:2"], optedIn: false }, { semesterId: "s1", week: 2, memberId: "member" })],
    photos: [row("p1", { storageId: "pg://xuedu-photos/cloud/epoch1/p1.jpg", path: "cloud/epoch1/p1.jpg" }, { semesterId: "s1", memberId: "member", taskId: "t1" })],
  };
  for (const [r, rows] of Object.entries(extra)) seed[r as Resource] = rows;
  const repository = new MemoryRepository(blank ? { ...EMPTY_WORKSPACE } : { ...EMPTY_WORKSPACE, epoch: "epoch1", version: 1, activeSemesterId: "s1", maxExecutionMs: 3000 }, seed);
  let timestamp = initialTime, sequence = 100;
  const files = new Set<string>(); const deleted: string[] = []; let failDelete = false;
  const queries: { resource: Resource; query: unknown }[] = [];
  const rawQuery = repository.query.bind(repository); repository.query = async (resource, query) => { queries.push({ resource, query }); return rawQuery(resource, query); };
  const api = createGatewayV2({ repository, appid: "app", bootstrapOpenid: "oa", now: () => timestamp, uuid: () => "id" + ++sequence, maxExecutionMs: 3000,
    photos: { upload: async path => { const id = "pg://xuedu-photos/" + path; files.add(id); return id; }, urls: async ids => ids.map(id => "https://private.example/" + id), list: async (prefix, limit) => [...files].filter(f => f.includes("/" + prefix)).slice(0, limit), delete: async ids => { if (failDelete) throw new Error("storage unavailable"); ids.forEach(id => { files.delete(id); deleted.push(id); }); } } });
  const call = async (operation: string, payload: Record<string, unknown> = {}, options: Partial<ApiRequest> & { who?: string } = {}) => {
    const w = await repository.workspace(); const { who, ...rest } = options;
    return api({ protocolVersion: 2, operation, epoch: w.epoch, semesterId: "s1", requestId: "req" + ++sequence, payload, ...rest }, { OPENID: who || "oa", APPID: "app" });
  };
  return { repository, call, api, queries, files, deleted, time: (n: number) => timestamp = n, failDelete: (value: boolean) => failDelete = value };
}
async function submit(f: ReturnType<typeof fixture>) {
  const response = await f.call("command", { type: "recordSubmit", taskId: "t1", metrics, photos: ["p1"] }, { who: "om", expectedVersion: 1 });
  return (response.data.changed as Entity[]).find(e => e.taskId === "t1" && e.data.firstSubmittedAt)!;
}

test("V2 rejects legacy protocol, context spoofing; blank bootstrap has no demo data and only specified initialization", async () => {
  const f = fixture({}, true);
  await assert.rejects(f.api({ protocolVersion: 1 } as any, { OPENID: "oa", APPID: "app" }), /请更新/);
  await assert.rejects(f.api({ protocolVersion: 2, operation: "bootstrap" }, { OPENID: "oa", APPID: "other" }), /微信身份/);
  assert.equal((await f.call("bootstrap")).data.status, "needsAdministrator");
  assert.equal((await f.repository.query("classes", {})).items.length, 0);
  const payload = { semester: { name: "真实秋季", startDate: "2026-09-07", weeks: 20 }, schoolClass: { name: "25自动化3班", major: "自动化", grade: "25" }, member: { name: "本人", studentNo: "001" } };
  await assert.rejects(f.call("initialize", payload, { who: "other" }), /指定初始化/);
  const results = await Promise.allSettled([f.call("initialize", payload), f.call("initialize", payload)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await f.repository.query("members", {})).items.length, 1);
  assert.equal((await f.call("bootstrap")).data.status, "ready");
});

test("V2 administrator appointment and simultaneous resignation preserve a valid administrator", async () => {
  const f = fixture();
  await assert.rejects(f.call("command", { type: "roleChange", id: "admin", role: "member", confirmed: true, reason: "卸任" }, { expectedVersion: 1 }), /至少一名/);
  await assert.rejects(f.call("command", { type: "roleChange", id: "member", role: "admin", confirmed: true, reason: "越权" }, { expectedVersion: 1, who: "om" }), /仅管理员/);
  await f.call("command", { type: "roleChange", id: "member", role: "admin", confirmed: true, reason: "交接" }, { expectedVersion: 1 });
  const results = await Promise.allSettled([
    f.call("command", { type: "roleChange", id: "admin", role: "member", confirmed: true, reason: "卸任" }, { expectedVersion: 1 }),
    f.call("command", { type: "roleChange", id: "member", role: "member", confirmed: true, reason: "卸任" }, { expectedVersion: 2, who: "om" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await f.repository.query("members", {})).items.filter(r => r.data.role === "admin" && r.data.active).length, 1);
});

test("V2 restored members retain IDs, cancelled tasks stay cancelled; rebind requires administrator and instantly invalidates old identity", async () => {
  const f = fixture();
  await f.call("command", { type: "memberRemove", id: "member", reason: "离组" }, { expectedVersion: 1 });
  await f.call("command", { type: "memberRestore", id: "member", reason: "重新入组" }, { expectedVersion: 2 });
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "cancelled");
  assert.equal((await f.repository.get("members", "member"))!.data.active, true);
  const applied = await f.call("command", { type: "rebindRequest", studentNo: "002", reason: "微信更换，等待线下核实" }, { who: "new" });
  const request = (applied.data.changed as Entity[])[0];
  await assert.rejects(f.call("command", { type: "rebindConfirm", id: request.id, confirmed: true, reason: "自行认领" }, { expectedVersion: 1, who: "new" }), /通过审核/);
  await f.call("command", { type: "rebindConfirm", id: request.id, confirmed: true, reason: "已线下核实" }, { expectedVersion: 1 });
  assert.equal((await f.call("bootstrap", {}, { who: "om" })).data.member, null);
  assert.equal(((await f.call("bootstrap", {}, { who: "new" })).data.member as Entity).id, "member");
});

test("V2 record strict 24h boundary, forged timestamps, own-only editing, immutable first submission and historical photos", async () => {
  const f = fixture(); const record = await submit(f);
  f.time(initialTime + 86399000);
  await f.call("command", { type: "recordEdit", id: record.id, reason: "核对人数", metrics: { ...metrics, actual: 28 }, photos: ["p1"] }, { expectedVersion: 1, who: "om" });
  f.time(initialTime + 86400000);
  await assert.rejects(f.call("command", { type: "recordEdit", id: record.id, reason: "超时", metrics, photos: ["p1"] }, { expectedVersion: 2, who: "om" }), /满24小时/);
  await assert.rejects(f.call("command", { type: "recordEdit", id: record.id, firstSubmittedAt: new Date(initialTime).toISOString(), reason: "伪造", metrics, photos: ["p1"] }, { expectedVersion: 2 }), /不能修改/);
  const uploaded = await f.call("photo", { taskId: "t1", base64: "aGVsbG8=" });
  const photoId = uploaded.data.photoId as string;
  await f.call("command", { type: "recordEdit", id: record.id, reason: "管理员核验", metrics, photos: [photoId] }, { expectedVersion: 2 });
  const latest = (await f.repository.get("records", record.id))!;
  assert.equal(latest.data.firstSubmittedAt, new Date(initialTime).toISOString());
  assert.deepEqual(latest.data.photos, [photoId]);
  assert.ok(await f.repository.get("photos", "p1"));
  const history = await f.call("query", { kind: "recordVersions", id: record.id }, { who: "om" });
  assert.equal((history.data.items as Entity[]).length, 3);
  const urls = await f.call("photoUrls", { recordId: record.id, versionId: (history.data.items as Entity[])[0].id }, { who: "om" });
  assert.equal((urls.data.urls as string[]).length, 1);
  await assert.rejects(f.call("command", { type: "recordEdit", id: record.id, reason: "覆盖", metrics, photos: [photoId] }, { expectedVersion: 2 }), /刷新/);
});

test("V2 same-request replay remains idempotent after task is submitted; record edits race safely", async () => {
  const f = fixture(); const payload = { type: "recordSubmit", taskId: "t1", metrics, photos: ["p1"] };
  const first = await f.call("command", payload, { who: "om", expectedVersion: 1, requestId: "same" });
  const retry = await f.call("command", payload, { who: "om", expectedVersion: 1, requestId: "same" });
  assert.deepEqual(retry.data, first.data);
  const record = (first.data.changed as Entity[]).find(e => e.data.firstSubmittedAt)!;
  const edits = await Promise.allSettled([1, 2].map(i => f.call("command", { type: "recordEdit", id: record.id, reason: "并发核对" + i, metrics, photos: ["p1"] }, { who: "om", expectedVersion: 1 })));
  assert.equal(edits.filter(e => e.status === "fulfilled").length, 1);
});

test("V2 historical viewing and draft semester creation do not activate organization semester; report version detects edits", async () => {
  const f = fixture(); await submit(f);
  const created = await f.call("command", { type: "semesterCreate", name: "2027春", startDate: "2027-03-01", weeks: 20 });
  const semester = (created.data.changed as Entity[]).find(e => e.data.name === "2027春")!;
  assert.equal((await f.repository.workspace()).activeSemesterId, "s1");
  await f.call("query", { kind: "records" }, { semesterId: semester.id });
  assert.equal((await f.repository.workspace()).activeSemesterId, "s1");
  const report = await f.call("query", { kind: "report", week: 2 });
  assert.equal((report.data.state as any).records.length, 1);
  assert.match(exportTxt(report.data.state as any, 2), /25计科1班/);
  assert.ok(reportSheets(report.data.state as any, 2).length > 0);
  await f.call("command", { type: "semesterActivate", id: semester.id, confirmed: true, reason: "新学期启用" }, { semesterId: semester.id, expectedVersion: 1 });
  await assert.rejects(f.call("query", { kind: "reportCheck", version: report.data.version }), /重新生成/);
  assert.equal((await f.repository.get("tasks", "t1"))!.semesterId, "s1");
});

test("V2 move/cancel classes use dated occurrences, block stale submission and only replace after manual confirmation", async () => {
  const f = fixture();
  const changed = await f.call("command", { type: "exceptionSave", courseId: "course1", date: "2026-09-14", kind: "move", newDate: "2026-09-15", start: 1, end: 2, classroom: "202", reason: "调休" }, { expectedVersion: 1 });
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "pendingAdjustment");
  await assert.rejects(f.call("command", { type: "recordSubmit", taskId: "t1", metrics, photos: ["p1"] }, { expectedVersion: 2, who: "om" }), /待调整/);
  const plan = (changed.data.changed as Entity[]).find(e => e.data.status === "draft" && !e.data.occurrenceId)!;
  assert.ok(plan);
  await f.call("command", { type: "planConfirm", id: plan.id }, { expectedVersion: 1 });
  const tasks = (await f.repository.query("tasks", { eq: { semesterId: "s1", week: 2 } })).items;
  assert.equal(tasks.find(t => t.id === "t1")!.data.status, "cancelled");
  const active = tasks.find(t => t.data.status === "confirmed")!;
  assert.equal(active.data.date, "2026-09-15");
  assert.equal((active.data.course as any).weekday, 2);
});

test("V2 generation loads only target week/previous-week records; completed tasks remain and count towards weekly limit", async () => {
  const f = fixture(); await submit(f); f.queries.length = 0;
  const generated = await f.call("command", { type: "planGenerate", week: 2 }, { expectedVersion: 0 });
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "submitted");
  assert.ok(f.queries.filter(q => q.resource === "records").every(q => (q.query as any).eq.week === 1));
  const plan = (generated.data.changed as Entity[]).find(e => e.data.status === "draft")!;
  await f.call("command", { type: "planConfirm", id: plan.id }, { expectedVersion: 1 });
  await assert.rejects(f.call("command", { type: "taskAdjust", week: 2, reason: "补排", changes: [{ memberId: "member", occurrenceId: "course1:2026-09-14" }] }, { expectedVersion: 2 }), /每人每周/);
  await assert.rejects(f.call("command", { type: "taskAdjust", week: 2, reason: "已完成不能取消", changes: [{ taskId: "t1", cancel: true }] }, { expectedVersion: 2 }), /未提交/);
});

test("V2 clear preserves all admins including disabled and shared class, resumes storage failure, fixes epoch scope", async () => {
  const f = fixture({ members: [row("admin", { name: "管理员", studentNo: "001", classId: "c1", role: "admin", active: true }, { studentNo: "001" }), row("disabled", { name: "停用管理员", studentNo: "003", classId: "c1", role: "admin", active: false }, { studentNo: "003" }), row("member", { name: "成员", studentNo: "002", classId: "c2", role: "member", active: true }, { studentNo: "002" })] });
  f.files.add("pg://xuedu-photos/cloud/epoch1/orphan.jpg"); f.files.add("pg://xuedu-photos/cloud/future/keep.jpg");
  const preview = await f.call("clearPreview"); assert.equal(preview.data.administrators, 2); assert.equal(preview.data.retainedClasses, 1); assert.equal(preview.data.deletedClasses, 1);
  await assert.rejects(f.call("clearBegin", { confirmation: "清空业务数据，保留管理员" }, { expectedVersion: preview.data.version as number }), /确认文字/);
  const begin = await f.call("clearBegin", { confirmation: CLEAR_CONFIRMATION }, { expectedVersion: preview.data.version as number }); const jobId = begin.data.jobId;
  await assert.rejects(f.call("command", { type: "classSave", name: "不应写入", grade: "26", major: "计科" }), /正在维护/);
  assert.ok(Number((await f.call("clearStep", { jobId })).data.waitMs) > 0);
  f.time(initialTime + 4001); f.failDelete(true);
  await assert.rejects(f.call("clearStep", { jobId }), /storage unavailable/);
  f.failDelete(false); f.time(initialTime + 8002);
  for (let i = 0; i < 30; i++) { const result = await f.call("clearStep", { jobId }); if (result.data.done) break; }
  const w = await f.repository.workspace(); assert.notEqual(w.epoch, "epoch1"); assert.equal(w.activeSemesterId, ""); assert.equal(w.maintenance, "");
  const admins = (await f.repository.query("members", {})).items; assert.equal(admins.length, 2); assert.equal(admins.find(a => a.id === "disabled")!.data.active, false); assert.ok(admins.every(a => a.data.classId === "c1"));
  assert.equal((await f.repository.query("classes", {})).items.length, 1); assert.equal((await f.repository.query("semesters", {})).items.length, 0);
  assert.ok(f.files.has("pg://xuedu-photos/cloud/future/keep.jpg"));
  await assert.rejects(f.call("clearStep", { jobId }, { epoch: "epoch1" }), /刷新/);
  assert.equal((await f.call("bootstrap")).data.status, "preparing");
  await f.call("command", { type: "semesterCreate", name: "新学期", startDate: "2027-03-01", weeks: 20 });
});

test("V2 cross-record photographs and leader editing another member are rejected", async () => {
  const f = fixture({ photos: [row("p1", { storageId: "pg://xuedu-photos/cloud/epoch1/p1.jpg" }, { semesterId: "s1", memberId: "member", taskId: "t1" }), row("foreign", { storageId: "pg://xuedu-photos/cloud/epoch1/foreign.jpg" }, { semesterId: "s1", memberId: "member", taskId: "other", recordId: "other-record" })] });
  await assert.rejects(f.call("command", { type: "recordSubmit", taskId: "t1", metrics, photos: ["foreign"] }, { expectedVersion: 1, who: "om" }), /其他记录/);
  const record = await submit(f);
  await f.call("command", { type: "roleChange", id: "member", role: "admin", reason: "增加管理员", confirmed: true }, { expectedVersion: 1 });
  await f.call("command", { type: "roleChange", id: "admin", role: "leader", reason: "调整为部长", confirmed: true }, { expectedVersion: 1 });
  await assert.rejects(f.call("command", { type: "recordEdit", id: record.id, reason: "部长越权", metrics, photos: ["p1"] }, { expectedVersion: 1 }), /本人记录/);
});

test("V2 cancel and extra dates never rewrite completed record snapshots", async () => {
  const f = fixture(); const record = await submit(f); const frozen = JSON.stringify((await f.repository.get("records", record.id))!.data.course);
  await f.call("command", { type: "exceptionSave", courseId: "course1", date: "2026-09-14", kind: "cancel", reason: "停课" }, { expectedVersion: 1 });
  assert.equal((await f.repository.get("occurrences", "course1:2026-09-14"))!.data.status, "cancelled");
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "submitted");
  await f.call("command", { type: "exceptionSave", courseId: "course1", date: "2026-09-16", newDate: "2026-09-16", kind: "extra", start: 3, end: 4, classroom: "补课教室", reason: "补课" }, { expectedVersion: 2 });
  const extra = (await f.repository.query("occurrences", { eq: { semesterId: "s1", week: 2 } })).items.find(o => o.id.includes(":extra:"))!;
  assert.equal(extra.date, "2026-09-16"); assert.equal((extra.data.course as any).start, 3);
  assert.equal(JSON.stringify((await f.repository.get("records", record.id))!.data.course), frozen);
  await f.call("command", { type: "classSave", id: "c2", name: "改名后的班级", grade: "25", major: "计科" }, { expectedVersion: 1 });
  assert.equal(((await f.call("query", { kind: "report", week: 2 })).data.state as any).classes.find((c: any) => c.id === "c2").name, "25计科1班");
});

test("V2 JSON import retains IDs and independent classes, caps pages, and participation controls new schedules", async () => {
  const f = fixture();
  const course = { id: "import-course", semesterId: "s1", name: "英语", teacher: "教师", nature: "必修", classIds: ["import-class"], classroom: "303", weekday: 2, start: 3, end: 4, weeks: [2, 3], expected: 35 };
  await f.call("command", { type: "import", text: JSON.stringify({ classes: [{ id: "import-class", grade: "26", major: "自动化", name: "26自动化1班" }], courses: [course] }) });
  assert.equal((await f.repository.get("classes", "import-class"))!.data.name, "26自动化1班");
  assert.equal((await f.repository.query("occurrences", { eq: { parentId: "import-course" } })).items.length, 2);
  await assert.rejects(f.call("query", { kind: "records" }, { limit: 101 }), /每页条数/);
  const first = await f.call("query", { kind: "courses" }, { limit: 1 }); assert.equal((first.data.items as Entity[]).length, 1); assert.ok(first.cursor);
  assert.equal(((await f.call("query", { kind: "courses" }, { limit: 1, cursor: first.cursor })).data.items as Entity[])[0].id, "import-course");
  const saved = await f.call("command", { type: "classSave", name: "独立班级", grade: "26", major: "软件工程" });
  assert.ok((saved.data.changed as Entity[]).some(e => e.data.name === "独立班级"));
  await f.call("command", { type: "semesterParticipants", classIds: ["c1"] }, { expectedVersion: 1 });
  const generated = await f.call("command", { type: "planGenerate", week: 2 }, { expectedVersion: 0 });
  assert.equal((generated.data.changed as Entity[]).filter(e => e.data.status === "draft" && e.data.occurrenceId && !e.data.cancel).length, 0);
});

test("V2 missing execution config fails closed for photos and cleanup, bootstrap readable", async () => {
  const f = fixture();
  const api = createGatewayV2({ repository: f.repository, appid: "app", bootstrapOpenid: "oa", maxExecutionMs: 0, uuid: () => "x", photos: { upload: async () => "x", urls: async () => [], list: async () => [], delete: async () => {} } });
  assert.equal((await api({ protocolVersion: 2, operation: "bootstrap" }, { OPENID: "oa", APPID: "app" })).data.executionConfigured, false);
  await assert.rejects(api({ protocolVersion: 2, operation: "clearPreview", epoch: "epoch1" }, { OPENID: "oa", APPID: "app" }), /执行上限/);
});

test("V2 cross-week rescheduling drafts cancellation and replacement in respective weeks, checks destination availability", async () => {
  const f = fixture({ availability: [row("av1", { slots: ["1:1", "1:2"], optedIn: false }, { semesterId: "s1", week: 2, memberId: "member" }), row("av3", { slots: ["1:1", "1:2"], optedIn: false }, { semesterId: "s1", week: 3, memberId: "member" })] });
  const response = await f.call("command", { type: "exceptionSave", courseId: "course1", date: "2026-09-14", kind: "move", newDate: "2026-09-21", reason: "跨周调课" }, { expectedVersion: 1 });
  const occurrence = (await f.repository.get("occurrences", "course1:2026-09-14"))!;
  assert.equal(occurrence.week, 3); assert.equal(occurrence.date, "2026-09-21");
  const plans = (response.data.changed as Entity[]).filter(e => e.data.status === "draft" && !e.data.occurrenceId);
  assert.deepEqual(plans.map(p => p.week).sort(), [2, 3]);
  for (const plan of plans) await f.call("command", { type: "planConfirm", id: plan.id }, { expectedVersion: 1 });
  const confirmed = (await f.repository.query("tasks", { eq: { semesterId: "s1", week: 3 } })).items.filter(t => t.data.status === "confirmed");
  assert.equal(confirmed.length, 1); assert.equal(confirmed[0].data.date, "2026-09-21");
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "cancelled");
});

test("V2 administrator skipping a week requires draft confirmation and can later resume without zero-attendance exports", async () => {
  const f = fixture();
  const skipped = await f.call("command", { type: "planSkip", week: 2, reason: "国庆假期" }, { expectedVersion: 0 });
  const draft = (skipped.data.changed as Entity[]).find(e => e.data.skip)!;
  assert.equal(draft.data.status, "draft"); assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "confirmed");
  await f.call("command", { type: "planConfirm", id: draft.id }, { expectedVersion: 1 });
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "cancelled");
  const week = await f.call("query", { kind: "week", week: 2 }); assert.equal((week.data.plan as Entity).data.status, "skipped");
  const report = await f.call("query", { kind: "report", week: 2 });
  assert.match(exportTxt(report.data.state as any, 2), /已跳过听课：国庆假期/);
  const generated = await f.call("command", { type: "planGenerate", week: 2 }, { expectedVersion: 2 });
  const resumed = (generated.data.changed as Entity[]).find(e => e.data.status === "draft" && !e.data.occurrenceId)!;
  assert.equal((await f.repository.get("plans", draft.id))!.data.status, "skipped");
  await f.call("command", { type: "planConfirm", id: resumed.id }, { expectedVersion: 1 });
  assert.equal((await f.repository.get("plans", draft.id))!.data.status, "superseded");
  assert.equal(((await f.call("query", { kind: "week", week: 2 })).data.plan as Entity).data.status, "confirmed");
});

test("V2 skipped-week actions reject members and leaders, and refuse already-submitted or newly-submitted weeks", async () => {
  const f = fixture();
  await assert.rejects(f.call("command", { type: "planSkip", week: 2, reason: "越权" }, { expectedVersion: 0, who: "om" }), /仅管理员/);
  await f.call("command", { type: "roleChange", id: "member", role: "leader", reason: "部长", confirmed: true }, { expectedVersion: 1 });
  await assert.rejects(f.call("command", { type: "planSkip", week: 2, reason: "部长越权" }, { expectedVersion: 0, who: "om" }), /仅管理员/);
  const skipped = await f.call("command", { type: "planSkip", week: 2, reason: "假期" }, { expectedVersion: 0 });
  const draft = (skipped.data.changed as Entity[]).find(e => e.data.skip)!;
  await submit(f);
  await assert.rejects(f.call("command", { type: "planConfirm", id: draft.id }, { expectedVersion: 1 }), /已有提交记录/);
  await assert.rejects(f.call("command", { type: "planSkip", week: 2, reason: "不能跳过已完成" }, { expectedVersion: 0 }), /已有提交记录/);
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "submitted");
});

test("V2 cancellation drafts expose uncovered classes and reasons while completed tasks still count as coverage", async () => {
  const f = fixture();
  const adjusted = await f.call("command", { type: "taskAdjust", week: 2, reason: "成员临时有事", changes: [{ taskId: "t1", cancel: true }] }, { expectedVersion: 0 });
  const plan = (adjusted.data.changed as Entity[]).find(e => e.data.status === "draft" && !e.data.occurrenceId)!;
  const uncovered = plan.data.uncovered as { label: string; reason: string }[];
  assert.ok(uncovered.some(item => item.label === "25计科1班" && item.reason.includes("成员临时有事")));
  assert.equal((await f.repository.get("tasks", "t1"))!.data.status, "confirmed");
  const g = fixture(); await submit(g);
  const created = await g.call("command", { type: "planGenerate", week: 2 }, { expectedVersion: 0 });
  const completionDraft = (created.data.changed as Entity[]).find(e => e.data.status === "draft" && !e.data.occurrenceId)!;
  assert.equal((completionDraft.data.uncovered as { label: string }[]).some(item => item.label === "25计科1班"), false);
});

function officerFixture() {
 return fixture({members:[row('admin',{name:'管理员',studentNo:'001',classId:'c1',role:'admin',active:true},{studentNo:'001'}),row('member',{name:'成员',studentNo:'002',classId:'c1',role:'member',active:true},{studentNo:'002'}),row('officer',{name:'信息部干事',studentNo:'003',classId:'c1',role:'officer',active:true},{studentNo:'003'})],bindings:[row('ba',{},{identityKey:'oa',memberId:'admin'}),row('bm',{},{identityKey:'om',memberId:'member'}),row('bo',{},{identityKey:'oo',memberId:'officer'})]});
}
test('officer reads all records, private photos and full Excel but no foreign availability or management',async()=>{
 const f=officerFixture(),record=await submit(f);
 const status=await f.call('query',{kind:'submissionStatus',week:2},{who:'oo'});
 const person=(status.data.items as any[]).find(v=>v.id==='member');
 assert.equal(person.availability,'已提交');assert.equal(person.record,'已提交');
 assert.deepEqual(Object.keys(person).sort(),['assigned','availability','className','id','name','record','submitted']);
 const report=await f.call('query',{kind:'summaryReport',week:2},{who:'oo'});
 assert.equal((report.data.summary as any).rows[0].actual,29);
 assert.doesNotMatch(JSON.stringify(report.data),/studentNo|memberName|photos|suggestion|slots|identityKey|firstSubmittedAt/);
 assert.equal((await f.call('query',{kind:'records',week:2},{who:'oo'})).data.items.length,1);
 const detail=await f.call('query',{kind:'record',id:record.id},{who:'oo'});assert.equal(detail.data.canEdit,false);
 assert.equal((await f.call('query',{kind:'recordVersions',id:record.id},{who:'oo'})).data.items.length,1);
 assert.equal((await f.call('photoUrls',{recordId:record.id},{who:'oo'})).data.urls.length,1);
 assert.equal((await f.call('photoUrls',{ids:['p1']},{who:'oo'})).data.urls.length,1);
 const full=await f.call('query',{kind:'excelReport',week:2},{who:'oo'}),adminFull=await f.call('query',{kind:'excelReport',week:2});
 assert.deepEqual(reportSheets(full.data.state as any,2),reportSheets(adminFull.data.state as any,2));
 assert.deepEqual((full.data.state as any).availability,[]);
 await f.call('query',{kind:'reportCheck',format:'xlsx',version:full.data.version},{who:'oo'});
 await f.call('query',{kind:'report',format:'xlsx',week:2},{who:'oo'});
 await f.call('query',{kind:'report',week:2},{who:'oo'});
 const adminNames=await f.call('query',{kind:'namesReport',week:2});
 for(const payload of [{kind:'namesReport',week:2},{kind:'report',week:2,format:'txt'},{kind:'report',week:2,format:'copy'}]) {
   const names=await f.call('query',payload,{who:'oo'});
   assert.equal(exportTxt(names.data.state as any,2),exportTxt(adminNames.data.state as any,2));
   assert.deepEqual(names.data.records,adminNames.data.records);
   await assert.rejects(f.call('query',payload,{who:'om'}),/仅管理员/);
 }
 assert.equal((await f.call('query',{kind:'namesReport',week:1},{who:'oo'})).data.records.length,0);
 await assert.rejects(f.call('query',{kind:'namesReport',week:2},{who:'oo',semesterId:'missing'}),/对象不存在/);
 await assert.rejects(f.call('query',{kind:'namesReport',week:21},{who:'oo'}),/周/);
 for(const format of ['txt','copy']) {
   await f.call('query',{kind:'reportCheck',format,version:full.data.version},{who:'oo'});
   await assert.rejects(f.call('query',{kind:'reportCheck',format,version:0},{who:'oo'}),/变化/);
   await assert.rejects(f.call('query',{kind:'reportCheck',format,version:full.data.version},{who:'om'}),/协作|仅管理员/);
 }
 await assert.rejects(f.call('query',{kind:'report',format:'txt',week:2,reportVersion:0},{who:'oo'}),/变化/);
 const week=await f.call('query',{kind:'week',week:2},{who:'oo'});assert.equal(week.data.availability,null);assert.equal(week.data.records.length,0);
 for(const payload of [{kind:'task',id:'t1'},{kind:'members'},{kind:'applications'},{kind:'availability',memberId:'member'}])await assert.rejects(f.call('query',payload,{who:'oo'}),/权限|不可|管理|查询类型/);
 await assert.rejects(f.call('command',{type:'recordEdit',id:record.id,reason:'越权更正',metrics,photos:['p1']},{who:'oo',expectedVersion:record.version}),/不可|本人|无权/);
 await assert.rejects(f.call('photo',{taskId:'t1',base64:'AA=='},{who:'oo'}),/不可/);
 for(const type of ['planConfirm','taskAdjust','roleChange','applicationReview','memberRemove'])await assert.rejects(f.call('command',{type,id:'member',week:2,reason:'越权验证',confirmed:true},{who:'oo',expectedVersion:1}),/管理|管理员/);
 await assert.rejects(f.call('query',{kind:'submissionStatus',week:2},{who:'om'}),/协作/);
 await assert.rejects(f.call('query',{kind:'summaryReport',week:2},{who:'om'}),/协作/);
 await assert.rejects(f.call('query',{kind:'reportCheck',version:0},{who:'oo'}),/变化/);
});
test('officer can generate draft, cannot confirm, and is eligible without manager opt-in',async()=>{
 const f=officerFixture();
 const w=await f.repository.workspace();await f.repository.commit({epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'oa',actorId:'admin',requestId:'remove-availability',reads:[],changes:[{resource:'availability',id:'av1',expectedVersion:1,value:null}],result:{}});
 await f.call('command',{type:'availabilitySave',week:2,slots:['1:1','1:2'],optedIn:false},{who:'oo',expectedVersion:0});
 const generated=await f.call('command',{type:'planGenerate',week:2},{who:'oo',expectedVersion:0});
 const changed=generated.data.changed as Entity[];
 const plan=changed.find(e=>e.data.status==='draft'&&!e.memberId)!;
 assert.ok(plan);await assert.rejects(f.call('command',{type:'planConfirm',id:plan.id},{who:'oo',expectedVersion:1}),/管理/);
 assert.ok(changed.some(e=>e.memberId==='officer'&&e.data.status==='draft'));
});

test('leader cannot generate, adjust, confirm or export files; retains records, photos and statistics',async()=>{
 const f=fixture(),record=await submit(f);
 await f.call('command',{type:'roleChange',id:'member',role:'leader',reason:'合成权限测试',confirmed:true},{expectedVersion:1});
 const before=(await f.repository.workspace()).version;
 for(const type of ['planGenerate','planConfirm','taskAdjust']) await assert.rejects(f.call('command',{type,week:2,id:'forged',confirmed:true},{who:'om',expectedVersion:0}),/无权|仅管理员/);
 for(const payload of [{kind:'excelReport',week:2},{kind:'report',week:2,format:'xlsx'},{kind:'reportCheck',format:'xlsx',version:before},{kind:'namesReport',week:2},{kind:'report',week:2,format:'txt'},{kind:'report',week:2,format:'copy'},{kind:'reportCheck',format:'txt',version:before}]) await assert.rejects(f.call('query',payload,{who:'om'}),/仅管理员/);
 assert.equal((await f.repository.workspace()).version,before);
 assert.equal((await f.call('query',{kind:'report',week:2},{who:'om'})).data.records.length,1);
 assert.ok((await f.call('query',{kind:'record',id:record.id},{who:'om'})).data.record);
 await f.call('photoUrls',{recordId:record.id},{who:'om'});
 await f.call('query',{kind:'reportCheck',version:before},{who:'om'});
 assert.ok((await f.call('query',{kind:'excelReport',week:2})).data.state);
 assert.ok((await f.call('query',{kind:'namesReport',week:2})).data.state);
 // Neither leader nor officer may create adjustment drafts. Admin retains cancellation.
 const fresh=fixture();await fresh.call('command',{type:'roleChange',id:'member',role:'leader',reason:'合成权限测试',confirmed:true},{expectedVersion:1});
 for(const changes of [[{taskId:'t1',cancel:true}],[{taskId:'t1',memberId:'member',occurrenceId:'course1:2026-09-14'}],[{memberId:'member',occurrenceId:'course1:2026-09-14'}]]) await assert.rejects(fresh.call('command',{type:'taskAdjust',week:2,reason:'越权调整',changes},{who:'om',expectedVersion:0}),/仅管理员/);
 assert.equal((await fresh.repository.query('plans',{})).items.length,0);
 const adjusted=await fresh.call('command',{type:'taskAdjust',week:2,reason:'合成取消',changes:[{taskId:'t1',cancel:true}]},{expectedVersion:0});
 const draft=(adjusted.data.changed as Entity[]).find(e=>e.data.status==='draft'&&!e.memberId)!;
 assert.equal((await fresh.repository.get('tasks','t1'))!.data.status,'confirmed');
 await assert.rejects(fresh.call('command',{type:'planConfirm',id:draft.id},{who:'om',expectedVersion:1}),/仅管理员/);
 await fresh.call('command',{type:'planConfirm',id:draft.id,reason:'管理员确认'},{expectedVersion:1});
 assert.equal((await fresh.repository.get('tasks','t1'))!.data.status,'cancelled');
});

test('officer record pagination is complete, reports match admin including empty weeks, and revocation closes photo access',async()=>{
 const f=officerFixture(),record=await submit(f),w=await f.repository.workspace();
 const changes:any[]=Array.from({length:55},(_,i)=>({resource:'records',id:'extra-'+String(i).padStart(3,'0'),expectedVersion:0,value:{...record,id:'extra-'+String(i).padStart(3,'0'),taskId:'extra-task-'+i,version:1}}));
 changes.push({resource:'photos',id:'unsubmitted',expectedVersion:0,value:row('unsubmitted',{storageId:'private-unsubmitted'},{semesterId:'s1',memberId:'member',taskId:'other-task'})});
 await f.repository.commit({epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'oa',actorId:'admin',requestId:'pagination-seed',reads:[],changes,result:{}});
 for(const bundled of [false,true]) {
  const request=(cursor='')=>bundled?f.call('bootstrap',{page:{view:'records',week:2,semesterId:'s1',...(cursor?{more:true,cursor,selectionOwner:'officer'}:{})}},{who:'oo'}):f.call('query',{kind:'records',week:2},{who:'oo',cursor});
  const first=await request(), list=bundled?(first.data.page as any).list:{items:first.data.items,cursor:first.cursor};
  assert.equal(list.items.length,50);assert.ok(list.cursor);
  const next=await request(list.cursor),second=bundled?(next.data.page as any).list:{items:next.data.items,cursor:next.cursor};
  assert.equal(second.items.length,6);assert.equal(second.cursor,'');assert.equal(new Set([...list.items,...second.items].map(r=>r.id)).size,56);
  assert.doesNotMatch(JSON.stringify([first,next]),/slots|identityKey/);
 }
 for(const week of [1,2]) {
  const officer=await f.call('query',{kind:'excelReport',week},{who:'oo'}),admin=await f.call('query',{kind:'excelReport',week});
  assert.deepEqual(reportSheets(officer.data.state as any,week),reportSheets(admin.data.state as any,week));
  assert.equal((officer.data.state as any).records.length,week===2?56:0);assert.deepEqual((officer.data.state as any).availability,[]);
 }
 const versions=await f.call('query',{kind:'recordVersions',id:record.id},{who:'oo'});
 assert.equal((await f.call('photoUrls',{recordId:record.id,versionId:versions.data.items[0].id},{who:'oo'})).data.urls.length,1);
 await assert.rejects(f.call('photoUrls',{ids:['unsubmitted']},{who:'oo'}),/未提交/);
 await assert.rejects(f.call('photoUrls',{recordId:record.id},{who:'oo',semesterId:'wrong'}),/不可/);
 const detail=await f.call('bootstrap',{page:{view:'record',semesterId:'s1',week:2,targetId:record.id}},{who:'oo'});assert.equal((detail.data.page as any).record.canEdit,false);
 const own=await f.call('bootstrap',{page:{view:'availability',semesterId:'s1',week:2,memberId:'member'}},{who:'oo'});assert.equal((own.data.page as any).weekData.availability,null);
 await f.call('command',{type:'availabilitySave',week:2,slots:['3:3'],note:'own-only'},{who:'oo',expectedVersion:0});
 const saved=await f.call('query',{kind:'week',week:2,memberId:'member'},{who:'oo'});assert.deepEqual((saved.data.availability as any).data.slots,['3:3']);assert.doesNotMatch(JSON.stringify(saved),/"1:1"/);
 await f.call('command',{type:'roleChange',id:'officer',role:'member',reason:'合成降级',confirmed:true},{expectedVersion:1});
 assert.equal((await f.call('query',{kind:'records',week:2},{who:'oo'})).data.items.length,0);
 await assert.rejects(f.call('photoUrls',{ids:['p1']},{who:'oo'}),/不可/);
 await assert.rejects(f.call('query',{kind:'excelReport',week:2},{who:'oo'}),/仅管理员/);
 for(const payload of [{kind:'namesReport',week:2},{kind:'report',format:'copy',week:2},{kind:'reportCheck',format:'txt',version:0}])await assert.rejects(f.call('query',payload,{who:'oo'}),/仅管理员|协作/);
 await f.call('command',{type:'memberRemove',id:'officer',reason:'合成停用'},{expectedVersion:2});
 await assert.rejects(f.call('query',{kind:'record',id:record.id},{who:'oo'}),/通过审核/);
});
