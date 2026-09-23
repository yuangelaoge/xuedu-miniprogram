import { runtime } from "../../config/runtime";
import { ApiRequest, ApiResponse, Entity, Workspace } from "../../domain/v2/protocol";
export interface Boot {
  workspace: Workspace; member: Entity | null; application?: Entity | null;
  status: "needsAdministrator" | "preparing" | "ready";
  canInitialize: boolean; removed?: boolean;
}
let boot: Boot | undefined;
let initializedEnv = "";
let epoch = "";
let generation = 0;
let workspaceVersion = -1;
let bootstrapPending: Promise<Boot> | undefined;
export function currentBoot(): Boot {
  if (!boot) throw new Error("请先连接云端");
  return boot;
}
export function requestId(): string { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2); }
export async function call<T = Record<string, unknown>>(operation: string, options: Omit<Partial<ApiRequest>, "operation" | "protocolVersion"> = {}): Promise<ApiResponse<T>> {
  if (runtime.mode !== "cloud" || !runtime.env) throw new Error("云端环境未配置");
  if (initializedEnv !== runtime.env) { wx.cloud.init({ env: runtime.env, traceUser: false }); initializedEnv = runtime.env; boot = undefined; epoch = ""; generation++; workspaceVersion = -1; }
  const startedGeneration = generation;
  const response = await wx.cloud.callFunction({ name: runtime.functionName, data: { protocolVersion: 2, operation, epoch: epoch || undefined, ...options } });
  const result = response.result as unknown as { ok: boolean; data?: ApiResponse<T>; error?: string };
  if (!result?.ok || !result.data) throw new Error(result?.error || "云端请求失败，请刷新重试");
  if (result.data.protocolVersion !== 2) throw new Error("请更新小程序，云端协议不匹配");
  if (startedGeneration !== generation) throw new Error("业务数据轮次已变化，请刷新后重试");
  if (epoch && epoch !== result.data.epoch && operation !== "bootstrap" && operation !== "clearStep") throw new Error("业务数据轮次已变化，请刷新后重试");
  if (epoch !== result.data.epoch) { if (epoch && boot) { wx.removeStorageSync(viewKey()); } generation++; workspaceVersion = -1; }
  const nextVersion = result.data.resourceVersions?.workspace;
  if (typeof nextVersion !== "number" || nextVersion < workspaceVersion) throw new Error("数据版本已变化，请刷新后重试");
  workspaceVersion = nextVersion;
  epoch = result.data.epoch;
  return result.data;
}
export async function bootstrap(): Promise<Boot> {
  if (!bootstrapPending) bootstrapPending = call<Boot>("bootstrap").then(response => { boot = response.data; return boot; }).finally(() => { bootstrapPending = undefined; });
  return bootstrapPending;
}
function viewKey(): string { return "xuedu.view." + runtime.env + "." + (currentBoot().member?.id || "visitor"); }
export function viewSemester(): string {
  const saved = wx.getStorageSync(viewKey());
  return typeof saved === "string" && saved ? saved : currentBoot().workspace.activeSemesterId;
}
export function selectSemester(id: string): void { wx.setStorageSync(viewKey(), id); }
export function resetView(): void { wx.removeStorageSync(viewKey()); }
export async function query<T = { items: Entity[] }>(kind: string, semesterId = "", payload: Record<string, unknown> = {}, cursor = "", limit = 50): Promise<ApiResponse<T>> {
  return call<T>("query", { semesterId: semesterId || undefined, payload: { kind, ...payload }, cursor: cursor || undefined, limit });
}
export async function command(type: string, payload: Record<string, unknown>, semesterId = "", expectedVersion = 0): Promise<ApiResponse> {
  return call("command", { semesterId: semesterId || undefined, expectedVersion, requestId: requestId(), payload: { type, ...payload } });
}
export function clearLocalDrafts(): void {
  const prefix = "xuedu.form." + runtime.env + ".cloud.";
  for (const key of wx.getStorageInfoSync().keys) if (key.startsWith(prefix)) wx.removeStorageSync(key);
  resetView();
}
export function draftKey(taskId: string): string { return "xuedu.form." + runtime.env + ".cloud." + epoch + "." + (boot?.member?.id || "") + "." + taskId; }
