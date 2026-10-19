import { AutoApproval, Entity, PageResult } from './protocol';

export type LoadView = 'schedule' | 'records' | 'profile' | 'manage' | 'join' | 'record' | 'submission' | 'availability' | 'courses';
export interface PageLoadRequest {
  view: LoadView; section?: string; semesterId?: string; selectionOwner?: string;
  week?: number; targetId?: string; cursor?: string; more?: boolean;
}
export interface WeekData {
  gradeOptions?: string[];
  semester?: Entity; tasks: Entity[]; occurrences: Entity[]; records?: Entity[];
  plan?: Entity; draft?: Entity; availability?: Entity | null; uncovered?: { label: string; reason: string }[];
}
export interface AutoApprovalView {
  setting: AutoApproval | null; active: boolean; expired: boolean; version: number; serverNow: number;
}
export interface PageData {
  semester: Entity | null; week: number; semesters?: PageResult;
  list?: PageResult; classes?: PageResult; weekData?: WeekData;
  summary?: { total: number; submitted: number; skipped: boolean };
  profile?: { className: string; pendingCount: number };
  autoApproval?: AutoApprovalView;
  record?: { record: Entity; canEdit: boolean }; task?: Entity;
}
