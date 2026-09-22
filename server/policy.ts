import { AppState } from "../miniprogram/domain/types";
import { createSeed } from "../miniprogram/domain/seed";
import { membershipFor } from "../miniprogram/domain/membership";

// 试用只复用明确标注的课程配置，不导入任何演示人物、任务、申请、记录。
export function initialState(stage: "trial" | "production"): AppState {
  const seed = createSeed();
  return { ...seed, actorId: "", members: [], applications: [], availability: [], plans: [], drafts: [], records: [], audit: [], generation: 0,
    courses: stage === "trial" ? seed.courses : [], classes: stage === "trial" ? seed.classes : [],
  };
}
export function visibleState(state: AppState, openid: string): AppState {
  const result = JSON.parse(JSON.stringify(state)) as AppState;
  const user = membershipFor(result, openid);
  result.actorId = user?.active ? user.id : "";
  const manager = !!user?.active && user.role !== "member";
  if (!user?.active) {
    result.members = user ? [user] : [];
    result.applications = result.applications.filter(a => a.identityKey === openid);
    result.courses = []; result.availability = []; result.plans = []; result.drafts = []; result.records = []; result.audit = [];
  } else if (!manager) {
    result.applications = result.applications.filter(a => a.identityKey === openid);
    result.availability = result.availability.filter(a => a.memberId === user.id);
    result.drafts = []; result.audit = [];
    result.members.forEach(m => { if (m.id !== user.id) m.studentNo = ""; });
    result.records.forEach(r => {
      if (r.memberId !== user.id) {
        r.photos = []; r.absentNames = ""; r.leaveNames = ""; r.feedback = ""; r.suggestion = ""; r.evaluation = ""; r.otherDescription = "";
      }
    });
  }
  // 不向其他成员或管理端暴露别人的微信标识。
  result.members.forEach(m => { m.identityKey = m.identityKey === openid ? "self" : undefined; });
  result.applications.forEach(a => { a.identityKey = a.identityKey === openid ? "self" : ""; });
  return result;
}
export function clearTrialPeople(state: AppState): AppState {
  return { ...state, actorId: "", members: state.members.filter(m => m.role === "admin" && m.active), applications: [], availability: [], plans: [], drafts: [], records: [], audit: [], generation: 0 };
}
export function emptyWorkspace(): AppState {
  return { schema: 1, activeSemesterId: "", actorId: "", semesters: [], classes: [], members: [], applications: [], courses: [], availability: [], plans: [], drafts: [], records: [], audit: [], generation: 0 };
}
