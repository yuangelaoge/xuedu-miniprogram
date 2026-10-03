import { canViewAllRecords, canExportFullXlsx, canExportNames } from "../../domain/capabilities";
import { isCloud as cloudEnabled } from "../../config/runtime";
import { registerCloudPage } from "../../services/v2/page";
import { context, published, run } from "../../services/store";
import { UiEvent } from "../../domain/types";
import { percent } from "../../domain/metrics";
import {
  exportTxt,
  exportXlsx,
  gradeStats,
  weekRecords,
} from "../../domain/reports";
import { weekRange } from "../../domain/calendar";
import { saveExport, openExport } from "../../services/files";
import { memberPage } from "../../services/member-page";
if (cloudEnabled()) registerCloudPage("records"); else memberPage({
  data: {
    week: 1,
    maxWeek: 20,
    dates: "",
    manager: false,
    canExportExcel:false, canExportNames:false,
    tab: "mine",
    records: [] as {
      id: string;
      name: string;
      course: string;
      classLabel: string;
      date: string;
      canView: boolean;
    }[],
    stats: [] as {
      grade: string;
      count: number;
      valid: number;
      rate: string;
      width: number;
    }[],
    submitted: 0,
    total: 0,
    progress: 0,
    skipped: false,
    filename: "",
    filePath: "",
    busy: false,
  },
  initialized: false,
  viewIdentity: "",
  onShow() {
    const c = context();
    const identity = c.user.id + ":" + c.user.role;
    if (identity !== this.viewIdentity) {
      this.setData({ tab: canViewAllRecords(c.user.role) ? "all" : "mine", filePath: "", filename: "" });
      this.viewIdentity = identity;
    }
    if (!this.initialized) {
      this.setData({ week: c.week });
      this.initialized = true;
    }
    this.refresh();
  },
  refresh() {
    const { state, user, semester, manager } = context(),
      week = Math.min(this.data.week, semester.weeks),
      records = weekRecords(state, week),
      plan = published(state, week);
    const total = plan?.status === "confirmed" ? plan.tasks.length : 0;
    this.setData({
      week,
      maxWeek: semester.weeks,
      dates: weekRange(semester, week),
      manager, canExportExcel:canExportFullXlsx(user.role), canExportNames:canExportNames(user.role),
      records: records
        .filter((r) => this.data.tab !== "mine" || r.memberId === user.id)
        .map((r) => ({
          id: r.id,
          name: r.memberName,
          course: r.course.name,
          classLabel: r.classLabel,
          date: r.date,
          canView: canViewAllRecords(user.role) || r.memberId === user.id,
        })),
      stats: gradeStats(state, week).map((g) => ({
        grade: g.grade,
        count: g.count,
        valid: g.valid,
        rate: percent(g.rate),
        width: g.rate === null ? 0 : Math.min(100, g.rate * 100),
      })),
      submitted: records.length,
      total,
      progress: total ? Math.round((records.length / total) * 100) : 0,
      skipped: plan?.status === "skipped",
    });
  },
  tab(e: UiEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.refresh();
  },
  move(e: UiEvent) {
    const w = this.data.week + Number(e.currentTarget.dataset.delta);
    if (w > 0 && w <= this.data.maxWeek) {
      this.setData({ week: w, filePath: "", filename: "" });
      this.refresh();
    }
  },
  detail(e: UiEvent) {
    wx.navigateTo({
      url: "/pages/record/record?id=" + e.currentTarget.dataset.id,
    });
  },
  copy() {
    if (!canExportNames(context().user.role)) return;
    run(() =>
      wx.setClipboardData({ data: exportTxt(context().state, this.data.week) }),
    );
  },
  export(e: UiEvent) {
    if (this.data.busy || !["txt", "xlsx"].includes(e.currentTarget.dataset.kind)) return;
    const role=context().user.role;
    if (e.currentTarget.dataset.kind === "xlsx" ? !canExportFullXlsx(role) : !canExportNames(role)) return;
    run(() => {
      const { state, semester } = context(),
        kind = e.currentTarget.dataset.kind,
        filename =
          semester.id +
          "-第" +
          this.data.week +
          "周-" +
          (kind === "txt" ? "请假旷课名单.txt" : "听课汇总.xlsx");
      const data =
        kind === "txt"
          ? "\ufeff" + exportTxt(state, this.data.week)
          : exportXlsx(state, this.data.week);
      this.setData({ busy: true });
      saveExport(filename, data, (path) => {
        this.setData({ busy: false, filename, filePath: path });
        wx.showToast({ title: "导出成功", icon: "success" });
      }, () => this.setData({ busy: false }));
    });
  },
  open() {
    if ((canExportFullXlsx(context().user.role) || canExportNames(context().user.role)) && this.data.filePath) openExport(this.data.filePath);
  },
});
