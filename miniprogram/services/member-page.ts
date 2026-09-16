import { readState, notifyError } from "./store";
import { isCloud, modeLabel, runtime } from "../config/runtime";
import { syncCloud } from "./cloud";
let redirecting = false;

export function ensureMember(): boolean {
  const state = readState();
  if (state.members.some(m => m.id === state.actorId && m.active)) return true;
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
      if (!isCloud()) { if (ensureMember()) options.onLoad?.call(this, query); return; }
      const load = syncCloud().then(() => { if (ensureMember()) options.onLoad?.call(this, query); }).catch(notifyError);
      loads.set(this, load);
    },
    onShow() {
      if (!isCloud()) { if (ensureMember()) options.onShow?.call(this); return; }
      void (async () => {
        await loads.get(this);
        await syncCloud();
        if (ensureMember()) options.onShow?.call(this);
      })().catch(notifyError);
    },
    onPullDownRefresh() {
      if (!isCloud()) { options.onShow?.call(this); wx.stopPullDownRefresh(); return; }
      void syncCloud().then(() => { if (ensureMember()) options.onShow?.call(this); }).catch(notifyError).finally(() => wx.stopPullDownRefresh());
    },
  });
};
