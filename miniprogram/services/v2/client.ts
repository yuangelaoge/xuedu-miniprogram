import { runtime } from "../../config/runtime";
import { PHOTO_REQUEST_BYTES, jsonBytes, photoBytes } from "../../domain/photo-limits";
import { ApiRequest, ApiResponse, Entity, Workspace } from "../../domain/v2/protocol";
import { PageData, PageLoadRequest, WeekData } from "../../domain/v2/page-data";
export { WeekData } from "../../domain/v2/page-data";
export interface Boot {
  page?: PageData | null;
  readPath?: "single-rpc";
  home?: { semester: Entity | null; week: number; weekData: WeekData | null; summary?: {taskCount:number;recordCount:number;coverage:number} };
  workspace: Workspace; member: Entity | null; application?: Entity | null;
  status: "needsAdministrator" | "preparing" | "ready";
  canInitialize: boolean; removed?: boolean;
}
let boot: Boot | undefined;
let initializedEnv = "";
let epoch = "";
let generation = 0;
let workspaceVersion = -1;
let sessionReset = 0;
let bootstrapTail: Promise<void> | undefined;
const pendingBootstraps = new Map<string, Promise<Boot>>();
let pageRevision = 0;
interface ScheduleFocus { semesterId: string; week: number; scope: string; }
let pendingScheduleFocus: ScheduleFocus | undefined;
const scheduleScope = () => [runtime.env, reviewActive(), generation, boot?.workspace.epoch,
  boot?.workspace.permissionsVersion, boot?.member?.id].join(":");
