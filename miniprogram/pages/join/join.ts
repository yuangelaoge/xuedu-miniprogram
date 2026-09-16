import { readState, run, transact, command, runAsync, notifyError } from "../../services/store";
import { demoIdentity, submitJoin, enterAsApprovedApplicant } from "../../services/join";
import { isCloud, modeLabel } from "../../config/runtime";
import { syncCloud, cloudCall } from "../../services/cloud";
import { latestApplication, membershipFor } from "../../domain/membership";
import { UiEvent } from "../../domain/types";

Page({
  data: {
    cloudMode: isCloud(), modeLabel: modeLabel(), connecting: false, connectionError: "",
    status: "new", reason: "", name: "", studentNo: "", classId: "",
    classIndex: -1, classes: [] as { id: string; label: string }[], busy: false,
    statusTitle: "申请加入学督", statusText: "首次填写资料，由管理员或组部长审核。",
  },
  onLoad() { if (!isCloud()) transact(s => { s.actorId = ""; }); },
  onShow() { this.refresh(); },
  onPullDownRefresh() {
    if (isCloud()) void this.loadCloud().finally(() => wx.stopPullDownRefresh());
    else { this.render(); wx.stopPullDownRefresh(); }
  },
  refresh() {
    if (isCloud()) { void this.loadCloud(); return; }
    this.render();
  },
  async loadCloud() {
    this.setData({ connecting: true, connectionError: "" });
    try { await syncCloud(); this.render(); }
    catch (e) { this.setData({ connectionError: e instanceof Error ? e.message : "连接失败" }); }
    finally { this.setData({ connecting: false }); }
  },
  render() {
    if (enterAsApprovedApplicant()) return;
    const state = readState(), identity = demoIdentity();
    const member = membershipFor(state, identity), application = latestApplication(state, identity);
    const status = member && !member.active ? "removed" : application?.status || "new";
    const classes = state.classes.map(c => ({ id: c.id, label: c.grade + "级 · " + c.major + " · " + c.name }));
    const classId = application?.classId || this.data.classId;
    this.setData({ status, classes, classId, classIndex: classes.findIndex(c => c.id === classId),
      name: application?.name || this.data.name, studentNo: application?.studentNo || this.data.studentNo,
      reason: application?.reason || "",
      statusTitle: status === "pending" ? "申请已提交，等待审核" : status === "rejected" ? "申请未通过" : status === "removed" ? "成员资格已被移除" : "申请加入学督",
      statusText: status === "pending" ? "管理员或组部长审核通过后，刷新即可进入。不需要重复提交。" : status === "removed" ? "暂时不能访问小组数据。如需重新加入，请联系管理员核实。" : "首次填写资料，由管理员或组部长审核。",
    });
  },
  input(e: UiEvent) {
    const key = e.currentTarget.dataset.key;
    if (key === "name" || key === "studentNo") this.setData({ [key]: e.detail.value });
  },
  chooseClass(e: UiEvent) {
    const i = Number(e.detail.value), selected = this.data.classes[i];
    if (selected) this.setData({ classIndex: i, classId: selected.id });
  },
  submit() {
    if (this.data.busy) return;
    if (isCloud()) { void this.submitCloud(); return; }
    this.setData({ busy: true });
    const ok = run(() => submitJoin({ name: this.data.name, studentNo: this.data.studentNo, classId: this.data.classId }), "申请已提交");
    this.setData({ busy: false });
    if (ok) this.refresh();
  },
  async submitCloud() {
    this.setData({ busy: true });
    const ok = await runAsync(() => command({ type: "join", form: { name: this.data.name, studentNo: this.data.studentNo, classId: this.data.classId } }), "申请已提交");
    this.setData({ busy: false });
    if (ok) this.render();
  },
  async copyIdentity() {
    try { const data = await cloudCall<{ openid: string }>("identity"); wx.setClipboardData({ data: data.openid }); }
    catch (e) { notifyError(e); }
  },
  openDemo() {
    if (isCloud()) return;
    wx.navigateTo({ url: "/pages/demo/demo" });
  },
});
