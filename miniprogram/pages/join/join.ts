import { readState, run, transact, command, runAsync, notifyError } from "../../services/store";
import { demoIdentity, submitJoin, enterAsApprovedApplicant } from "../../services/join";
import { isCloud, modeLabel, runtime } from "../../config/runtime";
import { syncCloud, cloudCall, CloudSnapshot, acceptSnapshot, currentSnapshot } from "../../services/cloud";
import { latestApplication, membershipFor } from "../../domain/membership";
import { UiEvent } from "../../domain/types";

Page({
  data: {
    cloudMode: isCloud(), trialMode: runtime.mode === "trial", modeLabel: modeLabel(), connecting: false, connectionError: "",
    status: "new", reason: "", name: "", studentNo: "", classId: "",
    classIndex: -1, classes: [] as { id: string; label: string }[], busy: false,
    statusTitle: "申请加入学督", statusText: "首次填写资料，由管理员或组部长审核。",
    bootstrapEmpty: false,
    setup: { semesterName: "", startDate: "", weeks: "20", grade: "", major: "", className: "", days: "5", periods: "14" },
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
    try {
      const snapshot = await syncCloud();
      if (runtime.mode === "trial" && !snapshot.state.semesters.length && !snapshot.state.classes.length) {
        const status = await cloudCall<{ bootstrapMatchesCurrentWeChat: boolean }>("deploymentStatus");
        this.setData({ bootstrapEmpty: status.bootstrapMatchesCurrentWeChat });
      } else this.setData({ bootstrapEmpty: false });
      this.render();
    }
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
  setupInput(e: UiEvent) {
    const key = e.currentTarget.dataset.key;
    if (["semesterName", "startDate", "weeks", "grade", "major", "className", "days", "periods"].includes(key)) this.setData({ ["setup." + key]: e.detail.value });
  },
  async setupWorkspace() {
    if (!this.data.bootstrapEmpty || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await runAsync(async () => {
        const f = this.data.setup;
        const next = await cloudCall<CloudSnapshot>("bootstrapWorkspace", { epoch: currentSnapshot().epoch,
          semester: { id: "new", name: f.semesterName, startDate: f.startDate, weeks: Number(f.weeks), grades: [f.grade], days: Number(f.days), periods: Number(f.periods), edition: "学风督察小组" },
          schoolClass: { grade: f.grade, major: f.major, name: f.className },
        });
        acceptSnapshot(next); this.setData({ bootstrapEmpty: false }); this.render();
      }, "已建立空白学期与班级，请填写本人资料");
    } finally { this.setData({ busy: false }); }
  },
  openDemo() {
    if (isCloud()) return;
    wx.navigateTo({ url: "/pages/demo/demo" });
  },
});
