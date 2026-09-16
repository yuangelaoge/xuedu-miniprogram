import { context, command, runAsync } from "../../services/store";
import { UiEvent } from "../../domain/types";
import { WEEKDAYS, weekRange } from "../../domain/calendar";
import { memberPage } from "../../services/member-page";
memberPage({
  data: {
    week: 1,
    currentWeek: 1,
    maxWeek: 20,
    dates: "",
    days: [] as { n: number; name: string }[],
    rows: [] as { n: number; cells: { key: string; selected: boolean }[] }[],
    slots: [] as string[],
    note: "",
    volunteer: false,
    optedIn: false,
    dirty: false,
    saved: false,
  },
  onLoad(query: Record<string, string>) {
    const c = context();
    this.setData({
      week: Number(query.week) || Math.min(c.semester.weeks, c.week + 1),
      currentWeek: c.week,
    });
    this.load();
  },
  load() {
    const { state, semester, user } = context(),
      week = Math.max(1, Math.min(this.data.week, semester.weeks));
    const value = state.availability.find(
      (a) =>
        a.semesterId === semester.id &&
        a.memberId === user.id &&
        a.week === week,
    );
    this.setData({
      week,
      maxWeek: semester.weeks,
      dates: weekRange(semester, week),
      days: Array.from({ length: semester.days }, (_, i) => ({
        n: i + 1,
        name: WEEKDAYS[i],
      })),
      slots: value?.slots || [],
      note: value?.note || "",
      optedIn: value?.optedIn || false,
      volunteer: user.role !== "member",
      dirty: false,
      saved: !!value,
    });
    this.renderGrid();
  },
  renderGrid() {
    const { semester } = context();
    this.setData({
      rows: Array.from({ length: semester.periods }, (_, i) => ({
        n: i + 1,
        cells: this.data.days.map((d) => ({
          key: d.n + ":" + (i + 1),
          selected: this.data.slots.includes(d.n + ":" + (i + 1)),
        })),
      })),
    });
  },
  toggle(e: UiEvent) {
    const key = e.currentTarget.dataset.key;
    this.setData({
      slots: this.data.slots.includes(key)
        ? this.data.slots.filter((s) => s !== key)
        : this.data.slots.concat(key),
      dirty: true,
    });
    this.renderGrid();
  },
  day(e: UiEvent) {
    const d = e.currentTarget.dataset.day,
      { semester } = context(),
      all = Array.from(
        { length: semester.periods },
        (_, i) => d + ":" + (i + 1),
      ),
      remove = all.every((k) => this.data.slots.includes(k));
    this.setData({
      slots: remove
        ? this.data.slots.filter((k) => !all.includes(k))
        : Array.from(new Set(this.data.slots.concat(all))),
      dirty: true,
    });
    this.renderGrid();
  },
  note(e: UiEvent) {
    this.setData({ note: e.detail.value, dirty: true });
  },
  volunteer() {
    this.setData({ optedIn: !this.data.optedIn, dirty: true });
  },
  move(e: UiEvent) {
    const week = this.data.week + Number(e.currentTarget.dataset.delta);
    if (week < 1 || week > this.data.maxWeek) return;
    const next = () => {
      this.setData({ week });
      this.load();
    };
    if (this.data.dirty)
      wx.showModal({
        title: "尚未保存",
        content: "切换周次会放弃本页未保存的修改。",
        success: (r) => {
          if (r.confirm) next();
        },
      });
    else next();
  },
  copy() {
    const { state, semester, user } = context();
    const previous = state.availability.find(
      (a) =>
        a.semesterId === semester.id &&
        a.memberId === user.id &&
        a.week === this.data.week - 1,
    );
    if (!previous) {
      wx.showToast({ title: "上一周没有可复制的记录", icon: "none" });
      return;
    }
    wx.showModal({
      title: "复制上一周时间",
      content: "将替换当前勾选的时段，报名状态不会复制。保存后生效。",
      success: (r) => {
        if (r.confirm) {
          this.setData({
            slots: previous.slots.slice(),
            note: previous.note,
            dirty: true,
          });
          this.renderGrid();
        }
      },
    });
  },
  async save() {
    const { semester, user } = context();
    if (
      await runAsync(
        () =>
          command({ type: "availability", value: {
              semesterId: semester.id,
              memberId: user.id,
              week: this.data.week,
              slots: this.data.slots,
              note: this.data.note,
              optedIn: this.data.optedIn,
              updatedAt: "",
            } }),
        "无课时间已保存",
      )
    )
      this.setData({ dirty: false, saved: true });
  },
});
