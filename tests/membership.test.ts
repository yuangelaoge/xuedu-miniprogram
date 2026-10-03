import test from "node:test";
import assert from "node:assert/strict";
import { createSeed } from "../miniprogram/domain/seed";
import { applyForMembership, reviewApplications, removeMember, setMemberRole, latestApplication, membershipFor } from "../miniprogram/domain/membership";
import { actor, generate } from "../miniprogram/domain/actions";
import { inspectImport, commitImport, ImportKind } from "../miniprogram/domain/imports";
import { missingMetrics } from "../miniprogram/domain/metrics";
import { weekDate } from "../miniprogram/domain/calendar";

const form = { name: "新成员", studentNo: "20260001", classId: "24-cs1" };
const seed = () => createSeed(new Date("2026-09-16T12:00:00+08:00"));
test("申请不会生成成员或授予权限；重复申请幂等", () => {
  const s = seed(), count = s.members.length;
  s.actorId = "";
  const a = applyForMembership(s, "wx-demo-1", form);
  assert.equal(a.status, "pending");
  assert.equal(s.members.length, count);
  assert.equal(applyForMembership(s, "wx-demo-1", { ...form, name: "重复" }).id, a.id);
  assert.equal(s.applications.length, 1);
  assert.throws(() => actor(s));
  assert.throws(() => reviewApplications(s, [a.id], "approved"));
});
test("申请校验姓名、学号、班级；不按同名合并身份", () => {
  const s = seed();
  for (const bad of [{ ...form, name: " " }, { ...form, studentNo: "" }, { ...form, classId: "none" }])
    assert.throws(() => applyForMembership(s, "wx-demo", bad));
  applyForMembership(s, "wx-demo-1", form);
  assert.throws(() => applyForMembership(s, "wx-demo-2", form), /学号/);
  assert.doesNotThrow(() => applyForMembership(s, "wx-demo-2", { ...form, studentNo: "20260002" }));
});
test("管理员和组部长可审核；通过后只授予普通成员并关联身份", () => {
  for (const reviewer of ["m6", "m7"]) {
    const s = seed();
    const a = applyForMembership(s, "wx-demo", { ...form, role: "admin" } as typeof form);
    assert.throws(() => reviewApplications(s, [a.id], "approved"), /无权/);
    s.actorId = reviewer;
    reviewApplications(s, [a.id], "approved");
    const member = membershipFor(s, "wx-demo")!;
    assert.equal(member.role, "member"); assert.equal(member.active, true);
    assert.equal(a.reviewedBy, reviewer);
    assert.throws(() => reviewApplications(s, [a.id], "approved"), /已处理/);
    assert.throws(() => applyForMembership(s, "wx-demo", form), /已经是成员/);
  }
});
test("驳回必须给原因，可修改后重新申请，保留旧审核历史", () => {
  const s = seed(), a = applyForMembership(s, "wx-demo", form);
  s.actorId = "m6";
  assert.throws(() => reviewApplications(s, [a.id], "rejected", " "), /原因/);
  reviewApplications(s, [a.id], "rejected", "请核对班级");
  const again = applyForMembership(s, "wx-demo", { ...form, classId: "25-cs1" });
  assert.notEqual(again.id, a.id);
  assert.equal(a.reason, "请核对班级");
  assert.equal(latestApplication(s, "wx-demo")!.status, "pending");
});
test("批量审核先完整校验，不因中间申请失效部分开通", () => {
  const s = seed(), a = applyForMembership(s, "wx-demo", form);
  s.actorId = "m6";
  const before = JSON.stringify(s);
  assert.throws(() => reviewApplications(s, [a.id, "missing"], "approved"));
  assert.equal(JSON.stringify(s), before);
  assert.throws(() => reviewApplications(s, [a.id, a.id], "approved"));
  const b = applyForMembership(s, "wx-demo-2", { ...form, studentNo: "20260002" });
  reviewApplications(s, [a.id, b.id], "approved");
  assert.equal(s.members.filter(m => m.identityKey).length, 2);
});
test("审核时再次检查学号占用，不能覆盖已有账号", () => {
  const s = seed(), a = applyForMembership(s, "wx-demo", form);
  s.members[0].studentNo = form.studentNo;
  s.actorId = "m6";
  assert.throws(() => reviewApplications(s, [a.id], "approved"), /已经关联/);
  assert.equal(a.status, "pending");
});
test("删除组员取消未完成任务并留档，不修改已提交记录与照片", () => {
  const s = seed(), plan = s.plans[0], target = plan.tasks[0];
  s.records.push({ id: "history", taskId: "historical-task", semesterId: s.activeSemesterId, week: 1,
    memberId: target.memberId, memberName: target.memberName, course: target.course, classLabel: target.classLabel,
    date: weekDate(s.semesters[0], 1, target.course.weekday), metrics: missingMetrics(), absentNames: "无", leaveNames: "无",
    photos: ["saved-signature.jpg"], otherDescription: "", evaluation: "", feedback: "", suggestion: "", createdAt: "" });
  const history = JSON.stringify(s.records);
  s.actorId = "m7"; generate(s, 3);
  s.actorId = "m6";
  removeMember(s, target.memberId);
  assert.equal(JSON.stringify(s.records), history);
  assert.equal(s.members.find(m => m.id === target.memberId)!.active, false);
  assert.ok(plan.cancelledTasks!.some(t => t.id === target.id));
  assert.ok(!plan.tasks.some(t => t.id === target.id));
  assert.ok(plan.uncovered.some(u => u.label === target.classLabel));
  assert.equal(s.drafts.length, 0);
  s.actorId = "m7";
  generate(s, 3);
  assert.ok(s.drafts[0].tasks.every(t => t.memberId !== target.memberId));
  s.actorId = target.memberId; assert.throws(() => actor(s));
});
test("已完成任务保留，不误标成取消", () => {
  const s = seed(), task = s.plans[0].tasks[0];
  s.records.push({ taskId: task.id } as typeof s.records[number]);
  s.actorId = "m7"; removeMember(s, task.memberId);
  assert.ok(s.plans[0].tasks.some(t => t.id === task.id));
  assert.equal(s.plans[0].cancelledTasks?.length || 0, 0);
});
test("删除不允许越权或删除管理成员；被移除身份不可重新申请绕过", () => {
  const s = seed();
  assert.throws(() => removeMember(s, "m1"), /无权/);
  s.actorId = "m6";
  for (const id of ["m6", "m7"]) assert.throws(() => removeMember(s, id), /普通组员/);
  s.members[0].identityKey = "wx-demo";
  removeMember(s, "m0");
  assert.throws(() => applyForMembership(s, "wx-demo", form), /已被移除/);
});
test("只有管理员能授予及撤销组部长；不能改管理员或停用成员", () => {
  const s = seed(); s.actorId = "m6";
  assert.throws(() => setMemberRole(s, "m0", "leader"), /无权/);
  s.actorId = "m7";
  setMemberRole(s, "m0", "leader"); assert.equal(s.members[0].role, "leader");
  setMemberRole(s, "m0", "member"); assert.equal(s.members[0].role, "member");
  assert.throws(() => setMemberRole(s, "m7", "member"));
  removeMember(s, "m0"); assert.throws(() => setMemberRole(s, "m0", "leader"));
});
test("成员导入底层已禁用，课表导入夹带成员字段也不能通过", () => {
  const s = seed(); s.actorId = "m7";
  const before = JSON.stringify(s);
  assert.throws(() => commitImport(s, "members" as ImportKind, "{}"), /已取消/);
  assert.ok(inspectImport(s, "courses", '{"members":[]}').errors.some(e => e.includes("已取消")));
  assert.equal(JSON.stringify(s), before);
});
