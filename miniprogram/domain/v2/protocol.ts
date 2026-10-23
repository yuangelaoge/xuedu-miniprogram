export const PROTOCOL_VERSION = 2 as const;
export const CLEAR_CONFIRMATION = "清空业务数据，保留管理员及其班级";
export type Resource = "members" | "bindings" | "applications" | "classes" | "semesters" | "semester_classes" | "courses" | "course_versions" | "occurrences" | "exceptions" | "availability" | "plans" | "tasks" | "records" | "record_versions" | "photos" | "audit" | "requests" | "maintenance" | "rebindings";
export const RESOURCES: Resource[] = ["members", "bindings", "applications", "classes", "semesters", "semester_classes", "courses", "course_versions", "occurrences", "exceptions", "availability", "plans", "tasks", "records", "record_versions", "photos", "audit", "requests", "maintenance", "rebindings"];
export interface Entity<T = Record<string, unknown>> {
  id: string; epoch: string; version: number; data: T;
  semesterId?: string; week?: number; memberId?: string; taskId?: string;
  recordId?: string; parentId?: string; identityKey?: string; studentNo?: string;
  date?: string; sortKey?: string;
}
export interface AutoApproval { enabled: boolean; expiresAt: string; updatedBy: string; updatedByName: string; updatedAt: string; }
export interface Workspace {
  id: string; epoch: string; version: number; permissionsVersion: number;
  protocolVersion: 2; activeSemesterId: string; maintenance: string;
  maxExecutionMs: number; autoApproval?: AutoApproval | null;
}
export type FilterKey = "status" | "id" | "epoch" | "semesterId" | "week" | "memberId" | "taskId" | "recordId" | "parentId" | "identityKey" | "studentNo" | "date" | "sortKey";
export interface Query {
  eq?: Partial<Record<FilterKey, string | number>>;
  in?: Partial<Record<FilterKey, (string | number)[]>>;
  after?: string; limit?: number;
  dateFrom?: string; dateTo?: string;
}
export interface PageResult<T = Entity> { items: T[]; cursor: string; }
export interface ReadVersion { resource: Resource; id: string; version: number; }
export interface Change { resource: Resource; id: string; expectedVersion: number; value: Omit<Entity, "version"> | null; }
export interface Commit {
  epoch: string; workspaceVersion: number; permissionsVersion: number;
  identityKey: string; actorId: string; requestId: string;
  reads: ReadVersion[]; changes: Change[];
  workspace?: Partial<Pick<Workspace, "activeSemesterId" | "maintenance" | "epoch" | "maxExecutionMs" | "autoApproval">>;
  autoJoin?: boolean; initialize?: boolean; maintenanceId?: string;
  result: Record<string, unknown>;
}
export interface ApiRequest {
  /** UI compatibility only; never grants a role or photo access. Omitted by legacy clients. */
  clientCapabilities?: { recordTextSharing?: boolean };
  /** Read-ahead hints only; the server still verifies the live WeChat binding and role. */
  readHint?: { memberId?: string; semesterId?: string };
  protocolVersion: 2; operation: string; epoch?: string; semesterId?: string;
  expectedVersion?: number; requestId?: string; cursor?: string; limit?: number;
  payload?: Record<string, unknown>;
}
export interface ApiResponse<T = Record<string, unknown>> {
  protocolVersion: 2; epoch: string; resourceVersions: Record<string, number>;
  data: T; cursor?: string;
}
