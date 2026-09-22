import { readState, notifyError } from "./store";
import { isCloud, modeLabel, runtime } from "../config/runtime";
import { syncCloud } from "./cloud";
let redirecting = false;

export function ensureMember(route = ""): boolean {
  const state = readState();
  const user = state.members.find(m => m.id === state.actorId && m.active);
  if (user) {
    if (user.role === "admin" && !state.semesters.some(s => s.id === state.activeSemesterId) && route !== "pages/manage/manage") {
      if (!redirecting) {
        redirecting = true;
        wx.reLaunch({ url: "/pages/manage/manage?tab=semester", complete: () => { redirecting = false; } });
      }
      return false;
    }
    return true;
  }
  if (!redirecting) {
    redirecting = true;
    wx.reLaunch({ url: "/pages/join/join", complete: () => { redirecting = false; } });
  }
  return false;
}
// 体验版页面门禁。正式版仍须在每个服务端接口校验身份与权限。
export const memberPage: WechatMiniprogram.Page.Constructor = (options) => {
  const loads = new WeakMap<object, Promise<void>>();
  Page({
    ...options,
    data: { ...options.data, cloudMode: isCloud(), modeLabel: modeLabel(), trialMode: runtime.mode === "trial" },
    onLoad(query) {
      if (!isCloud()) { if (ensureMember(this.route)) options.onLoad?.call(this, query); return; }
      const load = syncCloud().then(() => { if (ensureMember(this.route)) options.onLoad?.call(this, query); }).catch(notifyError);
      loads.set(this, load);
    },
    onShow() {
      if (!isCloud()) { if (ensureMember(this.route)) options.onShow?.call(this); return; }
      void (async () => {
        await loads.get(this);
        await syncCloud();
        if (ensureMember(this.route)) options.onShow?.call(this);
      })().catch(notifyError);
    },
    onPullDownRefresh() {
      if (!isCloud()) { options.onShow?.call(this); wx.stopPullDownRefresh(); return; }
      void syncCloud().then(() => { if (ensureMember(this.route)) options.onShow?.call(this); }).catch(notifyError).finally(() => wx.stopPullDownRefresh());
    },
  });
};
