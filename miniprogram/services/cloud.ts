import { AppState } from "../domain/types";
import { runtime } from "../config/runtime";

export interface CloudSnapshot {
  stage: "trial" | "production";
  epoch: string;
  version: number;
  identity: string;
  state: AppState;
}
let initialized = false;
let snapshot: CloudSnapshot | undefined;
const retiredEpochs = new Set<string>();
let loading: Promise<CloudSnapshot> | undefined;

export async function cloudCall<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!runtime.env || runtime.mode === "demo") throw new Error("尚未配置微信云开发环境，请联系管理员");
  if (!initialized) {
    wx.cloud.init({ env: runtime.env, traceUser: false });
    initialized = true;
  }
  const response = await wx.cloud.callFunction({ name: runtime.functionName, data: { operation, ...payload } });
  const result = response.result as unknown as { ok: boolean; data?: T; error?: string };
  if (!result?.ok) throw new Error(result?.error || "云端请求失败，请稍后刷新重试");
  return result.data as T;
}
export function acceptSnapshot(next: CloudSnapshot): CloudSnapshot {
  if (next.stage !== runtime.mode) throw new Error("连接的环境与版本不符，已阻止混用试用和正式数据");
  if (snapshot && retiredEpochs.has(next.epoch)) return snapshot;
  if (snapshot && snapshot.epoch === next.epoch && snapshot.version > next.version) return snapshot;
  if (snapshot && snapshot.epoch !== next.epoch) retiredEpochs.add(snapshot.epoch);
  snapshot = next;
  return next;
}
export function currentSnapshot(): CloudSnapshot {
  if (!snapshot) throw new Error("尚未连接云端，请稍后重试");
  return snapshot;
}
export function syncCloud(): Promise<CloudSnapshot> {
  if (!loading) {
    loading = cloudCall<CloudSnapshot>("snapshot").then(acceptSnapshot).finally(() => { loading = undefined; });
  }
  return loading;
}
export function requestId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}
