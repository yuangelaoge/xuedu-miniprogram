import { AppState, JoinApplication } from "./types";
import { audit, requireRole } from "./actions";

export type JoinForm = Pick<JoinApplication, "name" | "studentNo" | "classId">;
const studentKey = (s: string) => s.trim().toUpperCase();
export function membershipFor(state: AppState, identityKey: string) {
  return state.members.find(m => m.identityKey === identityKey);
}
export function latestApplication(state: AppState, identityKey: string) {
  return state.applications.slice().reverse().find(a => a.identityKey === identityKey);
}
function validForm(state: AppState, input: JoinForm): JoinForm {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 30)
    throw new Error("请填写真实姓名（不超过 30 字）");
  if (typeof input.studentNo !== "string" || !/^[A-Za-z0-9-]{3,32}$/.test(input.studentNo.trim()))
    throw new Error("请填写有效学号（3–32 位字母、数字或短横线）");
  if (!state.classes.some(c => c.id === input.classId)) throw new Error("请选择所属班级");
  return { name: input.name.trim(), studentNo: studentKey(input.studentNo), classId: input.classId };
}
// identityKey 由存储适配层提供；正式版必须改为服务端可信微信身份，禁止相信客户端传值。
export function applyForMembership(state: AppState, identityKey: string, input: JoinForm): JoinApplication {
  if (!identityKey || !identityKey.trim()) throw new Error("身份不可用，请重新进入");
  const existing = membershipFor(state, identityKey);
  if (existing) throw new Error(existing.active ? "你已经是成员，无需重复申请" : "你的成员资格已被移除，请联系管理员");
  const previous = latestApplication(state, identityKey);
  if (previous?.status === "pending") return previous;
  const form = validForm(state, input);
  if (state.members.some(m => studentKey(m.studentNo) === form.studentNo) ||
      state.applications.some(a => a.status === "pending" && a.studentNo === form.studentNo))
    throw new Error("该学号已有成员或待审核申请，请联系组部长核实");
  let sequence = state.applications.length + 1;
  while (state.applications.some(a => a.id === "join-" + sequence)) sequence++;
  const application: JoinApplication = {
    ...form, identityKey, id: "join-" + sequence, status: "pending", createdAt: new Date().toISOString(),
  };
  state.applications.push(application);
  return application;
}
export function reviewApplications(state: AppState, ids: string[], decision: "approved" | "rejected", reason = ""): void {
  requireRole(state, ["admin", "leader"]);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("请选择待审核申请，不能重复选择");
  if (decision !== "approved" && decision !== "rejected") throw new Error("无效审核操作");
  if (decision === "rejected" && !reason.trim()) throw new Error("请填写驳回原因，方便成员修改后重新申请");
  if (reason.length > 200) throw new Error("原因不能超过 200 字");
  const applications = ids.map(id => {
    const a = state.applications.find(item => item.id === id);
    if (!a || a.status !== "pending") throw new Error("申请已处理或不存在，请刷新后重试");
    validForm(state, a);
    return a;
  });
  if (decision === "approved") {
    const identities = new Set<string>(), studentNos = new Set<string>();
    for (const a of applications) {
      if (membershipFor(state, a.identityKey) || state.members.some(m => studentKey(m.studentNo) === a.studentNo) ||
          identities.has(a.identityKey) || studentNos.has(a.studentNo)) throw new Error("微信身份或学号已经关联成员，不能覆盖已有账号");
      identities.add(a.identityKey); studentNos.add(a.studentNo);
      if (state.members.some(m => m.id === "member-" + a.id)) throw new Error("成员标识冲突，请联系管理员");
    }
  }
  for (const a of applications) {
    if (decision === "approved") {
      a.memberId = "member-" + a.id;
      state.members.push({ id: a.memberId, identityKey: a.identityKey, name: a.name, studentNo: a.studentNo, classId: a.classId, role: "member", active: true });
    }
    a.status = decision; a.reason = decision === "rejected" ? reason.trim() : "";
    a.reviewedAt = new Date().toISOString(); a.reviewedBy = state.actorId;
    audit(state, decision === "approved" ? "通过入组申请" : "驳回入组申请", a.name + " · " + a.studentNo + (a.reason ? " · " + a.reason : ""));
  }
  if (decision === "approved") state.drafts = [];
}
export function removeMember(state: AppState, memberId: string): void {
  requireRole(state, ["admin", "leader"]);
  const member = state.members.find(m => m.id === memberId && m.active);
  if (!member) throw new Error("成员已被删除或不存在，请刷新");
  if (member.role !== "member") throw new Error("只能删除普通组员；管理身份须先由管理员撤销");
  if (member.id === state.actorId) throw new Error("不能删除自己");
  member.active = false; member.removedAt = new Date().toISOString();
  let cancelled = 0;
  for (const plan of state.plans) {
    const pending = plan.tasks.filter(t => t.memberId === memberId && !state.records.some(r => r.taskId === t.id));
    if (!pending.length) continue;
    plan.cancelledTasks = (plan.cancelledTasks || []).concat(pending);
    plan.tasks = plan.tasks.filter(t => !pending.includes(t));
    for (const task of pending) {
      if (!plan.tasks.some(t => t.classLabel === task.classLabel) && !plan.uncovered.some(u => u.label === task.classLabel))
        plan.uncovered.push({ label: task.classLabel, reason: "成员已删除，原任务取消；需管理人员处理安排" });
    }
    cancelled += pending.length;
  }
  state.drafts = [];
  audit(state, "删除组员", member.name + "；取消未完成任务 " + cancelled + " 个，保留历史记录和照片");
}
export function setMemberRole(state: AppState, memberId: string, role: "leader" | "member"): void {
  requireRole(state, ["admin"]);
  const member = state.members.find(m => m.id === memberId && m.active);
  if (!member || member.role === "admin" || member.id === state.actorId || !["leader", "member"].includes(role))
    throw new Error("此入口仅调整在任组部长或普通成员，不修改管理员");
  member.role = role; state.drafts = [];
  audit(state, "调整成员角色", member.name + " · " + (role === "leader" ? "组部长" : "普通成员"));
}
