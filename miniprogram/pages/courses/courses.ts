import { context } from "../../services/store";
import { courseView } from "../../services/views";
import { UiEvent } from "../../domain/types";
import { memberPage } from "../../services/member-page";
memberPage({
  data: {
    search: "",
    grade: "全部",
    grades: [] as string[],
    semesterName: "",
    courses: [] as ReturnType<typeof courseView>[],
    count: 0,
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    const { state, semester } = context();
    const all = state.courses
      .filter((c) => c.semesterId === semester.id)
      .map((c) => courseView(state, c));
    this.setData({
      semesterName: semester.name,
      grades: ["全部", ...semester.grades],
      count: all.length,
      courses: all.filter(
        (c) =>
          (this.data.grade === "全部" || c.grade === this.data.grade) &&
          (c.name + c.classLabel + c.teacher).includes(this.data.search.trim()),
      ),
    });
  },
  search(e: UiEvent) {
    this.setData({ search: e.detail.value });
    this.refresh();
  },
  grade(e: UiEvent) {
    this.setData({ grade: e.currentTarget.dataset.grade });
    this.refresh();
  },
  details(e: UiEvent) {
    const c = this.data.courses.find(
      (x) => x.id === e.currentTarget.dataset.id,
    )!;
    wx.showModal({
      title: c.name,
      content:
        c.classLabel +
        "\n" +
        c.teacher +
        " · " +
        c.nature +
        "\n" +
        c.timeLabel +
        "\n" +
        c.classroom +
        "\n有效周次：" +
        c.weeks.join("、") +
        "\n课表人数：" +
        c.expected,
      showCancel: false,
    });
  },
});
