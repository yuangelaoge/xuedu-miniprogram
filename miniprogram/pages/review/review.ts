import { reviewActive, reviewControl, leaveReviewLocally } from "../../services/v2/client";
import { isCloud } from "../../config/runtime";

Page({
  data: { username: "审核老师辛苦了", password: "", active: false, role: "", expiresAt: "", busy: false, error: "" },
  onShow() { void this.refresh(); },
  async refresh() {
    if (!isCloud()) { this.setData({error:"审核账号仅在云端业务模式可用"}); return; }
    if (!reviewActive()) { this.setData({active:false,role:"",password:""}); return; }
    this.setData({busy:true,error:""});
    try { const status=await reviewControl("reviewStatus"); this.setData({active:true,role:status.role || "",expiresAt:status.expiresAt || ""}); }
    catch(e) { leaveReviewLocally(); this.setData({active:false,role:"",error:e instanceof Error ? e.message : "审核会话已结束"}); }
    finally { this.setData({busy:false}); }
  },
  username(e: WechatMiniprogram.Input) { this.setData({username:e.detail.value}); },
  password(e: WechatMiniprogram.Input) { this.setData({password:e.detail.value}); },
  async login() {
    if (this.data.busy) return;
    const password=this.data.password;
    this.setData({busy:true,error:"",password:""});
    try { await reviewControl("reviewLogin",{username:this.data.username,password}); wx.reLaunch({url:"/pages/index/index"}); }
    catch(e) { this.setData({error:e instanceof Error ? e.message : "登录失败"}); }
    finally { this.setData({busy:false}); }
  },
  async switchRole(e: WechatMiniprogram.BaseEvent) {
    if (this.data.busy || !this.data.active) return;
    this.setData({busy:true,error:""});
    try { await reviewControl("reviewRole",{role:e.currentTarget.dataset.role}); wx.reLaunch({url:"/pages/index/index"}); }
    catch(error) { this.setData({error:error instanceof Error ? error.message : "切换失败"}); }
    finally { this.setData({busy:false}); }
  },
  async logout() {
    if (this.data.busy) return;
    this.setData({busy:true,error:""});
    try { await reviewControl("reviewLogout"); }
    catch { leaveReviewLocally(); }
    finally { this.setData({busy:false,active:false,role:"",password:""}); wx.reLaunch({url:"/pages/index/index"}); }
  },
});
