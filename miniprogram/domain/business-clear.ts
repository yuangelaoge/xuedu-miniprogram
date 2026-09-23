export const BUSINESS_CLEAR_CONFIRMATION = "清空业务数据，保留管理员";
export interface BusinessClearPreview {
  stage: "trial" | "production";
  epoch: string;
  version: number;
  jobId: string;
  administrators: number;
  members: number;
  applications: number;
  semesters: number;
  classes: number;
  courses: number;
  records: number;
  files: number;
}
