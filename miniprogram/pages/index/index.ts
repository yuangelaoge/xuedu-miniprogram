import { context, published } from "../../services/store";
import { taskView } from "../../services/views";
import { ROLE_NAMES, UiEvent } from "../../domain/types";
import { weekRange } from "../../domain/calendar";
import { memberPage } from "../../services/member-page";
memberPage({
  data: {
    name: "",
    role: "",
    manager: false,
    week: 1,
    semesterName: "",
    dates: "",
    taskCount: 0,
    recordCount: 0,
    coverage: 0,
    skipped: false,
    availabilityReady: false,
    tasks: [] as ReturnType<typeof taskView>[],
  },
  onShow() {
    const { state, user, semester, week, manager } = context(),
      plan = published(state, week);
    const tasks = plan?.status === "confirmed" ? plan.tasks : [];
    this.setData({
      name: user.name,
      role: ROLE_NAMES[user.role],
      manager,
      week,
      semesterName: semester.name,
      dates: weekRange(semester, week),
      taskCount: tasks.length,
      recordCount: state.records.filter(
        (r) => r.semesterId === semester.id && r.week === week,
      ).length,
      coverage: tasks.length,
      skipped: plan?.status === "skipped",
      availabilityReady: state.availability.some(
        (a) =>
          a.memberId === user.id &&
          a.semesterId === semester.id &&
          a.week === Math.min(semester.weeks, week + 1),
      ),
      tasks: tasks
        .filter((t) => t.memberId === user.id)
        .map((t) => taskView(state, t, user.id)),
    });
  },
  availability() {
    wx.navigateTo({ url: "/pages/availability/availability" });
  },
  schedule() {
    wx.switchTab({ url: "/pages/schedule/schedule" });
  },
  reports() {
    wx.switchTab({ url: "/pages/reports/reports" });
  },
  submit(e: UiEvent) {
    const id =
      e.currentTarget.dataset.id || this.data.tasks.find((t) => !t.done)?.id;
    if (id) wx.navigateTo({ url: "/pages/submission/submission?task=" + id });
    else wx.showToast({ title: "本周暂无待提交任务", icon: "none" });
  },
  record(e: UiEvent) {
    wx.navigateTo({
      url: "/pages/record/record?id=" + e.currentTarget.dataset.id,
    });
  },
});
