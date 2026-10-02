export type Role = "admin" | "leader" | "member" | "officer";
export interface Semester {
  id: string;
  name: string;
  startDate: string;
  weeks: number;
  grades: string[];
  days: number;
  periods: number;
  edition: string;
}
export interface SchoolClass {
  id: string;
  grade: string;
  major: string;
  name: string;
}
export interface Member {
  id: string;
  name: string;
  studentNo: string;
  classId: string;
  role: Role;
  active: boolean;
  identityKey?: string;
  removedAt?: string;
}
export interface JoinApplication {
  id: string;
  identityKey: string;
  name: string;
  studentNo: string;
  classId: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reason?: string;
  memberId?: string;
}
export interface Course {
  id: string;
  semesterId: string;
  name: string;
  teacher: string;
  nature: string;
  classIds: string[];
  classroom: string;
  weekday: number;
  start: number;
  end: number;
  weeks: number[];
  expected: number;
}
export interface Availability {
  semesterId: string;
  week: number;
  memberId: string;
  slots: string[];
  note: string;
  optedIn: boolean;
  updatedAt: string;
}
export interface Task {
  id: string;
  memberId: string;
  memberName: string;
  course: Course;
  classLabel: string;
}
export interface Plan {
  semesterId: string;
  week: number;
  revision: number;
  status: "draft" | "confirmed" | "skipped";
  tasks: Task[];
  cancelledTasks?: Task[];
  uncovered: { label: string; reason: string }[];
  createdAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
  reason?: string;
}
export type MetricKey =
  | "expected"
  | "actual"
  | "late"
  | "early"
  | "sleep"
  | "phone"
  | "talk"
  | "other";
export type Metrics = Record<MetricKey, number>;
export interface Observation {
  correctedAt?: string;
  firstSubmittedAt?: string;
  classes?: SchoolClass[];
  id: string;
  taskId: string;
  semesterId: string;
  week: number;
  memberId: string;
  memberName: string;
  course: Course;
  classLabel: string;
  date: string;
  metrics: Metrics;
  absentNames: string;
  leaveNames: string;
  otherDescription: string;
  evaluation: string;
  feedback: string;
  suggestion: string;
  photos: string[];
  createdAt: string;
}
export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}
export interface AppState {
  schema: 1;
  activeSemesterId: string;
  actorId: string;
  semesters: Semester[];
  classes: SchoolClass[];
  members: Member[];
  applications: JoinApplication[];
  courses: Course[];
  availability: Availability[];
  plans: Plan[];
  drafts: Plan[];
  records: Observation[];
  audit: AuditEntry[];
  generation: number;
}
export interface UiEvent {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
}
export const ROLE_NAMES: Record<Role, string> = {
  officer: "信息部干事",
  admin: "管理员",
  leader: "组部长",
  member: "普通成员",
};
export const METRIC_FIELDS: { key: MetricKey; label: string }[] = [
  { key: "expected", label: "应到人数" },
  { key: "actual", label: "实到人数" },
  { key: "late", label: "迟到" },
  { key: "early", label: "早退" },
  { key: "sleep", label: "睡觉" },
  { key: "phone", label: "玩手机" },
  { key: "talk", label: "说话" },
  { key: "other", label: "其他情况" },
];
