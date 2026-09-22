import { AppState, Availability, Observation, Role } from "./types";
import { eligible, generatePlan } from "./scheduler";
import { validateMetrics } from "./metrics";
import { dateString, weekDate } from "./calendar";
export function actor(state: AppState) {
  const member = state.members.find((m) => m.id === state.actorId && m.active);
  if (!member) throw new Error("当前成员不存在或已停用");
  return member;
}
export function requireRole(state: AppState, roles: Role[]): void {
  if (!roles.includes(actor(state).role))
    throw new Error("当前身份无权执行此操作");
}
export function audit(state: AppState, action: string, detail: string): void {
  state.audit.unshift({
    at: new Date().toISOString(),
    actor: actor(state).name,
    action,
    detail,
  });
}
function editableWeek(state: AppState, week: number): void {
  const semester = state.semesters.find((s) => s.id === state.activeSemesterId);
  if (!semester || !Number.isInteger(week) || week < 1 || week > semester.weeks)
    throw new Error("无效周次");
  if (
    state.records.some((r) => r.semesterId === semester.id && r.week === week)
  )
    throw new Error(
      "本周已有提交记录，体验版暂不支持重排或跳过，以保留听课凭证",
    );
}
export function generate(state: AppState, week: number): void {
  requireRole(state, ["admin", "leader"]);
  editableWeek(state, week);
  const draft = generatePlan(
    state,
    state.activeSemesterId,
    week,
    ++state.generation,
  );
  state.drafts = state.drafts
    .filter((p) => !(p.semesterId === draft.semesterId && p.week === week))
    .concat(draft);
  audit(state, "生成排班草稿", "第" + week + "周 · v" + draft.revision);
}
export function confirm(state: AppState, week: number, revision: number): void {
  requireRole(state, ["admin", "leader"]);
  editableWeek(state, week);
  const draft = state.drafts.find(
    (p) => p.semesterId === state.activeSemesterId && p.week === week,
  );
  if (!draft || draft.revision !== revision)
    throw new Error("草稿已变化，请刷新后重新确认");
  if (!draft.tasks.length)
    throw new Error("没有可发布的任务；可完善数据后重生成，或由管理员跳过本周");
  if (draft.tasks.some((t) => !eligible(state, t.course, t.memberId, week)))
    throw new Error("成员无课时间或状态已变化，请重新生成");
  const plan = {
    ...draft,
    status: "confirmed" as const,
    confirmedBy: state.actorId,
    confirmedAt: new Date().toISOString(),
  };
  state.plans = state.plans
    .filter((p) => !(p.semesterId === plan.semesterId && p.week === week))
    .concat(plan);
  state.drafts = state.drafts.filter((p) => p !== draft);
  audit(state, "确认排班", "第" + week + "周 · v" + revision);
}
export function skip(state: AppState, week: number, reason: string): void {
  requireRole(state, ["admin"]);
  editableWeek(state, week);
  if (!reason.trim()) throw new Error("请填写跳过原因");
  const semesterId = state.activeSemesterId;
  state.plans = state.plans.filter(
    (p) => !(p.semesterId === semesterId && p.week === week),
  );
  state.plans.push({
    semesterId,
    week,
    revision: ++state.generation,
    status: "skipped",
    tasks: [],
    uncovered: [],
    reason: reason.trim(),
    createdAt: new Date().toISOString(),
  });
  state.drafts = state.drafts.filter(
    (p) => !(p.semesterId === semesterId && p.week === week),
  );
  audit(state, "跳过周次", "第" + week + "周：" + reason);
}
export function saveAvailability(state: AppState, value: Availability): void {
  const user = actor(state);
  if (!state.classes.some(c => c.id === user.classId)) throw new Error("请先在管理工作台设置本人真实班级，再报名听课");
  if (value.memberId !== user.id || value.semesterId !== state.activeSemesterId)
    throw new Error("只能保存自己的当前学期无课时间");
  const semester = state.semesters.find((s) => s.id === value.semesterId)!;
  if (
    !Number.isInteger(value.week) ||
    value.week < 1 ||
    value.week > semester.weeks
  )
    throw new Error("无效周次");
  if (
    value.slots.some((slot) => {
      const [d, p] = slot.split(":").map(Number);
      return (
        !Number.isInteger(d) ||
        !Number.isInteger(p) ||
        d < 1 ||
        d > semester.days ||
        p < 1 ||
        p > semester.periods
      );
    })
  )
    throw new Error("无效时间格");
  const assigned = state.plans
    .find(
      (p) =>
        p.semesterId === value.semesterId &&
        p.week === value.week &&
        p.status === "confirmed",
    )
    ?.tasks.find((t) => t.memberId === user.id);
  if (assigned) {
    const candidate = {
      ...state,
      availability: state.availability
        .filter(
          (a) =>
            !(
              a.memberId === user.id &&
              a.semesterId === value.semesterId &&
              a.week === value.week
            ),
        )
        .concat(value),
    };
    if (!eligible(candidate, assigned.course, user.id, value.week))
      throw new Error("已有正式任务，请先联系管理人员调整排班再修改该时段");
  }
  value.slots = Array.from(new Set(value.slots));
  value.updatedAt = new Date().toISOString();
  state.availability = state.availability
    .filter(
      (a) =>
        !(
          a.memberId === user.id &&
          a.semesterId === value.semesterId &&
          a.week === value.week
        ),
    )
    .concat(value);
  audit(state, "保存无课时间", "第" + value.week + "周");
}
export function submitRecord(state: AppState, record: Observation): void {
  const member = actor(state);
  const plan = state.plans.find(
    (p) =>
      p.semesterId === record.semesterId &&
      p.week === record.week &&
      p.status === "confirmed",
  );
  const task = plan?.tasks.find(
    (t) => t.id === record.taskId && t.memberId === member.id,
  );
  if (!task || record.memberId !== member.id)
    throw new Error("只能提交自己的已确认任务");
  if (state.records.some((r) => r.taskId === task.id))
    throw new Error("这次任务已提交，请勿重复提交");
  if (!record.photos.length || record.photos.some((p) => !p.trim()))
    throw new Error("请上传包含老师签字的听课表照片");
  validateMetrics(record.metrics);
  if (!record.absentNames.trim() || !record.leaveNames.trim())
    throw new Error("请填写旷课和请假名单；确实没有填“无”，不清楚填“信息缺失”");
  const semester = state.semesters.find((s) => s.id === record.semesterId)!;
  if (record.date !== weekDate(semester, record.week, task.course.weekday))
    throw new Error("听课日期与任务不一致");
  if (record.date > dateString(new Date()))
    throw new Error("听课日期尚未到来，请在实际听课后提交");
  state.records.push({
    ...record,
    course: task.course,
    classLabel: task.classLabel,
    memberName: member.name,
    createdAt: new Date().toISOString(),
  });
  audit(state, "提交听课记录", task.classLabel + " · 第" + record.week + "周");
}
