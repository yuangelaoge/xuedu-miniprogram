import { ApiRequest, ApiResponse } from "../../domain/v2/protocol";
import { call, currentBoot, requestId } from "./client";

export function writeNeedsRefresh(error: unknown): boolean {
  return error instanceof Error && /权限|身份|轮次|未审核|未授权|资格|登录|FORBIDDEN|IDENTITY|UNAUTH|EPOCH|REVIEW_EXPIRED|VERSION_CONFLICT/.test(error.message + " " + String((error as Error & {code?:string}).code || ""));
}
export interface PendingWrite { original: ApiRequest; preview?: string; }
export function pendingWrite(key: string): PendingWrite | undefined {
  const value = wx.getStorageSync(key) as PendingWrite | undefined;
  if (!value) return undefined;
  if (!value.original || !value.original.requestId || !["photo","command"].includes(value.original.operation)) throw new Error("本机待确认操作损坏，请联系管理员核对记录");
  return value;
}
export function finishWrite(key: string): void { wx.removeStorageSync(key); }
/** Persist before dispatch; retain until the page durably saves photo IDs/clears its draft. */
export async function recoverableWrite<T = Record<string,unknown>>(key: string, create?: Omit<PendingWrite,"original"> & {original: Omit<ApiRequest,"protocolVersion"|"epoch"|"requestId">}): Promise<ApiResponse<T>> {
  let pending = pendingWrite(key);
  const resume = !!pending;
  if (!pending) {
    if (!create) throw new Error("没有待确认操作");
    pending = { ...create, original:{...create.original, payload:{...create.original.payload,writeOwnerId:currentBoot().member?.id}, protocolVersion:2,epoch:currentBoot().workspace.epoch,requestId:requestId()} };
    wx.setStorageSync(key,pending);
  }
  if (pending.original.epoch !== currentBoot().workspace.epoch) throw new Error("业务数据已变化，请重新打开页面");
  const original = pending.original;
  const resolve = () => call<T & {writeState?:string}>("resolveWrite",{epoch:original.epoch,payload:{original}});
  let result: ApiResponse<T & {writeState?:string}>;
  let failure: unknown;
  try {
    result = resume ? await resolve() : await call<T & {writeState?:string}>(original.operation,original);
  } catch (error) {
    failure = error;
    try { result = await resolve(); }
    catch (recoveryError) {
      if (writeNeedsRefresh(recoveryError)) throw recoveryError;
      throw new Error("暂时无法确认是否已保存，内容已留在本机。请再次点击原按钮确认，勿重复填写或换照片。"); }
  }
  if (result.data.writeState === "notCommitted") {
    finishWrite(key);
    throw new Error("已确认本次未保存，可重试。" + (failure instanceof Error ? failure.message : ""));
  }
  if (result.data.writeState !== "committed") throw new Error("服务端尚未支持结果确认，请保留本机内容并稍后重试");
  return result;
}
