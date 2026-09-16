import { readState, transact } from "./store";
import { applyForMembership, JoinForm, membershipFor } from "../domain/membership";
import { isCloud } from "../config/runtime";
import { currentSnapshot } from "./cloud";

// 仅用于本机双视角体验，不是 OpenID，不生成对外入组码。
export function demoIdentity(): string {
  if (isCloud()) return currentSnapshot().identity;
  const key = "xuedu.demo.applicant";
  let identity = wx.getStorageSync(key) as string;
  if (!identity) {
    identity = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    wx.setStorageSync(key, identity);
  }
  return identity;
}
export function startJoinDemo(): void {
  if (isCloud()) throw new Error("云端版本不允许切换演示身份");
  demoIdentity();
  transact(s => { s.actorId = ""; });
  wx.reLaunch({ url: "/pages/join/join" });
}
export function submitJoin(form: JoinForm): void {
  const identity = demoIdentity();
  transact(s => { applyForMembership(s, identity, form); });
}
export function enterAsApprovedApplicant(): boolean {
  const member = membershipFor(readState(), demoIdentity());
  if (!member?.active) return false;
  if (!isCloud()) transact(s => { s.actorId = member.id; });
  wx.reLaunch({ url: "/pages/index/index" });
  return true;
}
