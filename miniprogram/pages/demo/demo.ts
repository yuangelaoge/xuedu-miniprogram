import { isCloud as cloudEnabled } from "../../config/runtime";
import { registerCloudPage } from "../../services/v2/page";
import { readState, changeDemoActor, run } from "../../services/store";
import { ROLE_NAMES, UiEvent } from "../../domain/types";
import { startJoinDemo } from "../../services/join";
import { isCloud } from "../../config/runtime";

// 本地开发专用。申请者也可进入以演示审核，正式接入时须移除此页面与路由。
if (cloudEnabled()) registerCloudPage("home"); else Page({
  data: {
    members: [] as { id: string; label: string }[],
    actorIndex: -1,
  },
  onShow() {
    if (isCloud()) { wx.reLaunch({ url: "/pages/index/index" }); return; }
    const state = readState();
    const members = state.members
      .filter((m) => m.active)
      .map((m) => ({ id: m.id, label: m.name + " · " + ROLE_NAMES[m.role] }));
    this.setData({ members, actorIndex: members.findIndex((m) => m.id === state.actorId) });
  },
  switchActor(e: UiEvent) {
    if (isCloud()) return;
    const member = this.data.members[Number(e.detail.value)];
    if (!member) return;
    if (run(() => changeDemoActor(member.id), "体验身份已切换")) {
      const actor = readState().members.find((m) => m.id === member.id)!;
      wx.reLaunch({ url: actor.role === "member"
        ? "/pages/index/index"
        : "/pages/manage/manage?tab=members" });
    }
  },
  joinDemo() {
    if (isCloud()) return;
    startJoinDemo();
  },
});
