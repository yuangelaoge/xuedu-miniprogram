import { runtime } from "../../config/runtime";
import { ApiRequest, ApiResponse, Entity, Workspace } from "../../domain/v2/protocol";
import { PageData, PageLoadRequest, WeekData } from "../../domain/v2/page-data";
export { WeekData } from "../../domain/v2/page-data";
export interface Boot {
  page?: PageData | null;
  home?: { semester: Entity | null; week: number; weekData: WeekData | null };
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
let bootstrapIncludesHome = false;
let pageBootstrapPending: Promise<Boot> | undefined;
const reviewKey = () => "xuedu.review.active." + runtime.env;
export function reviewActive(): boolean { return runtime.mode === "cloud" && wx.getStorageSync(reviewKey()) === true; }
function resetCloudSession(): void { boot=undefined; epoch=""; generation++; workspaceVersion=-1; bootstrapPending=undefined; pageBootstrapPending=undefined; }
export function leaveReviewLocally(): void { wx.removeStorageSync(reviewKey()); resetCloudSession(); }
export async function reviewControl(operation: "reviewLogin" | "reviewStatus" | "reviewRole" | "reviewLogout", payload: Record<string,unknown> = {}): Promise<{role?:string;expiresAt?:string;ended?:boolean}> {
  if (runtime.mode !== "cloud" || !runtime.env) throw new Error("云端环境未配置");
  if (initializedEnv !== runtime.env) { wx.cloud.init({env:runtime.env,traceUser:false}); initializedEnv=runtime.env; resetCloudSession(); }
  const result = (await wx.cloud.callFunction({name:runtime.functionName,data:{protocolVersion:2,operation,review:true,payload}})).result as unknown as {ok:boolean;data?:ApiResponse<{role?:string;expiresAt?:string;ended?:boolean}>;error?:string};
  if (!result?.ok || result.data?.protocolVersion !== 2) throw new Error(result?.error || "审核体验暂时不可用");
  if (operation === "reviewLogin") wx.setStorageSync(reviewKey(),true);
  if (operation === "reviewLogin" || operation === "reviewRole") resetCloudSession();
  if (operation === "reviewLogout") leaveReviewLocally();
  return result.data.data;
}
export function currentBoot(): Boot {
  if (!boot) throw new Error("请先连接云端");
  return boot;
}
export function requestId(): string { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2); }
export async function call<T = Record<string, unknown>>(operation: string, options: Omit<Partial<ApiRequest>, "operation" | "protocolVersion"> = {}): Promise<ApiResponse<T>> {
  if (runtime.mode !== "cloud" || !runtime.env) throw new Error("云端环境未配置");
  if (initializedEnv !== runtime.env) { wx.cloud.init({ env: runtime.env, traceUser: false }); initializedEnv = runtime.env; boot = undefined; epoch = ""; generation++; workspaceVersion = -1; }
  const startedGeneration = generation;
  const response = await wx.cloud.callFunction({ name: runtime.functionName, data: { protocolVersion: 2, operation, epoch: epoch || undefined, review: reviewActive(), ...options } });
  const result = response.result as unknown as { ok: boolean; data?: ApiResponse<T>; error?: string; code?: string };
  if (!result?.ok || !result.data) { if (result?.code === "REVIEW_EXPIRED" && reviewActive()) leaveReviewLocally(); throw new Error(result?.error || "云端请求失败，请刷新重试"); }
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
export async function bootstrap(includeHome = false): Promise<Boot> {
  if (pageBootstrapPending) { const pending = await pageBootstrapPending; if (!includeHome) return pending; }
  // A basic request already in flight cannot satisfy the richer home request.
  if (bootstrapPending && includeHome && !bootstrapIncludesHome) {
    await bootstrapPending;
    return bootstrap(true);
  }
  if (!bootstrapPending) {
    bootstrapIncludesHome = includeHome;
    bootstrapPending = call<Boot>("bootstrap", includeHome ? { payload: { includeHome: true } } : {}).then(response => { boot = response.data; return boot; }).finally(() => { bootstrapPending = undefined; });
  }
  return bootstrapPending;
}
export async function pageBootstrap(request: PageLoadRequest): Promise<Boot> {
  // Establish the session once before another page can send a request with an old epoch.
  if (bootstrapPending) await bootstrapPending;
  if (pageBootstrapPending) await pageBootstrapPending;
  const previous = initializedEnv === runtime.env ? boot : undefined;
  const usesView = !["availability", "profile", "join"].includes(request.view);
  const selected = request.semesterId || (usesView && previous ? viewSemester() : "");
  const selectionOwner = request.selectionOwner || (!request.semesterId ? previous?.member?.id : "");
  const pending = call<Boot>("bootstrap", {payload:{page:{...request,semesterId:selected,selectionOwner}}}).then(response => { boot = response.data; return boot; });
  pageBootstrapPending = pending;
  let result: Boot;
  try { result = await pending; }
  finally { if (pageBootstrapPending === pending) pageBootstrapPending = undefined; }
  // A cold deep link may have a saved historical semester keyed to the newly verified identity.
  if (!previous && !request.semesterId && usesView && result.member && result.page) {
    const saved = viewSemester();
    if (saved && saved !== result.page.semester?.id) return pageBootstrap({...request,semesterId:saved,selectionOwner:result.member.id});
  }
  return result;
}
function viewKey(): string { return "xuedu.view." + runtime.env + (reviewActive() ? ".review." : ".") + (currentBoot().member?.id || "visitor"); }
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
