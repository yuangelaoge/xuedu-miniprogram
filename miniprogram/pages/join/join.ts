import { readState, run, transact } from "../../services/store";
import { demoIdentity, submitJoin, enterAsApprovedApplicant } from "../../services/join";
import { latestApplication, membershipFor } from "../../domain/membership";
import { UiEvent } from "../../domain/types";

Page({
  data: {
    status: "new", reason: "", name: "", studentNo: "", classId: "",
    classIndex: -1, classes: [] as { id: string; label: string }[], busy: false,
    statusTitle: "申请加入学督", statusText: "首次填写资料，由管理员或组部长审核。",
  },
  onLoad() { transact(s => { s.actorId = ""; }); },
  onShow() { this.refresh(); },
  refresh() {
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
    this.setData({ busy: true });
    const ok = run(() => submitJoin({ name: this.data.name, studentNo: this.data.studentNo, classId: this.data.classId }), "申请已提交");
    this.setData({ busy: false });
    if (ok) this.refresh();
  },
  openDemo() {
    wx.navigateTo({ url: "/pages/demo/demo" });
  },
});
