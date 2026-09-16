import { context } from "../../services/store";
import { ROLE_NAMES } from "../../domain/types";
import { memberPage } from "../../services/member-page";
memberPage({
  data: {
    name: "",
    initial: "",
    role: "",
    className: "",
    studentNo: "",
    manager: false,
    admin: false,
    semesterName: "",
    done: 0,
    total: 0,
    pendingCount: 0,
  },
  onShow() {
    const { state, user, semester, manager } = context();
    this.setData({
      name: user.name,
      initial: user.name[0],
      role: ROLE_NAMES[user.role],
      className: state.classes.find((c) => c.id === user.classId)?.name || "",
      studentNo: user.studentNo,
      manager,
      admin: user.role === "admin",
      semesterName: semester.name,
      done: state.records.filter(
        (r) => r.memberId === user.id && r.semesterId === semester.id,
      ).length,
      total: state.plans
        .filter((p) => p.semesterId === semester.id && p.status === "confirmed")
        .reduce(
          (n, p) => n + p.tasks.filter((t) => t.memberId === user.id).length,
          0,
        ),
      pendingCount: manager
        ? state.applications.filter((a) => a.status === "pending").length
        : 0,
    });
  },
  openDemo() {
    wx.navigateTo({ url: "/pages/demo/demo" });
  },
  availability() {
    wx.navigateTo({ url: "/pages/availability/availability" });
  },
  manage() {
    wx.navigateTo({
      url: "/pages/manage/manage?tab=members",
    });
  },
  rules() {
    wx.showModal({
      title: "听课与提交说明",
      content:
        "1. 不能听自己班，每周最多一次。\n2. 无课时间按周保存，以正式安排为准。\n3. 按实际情况填写人数，缺失信息单独标记。\n4. 上传清晰、带有老师签字的听课表。\n\n正式制度文件尚待管理员提供。",
      showCancel: false,
    });
  },
});
