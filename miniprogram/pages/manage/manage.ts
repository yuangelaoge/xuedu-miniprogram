import { isCloud as cloudEnabled } from "../../config/runtime";
import { registerCloudPage } from "../../services/v2/page";
import { readState, run, command, runAsync } from "../../services/store";
import { UiEvent, Semester, JoinApplication } from "../../domain/types";
import {
  inspectImport,
  ImportKind,
} from "../../domain/imports";
import { memberPage } from "../../services/member-page";
import { actor } from "../../domain/actions";
// Management remains usable after clearing every semester.
function context() {
  const state = readState(), user = actor(state);
  return { state, user, manager: ["admin", "leader"].includes(user.role), semester: state.semesters.find(s => s.id === state.activeSemesterId) };
}
if (cloudEnabled()) registerCloudPage("manage"); else memberPage({
  data: {
    tab: "members",
    admin: false,
    manager: false,
    needsSemester: false,
    needsAdminClass: false,
    adminClasses: [] as { id: string; name: string }[],
    memberTab: "pending",
    pending: [] as (JoinApplication & { classLabel: string; selected: boolean })[],
    selected: [] as string[],
    pendingCount: 0,
    semesterName: "",
    members: [] as {
      id: string;
      name: string;
      classLabel: string;
      roleLabel: string;
      active: boolean;
    }[],
    search: "",
    text: "",
    previewed: false,
    errors: [] as string[],
    preview: [] as { name: string; detail: string }[],
    classCount: 0,
    semesters: [] as Semester[],
    semesterIndex: 0,
    logs: [] as {
      action: string;
      actor: string;
      detail: string;
      time: string;
    }[],
    form: {
      name: "2027–2028 第一学期",
      startDate: "2027-09-06",
      weeks: "20",
      grades: "25,26,27",
      days: "5",
      periods: "14",
    },
  },
  onLoad(query: Record<string, string>) {
    const { manager, user } = context();
    if (!manager) {
      wx.showModal({
        title: "无管理权限",
        content: "此功能仅限管理员或组部长使用。",
        showCancel: false,
      });
      return;
    }
    const allowed =
      user.role === "admin"
        ? ["members", "courses", "semester", "audit"]
        : ["members", "audit"];
    this.setData({ tab: allowed.includes(query.tab) ? query.tab : "members" });
    this.refresh();
  },
  refresh() {
    const { state, user, semester, manager } = context();
    if (!manager) { this.setData({ manager: false, members: [], pending: [], logs: [] }); return; }
    const selected = this.data.selected.filter(id => state.applications.some(a => a.id === id && a.status === "pending"));
    this.setData({
      manager,
      admin: user.role === "admin",
      semesterName: semester?.name || "尚未建立学期",
      needsSemester: !semester,
      needsAdminClass: user.role === "admin" && !user.classId,
      adminClasses: state.classes,

      selected,
      pendingCount: state.applications.filter(a => a.status === "pending").length,
      pending: state.applications.filter(a => a.status === "pending" && (a.name + a.studentNo).includes(this.data.search))
        .map(a => ({ ...a, classLabel: state.classes.find(c => c.id === a.classId)?.name || a.classId, selected: selected.includes(a.id) })),
      members: state.members
        .filter((m) => m.active && (m.name + m.studentNo).includes(this.data.search))
        .map((m) => ({
          ...m,
          classLabel:
            state.classes.find((c) => c.id === m.classId)?.name || m.classId,
          roleLabel:
            m.role === "admin"
              ? "管理员"
              : m.role === "leader"
                ? "组部长"
                : "部员",
        })),
      semesters: state.semesters,
      semesterIndex: state.semesters.findIndex((s) => s.id === semester?.id),
      logs: state.audit
        .slice(0, 80)
        .map((l) => ({
          ...l,
          time: l.at.slice(0, 16).replace("T", " ") + " UTC",
        })),
    });
  },
  tab(e: UiEvent) {
    const next = e.currentTarget.dataset.tab;
    if (!context().manager || (next !== "members" && next !== "audit" && !this.data.admin)) return;
    this.setData({
      tab: e.currentTarget.dataset.tab,
      text: "",
      previewed: false,
      errors: [],
      preview: [],
    });
    this.refresh();
  },
  search(e: UiEvent) {
    this.setData({ search: e.detail.value, selected: [] });
    this.refresh();
  },
  onShow() { this.refresh(); },
  memberTab(e: UiEvent) { this.setData({ memberTab: e.currentTarget.dataset.tab, selected: [], search: "" }); this.refresh(); },
  selectApplication(e: UiEvent) {
    const id = e.currentTarget.dataset.id;
    this.setData({ selected: this.data.selected.includes(id) ? this.data.selected.filter(x => x !== id) : this.data.selected.concat(id) }); this.refresh();
  },
  selectAll() { this.setData({ selected: this.data.selected.length === this.data.pending.length ? [] : this.data.pending.map(a => a.id) }); this.refresh(); },
  review(e: UiEvent) {
    const ids = e.currentTarget.dataset.id ? [e.currentTarget.dataset.id] : this.data.selected.slice();
    const decision = e.currentTarget.dataset.decision === "approved" ? "approved" : "rejected";
    if (!ids.length) return;
    wx.showModal({ title: decision === "approved" ? "通过入组申请" : "驳回入组申请",
      content: decision === "approved" ? "确认通过 " + ids.length + " 份申请？通过后均为普通成员。" : "",
      editable: decision === "rejected", placeholderText: "填写驳回原因，方便成员修改",
      success: async r => {
        if (!r.confirm) return;
        if (await runAsync(() => command({ type: "review", ids, decision, reason: r.content || "" }), "申请已处理")) this.setData({ selected: [] });
        this.refresh();
      },
    });
  },
  removeMember(e: UiEvent) {
    const id = e.currentTarget.dataset.id;
    const member = context().state.members.find(m => m.id === id);
    if (!member) return;
    wx.showModal({ title: "删除组员 " + member.name,
      content: "删除后立即取消访问与排班资格，未完成的任务将取消并列为待处理安排；历史听课记录、照片保留。确定删除吗？",
      confirmText: "删除组员", confirmColor: "#c73535",
      success: async r => { if (r.confirm) { await runAsync(() => command({ type: "removeMember", id }), "组员已删除"); this.refresh(); } },
    });
  },
  role(e: UiEvent) {
    const id = e.currentTarget.dataset.id, role = e.currentTarget.dataset.role === "leader" ? "leader" : "member";
    wx.showModal({ title: "调整成员角色", content: "确认将该成员设为" + (role === "leader" ? "组部长？" : "普通成员？"),
      success: async r => { if (r.confirm) { await runAsync(() => command({ type: "role", id, role }), "角色已更新"); this.refresh(); } },
    });
  },
  input(e: UiEvent) {
    this.setData({
      text: e.detail.value,
      previewed: false,
      errors: [],
      preview: [],
    });
  },
  form(e: UiEvent) {
    this.setData({ ["form." + e.currentTarget.dataset.key]: e.detail.value });
  },
  file() {
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["json", "txt"],
      success: async (r) => {
        if (r.tempFiles[0].size > 1024 * 1024) {
          wx.showToast({ title: "请选择小于 1MB 的文件", icon: "none" });
          return;
        }
        wx.getFileSystemManager().readFile({
          filePath: r.tempFiles[0].path,
          encoding: "utf8",
          success: (f) =>
            this.setData({
              text: String(f.data).replace(/^\uFEFF/, ""),
              previewed: false,
            }),
          fail: () => wx.showToast({ title: "文件读取失败", icon: "none" }),
        });
      },
    });
  },
  example() {
    const { semester } = context();
    if (!semester) { wx.showToast({ title: "请先建立学期", icon: "none" }); return; }
    const grade = semester.grades[0];
    const payload = {
            classes: [
              {
                id: grade + "-example",
                grade,
                major: "计算机科学与技术",
                name: grade + "计科示例班",
              },
            ],
            courses: [
              {
                id: semester.id + "-example",
                name: "程序设计基础",
                teacher: "示例教师",
                nature: "专业必修",
                classIds: [grade + "-example"],
                classroom: "示例教室",
                weekday: 2,
                start: 3,
                end: 4,
                weeks: [1, 2, 3, 4, 5],
                expected: 40,
              },
            ],
          };
    this.setData({ text: JSON.stringify(payload, null, 2), previewed: false });
  },
  preview() {
    run(() => {
      const result = inspectImport(
        context().state,
        this.data.tab as ImportKind,
        this.data.text,
      );
      this.setData({
        previewed: true,
        errors: result.errors,
        classCount: result.classes.length,
        preview: result.courses
                .filter(Boolean)
                .map((c) => ({
                  name: c.name || "字段缺失",
                  detail:
                    (Array.isArray(c.classIds)
                      ? c.classIds.join(" / ")
                      : "班级缺失") +
                    " · " +
                    c.classroom,
                })),
      });
    });
  },
  commit() {
    wx.showModal({
      title: "确认导入",
      content:
        "向当前学期添加 " +
        this.data.preview.length +
        " 条数据及 " +
        this.data.classCount +
        " 个班级。已有正式任务保留，待确认草稿需重新生成。",
      success: async (r) => {
        if (
          r.confirm &&
          await runAsync(
            () => command({ type: "import", text: this.data.text }),
            "导入成功",
          )
        ) {
          this.setData({ text: "", previewed: false, preview: [], errors: [] });
          this.refresh();
        }
      },
    });
  },
  async semester(e: UiEvent) {
    await runAsync(() => command({ type: "semester", id: this.data.semesters[Number(e.detail.value)].id }));
    this.refresh();
  },
  async createSemester() {
    await runAsync(async () => {
      const f = this.data.form;
      await command({ type: "createSemester", value: {
          id: "semester-" + Date.now(),
          name: f.name,
          startDate: f.startDate,
          weeks: Number(f.weeks),
          grades: Array.from(
            new Set(f.grades.split(/[,，、\s]+/).filter(Boolean)),
          ),
          days: Number(f.days),
          periods: Number(f.periods),
          edition: "学风督察小组",
        } });
      this.refresh();
    }, "新学期已建立");
  },
  async restoreAdminClass(e: UiEvent) {
    const selected = this.data.adminClasses[Number(e.detail.value)];
    if (!selected || !this.data.needsAdminClass) return;
    wx.showModal({ title: "确认本人班级", content: `将本人班级设置为“${selected.name}”，用于避免听本人班级的课。请确认是真实班级。`,
      success: async r => {
        if (!r.confirm) return;
        await runAsync(async () => { await command({ type: "restoreAdminClass", classId: selected.id }); this.refresh(); }, "本人班级已设置");
      },
    });
  },
});