// switchTab cannot carry query parameters. Keep one explicit selection in this session only.
export function queueScheduleFocus(semesterId: string, week: number): () => void {
  if (!boot?.member || !semesterId || !Number.isInteger(week) || week < 1) return () => {};
  const focus = {semesterId, week, scope:scheduleScope()};
  pendingScheduleFocus = focus;
  return () => { if (pendingScheduleFocus === focus) pendingScheduleFocus = undefined; };
}
export function takeScheduleFocus(): ScheduleFocus | undefined {
  const focus = pendingScheduleFocus;
  pendingScheduleFocus = undefined;
  return focus?.scope === scheduleScope() ? focus : undefined;
}
// Page instances can briefly reuse rendered data; writes and rejected reads invalidate them.
export function pageFreshnessKey(): string {
  return [runtime.env, reviewActive(), generation, pageRevision, workspaceVersion, boot?.workspace.permissionsVersion, boot?.member?.id].join(":");
}
const reviewKey = () => "xuedu.review.active." + runtime.env;
export function reviewActive(): boolean { return runtime.mode === "cloud" && wx.getStorageSync(reviewKey()) === true; }
function resetCloudSession(): void {
  boot=undefined; epoch=""; generation++; sessionReset++; pageRevision++; workspaceVersion=-1;
  bootstrapTail=undefined; pendingBootstraps.clear();
}
function ensureCloudSession(): void {
  if (runtime.mode !== "cloud" || !runtime.env) throw new Error("云端环境未配置");
  if (initializedEnv !== runtime.env) {
    wx.cloud.init({env:runtime.env,traceUser:false}); initializedEnv=runtime.env; resetCloudSession();
  }
}
// Queue only completion, never another page's result: a failed page must not reject
// unrelated reads. Each caller keeps its own error and verifies its own server response.
function enqueueBootstrap(key: string, load: () => Promise<Boot>): Promise<Boot> {
  ensureCloudSession();
  const existing = pendingBootstraps.get(key);
  if (existing) return existing;
  const reset = sessionReset, env = runtime.env, review = reviewActive();
  const assertSession = () => {
    if (reset !== sessionReset || env !== runtime.env || review !== reviewActive())
      throw new Error("身份或环境已变化，请刷新后重试");
  };
  const run = async () => {
    assertSession();
    const result = await load();
    assertSession();
    boot = result;
    return result;
  };
  const pending = bootstrapTail ? bootstrapTail.then(run) : run();
  pendingBootstraps.set(key, pending);
  const finish = () => {
    if (pendingBootstraps.get(key) === pending) pendingBootstraps.delete(key);
    if (bootstrapTail === settled) bootstrapTail = undefined;
  };
  // The rejection is still returned through `pending`; this barrier releases the next read.
  const settled = pending.then(finish, finish);
  bootstrapTail = settled;
  return pending;
}
export function leaveReviewLocally(): void { wx.removeStorageSync(reviewKey()); resetCloudSession(); }
export async function reviewControl(operation: "reviewLogin" | "reviewStatus" | "reviewRole" | "reviewLogout", payload: Record<string,unknown> = {}): Promise<{role?:string;expiresAt?:string;ended?:boolean}> {
  ensureCloudSession();
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
  ensureCloudSession();
  const startedGeneration = generation;
  if (!["bootstrap", "query", "photoUrls", "clearPreview"].includes(operation)) pageRevision++;
  const page = options.payload?.page as PageLoadRequest | undefined;
  const readHint = boot?.member ? { memberId: boot.member.id, semesterId: options.semesterId || page?.semesterId || boot.workspace.activeSemesterId } : undefined;
  const data = { protocolVersion: 2, operation, epoch: epoch || undefined, readHint, review: reviewActive(), ...options,
    clientCapabilities: {recordTextSharing:true} };
  const photoOperation = operation === 'photo' || operation === 'photoFile';
  const requestBytes = photoOperation ? jsonBytes(data) : 0;
  if (requestBytes > PHOTO_REQUEST_BYTES) throw new Error('照片传输数据过大，请重新添加照片以使用文件传输');
  const response = await wx.cloud.callFunction({ name: runtime.functionName, data }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String((error as {errMsg?:string})?.errMsg || error);
    if (photoOperation && /data exceed max size/i.test(message)) {
      const bytes = operation === 'photoFile' ? Number(options.payload?.bytes || 0) : typeof options.payload?.base64 === 'string' ? photoBytes(options.payload.base64) : 0;
      throw new Error(`微信拒绝了照片上传请求（图片${Math.ceil(bytes/1024)}KB，请求${Math.ceil(requestBytes/1024)}KB）。请保留原图并反馈此提示，未提交听课记录。`);
    }
    throw error;
  });
  if (startedGeneration !== generation) throw new Error("业务数据轮次已变化，请刷新后重试");
  const result = response.result as unknown as { ok: boolean; data?: ApiResponse<T>; error?: string; code?: string };
  if (operation === 'photoFile' && result?.code === 'UPGRADE_REQUIRED') throw new Error('云端照片上传服务尚未更新，请联系管理员，暂未提交听课记录');
  if (!result?.ok || !result.data) { pageRevision++; if (result?.code === "REVIEW_EXPIRED" && reviewActive()) leaveReviewLocally(); throw new Error(result?.error || "云端请求失败，请刷新重试"); }
  if (result.data.protocolVersion !== 2) throw new Error("请更新小程序，云端协议不匹配");
  if (epoch && epoch !== result.data.epoch && operation !== "bootstrap" && operation !== "clearStep") throw new Error("业务数据轮次已变化，请刷新后重试");
  if (epoch !== result.data.epoch) { if (epoch && boot) { wx.removeStorageSync(viewKey()); } generation++; workspaceVersion = -1; }
  const nextVersion = result.data.resourceVersions?.workspace;
  if (typeof nextVersion !== "number" || nextVersion < workspaceVersion) throw new Error("数据版本已变化，请刷新后重试");
  workspaceVersion = nextVersion;
  epoch = result.data.epoch;
  return result.data;
}
export async function bootstrap(includeHome = false): Promise<Boot> {
  ensureCloudSession();
  return enqueueBootstrap(includeHome ? "home" : "bootstrap", async () =>
    (await call<Boot>("bootstrap", includeHome ? {payload:{includeHome:true,fastPage:true}} : {})).data);
}
export async function pageBootstrap(request: PageLoadRequest): Promise<Boot> {
  ensureCloudSession();
  const usesView = !["availability", "profile", "join"].includes(request.view);
  const selected = request.semesterId || (usesView && boot ? viewSemester() : "");
  const selectionOwner = request.selectionOwner || (!request.semesterId ? boot?.member?.id : "");
  const scoped = {...request,semesterId:selected,selectionOwner};
  const key = JSON.stringify([request.view,request.section,selected,selectionOwner,request.week,
    request.targetId,request.cursor,request.more,pageRevision]);
  const result = await enqueueBootstrap(key, async () =>
    (await call<Boot>("bootstrap", {payload:{fastPage:true,page:scoped}})).data);
  // A cold deep link may have a saved historical semester keyed to the newly verified identity.
  if (!selected && usesView && result.member && result.page) {
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
export function selectSemester(id: string): void { wx.setStorageSync(viewKey(), id); pageRevision++; }
export function resetView(): void { wx.removeStorageSync(viewKey()); pageRevision++; }
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
