import { context, published, command, runAsync } from "../../services/store";
import { taskView } from "../../services/views";
import { UiEvent } from "../../domain/types";
import { weekRange } from "../../domain/calendar";
import { memberPage } from "../../services/member-page";
memberPage({
  data: {
    week: 1,
    maxWeek: 20,
    dates: "",
    manager: false,
    admin: false,
    status: "",
    statusLabel: "",
    draft: false,
    revision: 0,
    hasPublished: false,
    search: "",
    tasks: [] as ReturnType<typeof taskView>[],
    uncovered: [] as { label: string; reason: string }[],
    reason: "",
    submitted: 0,
    total: 0,
  },
  initialized: false,
  onShow() {
    const c = context();
    if (!this.initialized) {
      this.setData({ week: Math.min(c.semester.weeks, c.week + 1) });
      this.initialized = true;
    }
    this.refresh();
  },
  refresh() {
    const { state, semester, user, manager } = context(),
      week = Math.min(this.data.week, semester.weeks),
      active = published(state, week);
    const draft = manager
        ? state.drafts.find(
            (p) => p.semesterId === semester.id && p.week === week,
          )
        : undefined,
      plan = draft || active;
    const tasks = plan?.status === "skipped" ? [] : plan?.tasks || [];
    this.setData({
      week,
      maxWeek: semester.weeks,
      dates: weekRange(semester, week),
      manager,
      admin: user.role === "admin",
      status: plan?.status || "empty",
      statusLabel: draft
        ? "待确认草稿"
        : active?.status === "confirmed"
          ? "已确认"
          : active?.status === "skipped"
            ? "已跳过"
            : "尚未生成",
      draft: !!draft,
      revision: plan?.revision || 0,
      hasPublished: active?.status === "confirmed",
      total: tasks.length,
      tasks: tasks
        .filter((t) =>
          (t.memberName + t.classLabel + t.course.name).includes(
            this.data.search.trim(),
          ),
        )
        .map((t) => taskView(state, t, user.id)),
      uncovered: plan?.uncovered || [],
      reason: plan?.reason || "",
      submitted: state.availability.filter(
        (a) => a.semesterId === semester.id && a.week === week,
      ).length,
    });
  },
  move(e: UiEvent) {
    const w = this.data.week + Number(e.currentTarget.dataset.delta);
    if (w > 0 && w <= this.data.maxWeek) {
      this.setData({ week: w });
      this.refresh();
    }
  },
  search(e: UiEvent) {
    this.setData({ search: e.detail.value });
    this.refresh();
  },
  async generate() {
    await runAsync(() => command({ type: "generate", week: this.data.week }));
    this.refresh();
  },
  confirm() {
    wx.showModal({
      title: "确认第" + this.data.week + "周排班",
      content:
        "将发布 " +
        this.data.total +
        " 个任务。" +
        (this.data.hasPublished
          ? "确认后将替换原安排，请核对成员与课程变动。"
          : "成员将在个人任务中看到安排。"),
      confirmText: "确认发布",
      success: async (result) => {
        if (result.confirm) {
          await runAsync(
            () => command({ type: "confirm", week: this.data.week, revision: this.data.revision }),
            "排班已确认",
          );
          this.refresh();
        }
      },
    });
  },
  skip() {
    wx.showModal({
      title: "跳过第" + this.data.week + "周",
      content: "整周不安排听课，请输入原因",
      editable: true,
      placeholderText: "例如：国庆假期",
      confirmText: "跳过本周",
      success: async (result) => {
        if (result.confirm) {
          await runAsync(
            () => command({ type: "skip", week: this.data.week, reason: result.content || "" }),
            "本周已跳过",
          );
          this.refresh();
        }
      },
    });
  },
  availability() {
    wx.navigateTo({
      url: "/pages/availability/availability?week=" + this.data.week,
    });
  },
  courses() {
    wx.navigateTo({ url: "/pages/courses/courses" });
  },
  submit(e: UiEvent) {
    wx.navigateTo({
      url: "/pages/submission/submission?task=" + e.currentTarget.dataset.id,
    });
  },
});
