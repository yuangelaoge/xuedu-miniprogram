import { readState } from "./store";
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
  Page({
    ...options,
    onLoad(query) { if (ensureMember()) options.onLoad?.call(this, query); },
    onShow() { if (ensureMember()) options.onShow?.call(this); },
  });
};
