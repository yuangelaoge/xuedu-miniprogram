import { AppState } from "../domain/types";
import { runtime } from "../config/runtime";

export interface CloudSnapshot {
  stage: "trial" | "production";
  epoch: string;
  version: number;
  identity: string;
  state: AppState;
}
let snapshot: CloudSnapshot | undefined;
const retiredEpochs = new Set<string>();
let loading: Promise<CloudSnapshot> | undefined;

export async function cloudCall<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  void operation; void payload;
  throw new Error("请更新小程序：旧版云端接口已停用");
}
export function acceptSnapshot(next: CloudSnapshot): CloudSnapshot {
  if (runtime.mode !== "cloud" || next.stage !== "trial") throw new Error("连接的环境与版本不符，已阻止混用试用和正式数据");
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
