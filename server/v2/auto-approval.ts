import { Commit, Entity, Resource, Workspace } from "../../miniprogram/domain/v2/protocol";
export function validateAutoJoin(c: Commit, w: Workspace, now: number, get: (r: Resource, id: string) => Entity | undefined, identityExists: boolean): void {
  const fail = (): never => { throw new Error("FORBIDDEN"); };
  if (!w.autoApproval?.enabled || !(Date.parse(w.autoApproval.expiresAt) > now)) throw new Error("AUTO_APPROVAL_EXPIRED");
  if (c.workspace || c.initialize || identityExists || c.changes.length !== 4) fail();
  const only = (resource: Resource) => { const values = c.changes.filter(ch => ch.resource === resource); if (values.length !== 1 || !values[0].value) fail(); return values[0]; };
  const m = only("members"), b = only("bindings"), a = only("applications"), log = only("audit");
  const member = m.value!, binding = b.value!, app = a.value!, previous = get("applications", a.id), klass = get("classes", String(member.data.classId));
  if (m.expectedVersion !== 0 || b.expectedVersion !== 0 || log.expectedVersion !== 0 || c.actorId !== m.id || member.data.role !== "member" || member.data.active !== true || binding.identityKey !== c.identityKey || binding.memberId !== m.id || app.identityKey !== c.identityKey || app.data.memberId !== m.id || app.data.status !== "approved" || app.data.approvalMode !== "automatic" || app.sortKey !== "automatic" || !member.studentNo || app.studentNo !== member.studentNo || member.data.studentNo !== member.studentNo || app.data.studentNo !== member.studentNo || member.data.name !== app.data.name || member.data.classId !== app.data.classId || !klass || klass.epoch !== w.epoch || klass.data.active === false || (previous && (previous.identityKey !== c.identityKey || previous.data.status !== "rejected")) || log.value!.data.action !== "autoApproveApplication" || log.value!.data.target !== a.id) fail();
}
