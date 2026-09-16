import { AppState, Plan } from "../domain/types";
import { createSeed } from "../domain/seed";
import { actor } from "../domain/actions";
import { boundedWeek } from "../domain/calendar";
const STORAGE_KEY = "xuedu.demo.v1";
// 单设备演示适配层，不是服务器鉴权。正式版需替换为服务端 API。
export function readState(): AppState {
  const saved = wx.getStorageSync(STORAGE_KEY) as AppState | undefined;
  if (saved && saved.schema === 1) return { ...saved, applications: saved.applications || [] };
  const initial = createSeed();
  wx.setStorageSync(STORAGE_KEY, initial);
  return initial;
}
export function transact(action: (state: AppState) => void): AppState {
  const next = JSON.parse(JSON.stringify(readState())) as AppState;
  action(next);
  wx.setStorageSync(STORAGE_KEY, next);
  return next;
}
export function context() {
  const state = readState(),
    user = actor(state),
    semester = state.semesters.find((s) => s.id === state.activeSemesterId)!;
  return {
    state,
    user,
    semester,
    week: boundedWeek(semester),
    manager: user.role !== "member",
  };
}
export function published(state: AppState, week: number): Plan | undefined {
  return state.plans.find(
    (p) => p.semesterId === state.activeSemesterId && p.week === week,
  );
}
export function notifyError(error: unknown): void {
  console.warn(
    "业务校验未通过",
    error instanceof Error ? error.message : "操作失败",
  );
  wx.showModal({
    title: "暂时无法完成",
    content: error instanceof Error ? error.message : "操作失败，请重试",
    showCancel: false,
  });
}
export function run(action: () => void, message = ""): boolean {
  try {
    action();
    if (message) wx.showToast({ title: message, icon: "success" });
    return true;
  } catch (error) {
    notifyError(error);
    return false;
  }
}
export function changeDemoActor(id: string): void {
  transact((state) => {
    if (!state.members.some((m) => m.id === id && m.active))
      throw new Error("体验身份不可用");
    state.actorId = id;
  });
}
