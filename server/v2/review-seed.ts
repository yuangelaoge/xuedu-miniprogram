import { Entity, Resource, Workspace } from "../../miniprogram/domain/v2/protocol";

export interface ReviewSnapshot {
  workspace: Workspace;
  rows: Partial<Record<Resource, Entity[]>>;
}

export const REVIEW_ROLES = ["admin", "leader", "member", "applicant"] as const;
export type ReviewRole = typeof REVIEW_ROLES[number];
export const reviewIdentity = (digest: string, role: ReviewRole) => `review:${digest}:${role}`;

function mondayInChina(now: number): string {
  const date = new Date(now + 8 * 3600000);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

/** Small, isolated V2 sample. Each authenticated WeChat identity gets its own copy. */
export function makeReviewSeed(digest: string, uuid: string, now: number, maxExecutionMs: number): ReviewSnapshot {
  const epoch = `review-${uuid}`, semesterId = "review-semester", monday = mondayInChina(now);
  const entity = (id: string, data: Record<string, unknown>, extra: Partial<Entity> = {}): Entity => ({ id, epoch, version: 1, data, ...extra });
  const classA = entity("review-class-a", { name: "审核样例·计算机1班", grade: "26", major: "计算机", active: true });
  const classB = entity("review-class-b", { name: "审核样例·软件2班", grade: "26", major: "软件工程", active: true });
  const admin = entity("review-admin", { name: "样例管理员", studentNo: "REVIEW-A", classId: classA.id, role: "admin", active: true }, { studentNo: "REVIEW-A" });
  const leader = entity("review-leader", { name: "样例组部长", studentNo: "REVIEW-L", classId: classB.id, role: "leader", active: true }, { studentNo: "REVIEW-L" });
  const member = entity("review-member", { name: "样例成员", studentNo: "REVIEW-M", classId: classA.id, role: "member", active: true }, { studentNo: "REVIEW-M" });
  const courseA = { id: "review-course-a", name: "样例高等数学", teacher: "样例教师甲", nature: "必修", classIds: [classA.id], weekday: 1, start: 1, end: 2, classroom: "样例楼101", weeks: [1,2,3,4], expected: 30 };
  const courseB = { ...courseA, id: "review-course-b", name: "样例程序设计", teacher: "样例教师乙", classIds: [classB.id], start: 3, end: 4, classroom: "样例楼202", expected: 32 };
  const classInfo = (klass: Entity) => ({ id: klass.id, ...klass.data });
  const occurrence = (id: string, course: typeof courseA, klass: Entity, week: number) => entity(id, { course, classes: [classInfo(klass)], classLabel: String(klass.data.name), status: "active", date: new Date(Date.parse(monday + "T00:00:00Z") + (week - 1) * 7 * 86400000).toISOString().slice(0,10) }, { semesterId, week, date: new Date(Date.parse(monday + "T00:00:00Z") + (week - 1) * 7 * 86400000).toISOString().slice(0,10) });
  const occA1 = occurrence("review-occ-a1", courseA, classA, 1), occB1 = occurrence("review-occ-b1", courseB, classB, 1);
  const occA2 = occurrence("review-occ-a2", courseA, classA, 2), occB2 = occurrence("review-occ-b2", courseB, classB, 2);
  const plan = entity("review-plan-1", { status: "confirmed", reason: "审核样例安排", uncovered: [] }, { semesterId, week: 1 });
  const task = (id: string, occurrence: Entity, person: Entity, status: string) => entity(id, { occurrenceId: occurrence.id, course: occurrence.data.course, classes: occurrence.data.classes, classLabel: occurrence.data.classLabel, date: occurrence.date, memberId: person.id, memberName: person.data.name, status }, { semesterId, week: 1, memberId: person.id, parentId: plan.id });
  const memberTask = task("review-task-open", occB1, member, "confirmed"), leaderTask = task("review-task-done", occA1, leader, "submitted");
  const samplePhoto = entity("review-photo-sample", { storageId: "review-sample-photo", createdAt: new Date(now).toISOString() }, { semesterId, memberId: leader.id, taskId: leaderTask.id, recordId: "review-record" });
  const recordData = { memberName: leader.data.name, classLabel: classA.data.name, classes: occA1.data.classes, course: courseA, date: occA1.date, metrics: { expected: 30, actual: 28, late: 1, early: 0, sleep: 0, phone: 1, talk: 0, other: 0 }, absentNames: "样例同学甲", leaveNames: "无", evaluation: "样例课堂秩序良好", feedback: "审核演示资料", suggestion: "", otherDescription: "", photos: [samplePhoto.id], firstSubmittedAt: new Date(now).toISOString(), revision: 1 };
  const record = entity("review-record", recordData, { semesterId, week: 1, memberId: leader.id, taskId: leaderTask.id });
  const rows: ReviewSnapshot["rows"] = {
    classes: [classA, classB], members: [admin, leader, member],
    bindings: (["admin", "leader", "member"] as const).map((role, index) => entity(`review-binding-${role}`, {}, { identityKey: reviewIdentity(digest, role), memberId: [admin, leader, member][index].id })),
    semesters: [entity(semesterId, { name: "审核样例学期", startDate: monday, weeks: 4, days: 5, periods: 14, grades: ["26"], edition: "审核样例", status: "active" })],
    semester_classes: [entity("review-link-a", {}, { semesterId, parentId: classA.id }), entity("review-link-b", {}, { semesterId, parentId: classB.id })],
    courses: [entity(courseA.id, { name: courseA.name, course: courseA, active: true }, { semesterId }), entity(courseB.id, { name: courseB.name, course: courseB, active: true }, { semesterId })],
    occurrences: [occA1, occB1, occA2, occB2], plans: [plan], tasks: [memberTask, leaderTask],
    availability: [entity("review-member-available", { slots: ["1:3", "1:4"], optedIn: true, note: "审核样例" }, { semesterId, week: 2, memberId: member.id }), entity("review-leader-available", { slots: ["1:1", "1:2"], optedIn: true, note: "审核样例" }, { semesterId, week: 2, memberId: leader.id })],
    records: [record], record_versions: [entity("review-version", { ...recordData, recordVersion: 1 }, { semesterId, week: 1, memberId: leader.id, taskId: leaderTask.id, recordId: record.id })], photos: [samplePhoto],
    applications: [entity("review-application", { name: "样例申请人", studentNo: "REVIEW-N", classId: classB.id, classLabel: classB.data.name, status: "pending", createdAt: new Date(now).toISOString() }, { identityKey: `review:${digest}:pending`, studentNo: "REVIEW-N" })],
  };
  return { workspace: { id: "review", epoch, version: 1, permissionsVersion: 1, protocolVersion: 2, activeSemesterId: semesterId, maintenance: "", maxExecutionMs }, rows };
}
