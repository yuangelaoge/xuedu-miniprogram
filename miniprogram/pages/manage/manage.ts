import { context, run, command, runAsync } from "../../services/store";
import { UiEvent, Semester, JoinApplication } from "../../domain/types";
import {
  inspectImport,
  ImportKind,
} from "../../domain/imports";
import { memberPage } from "../../services/member-page";
import { cloudCall, CloudSnapshot, acceptSnapshot } from "../../services/cloud";
import { runtime } from "../../config/runtime";
memberPage({
  data: {
    tab: "members",
    admin: false,
    manager: false,
    resettingAll: false,
    resetProgress: "",
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
      semesterName: semester.name,
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
      semesterIndex: state.semesters.findIndex((s) => s.id === semester.id),
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
  async cleanupTrial() {
    if (runtime.mode !== "trial" || !this.data.admin) return;
    await runAsync(async () => {
      const plan = await cloudCall<{ epoch: string; version: number; members: number; applications: number; records: number; files: number }>("cleanupPreview");
      wx.showModal({ title: "清理多人试用数据",
        content: `将永久删除 ${plan.members} 名试用成员、${plan.applications} 份申请、全部无课时间和排班、${plan.records} 份记录及 ${plan.files} 张照片。保留管理员和基础课表配置。此操作不可撤销。请输入：清空试用数据`,
        editable: true, confirmText: "确认清理", confirmColor: "#c73535",
        success: async r => {
          if (!r.confirm) return;
          await runAsync(async () => {
            const next = await cloudCall<CloudSnapshot>("cleanup", { epoch: plan.epoch, version: plan.version, confirmation: r.content });
            acceptSnapshot(next); this.refresh();
          }, "试用数据已清理");
        },
      });
    });
  },
  async resetAll() {
    if (runtime.mode !== "trial" || !this.data.admin || this.data.resettingAll) return;
    await runAsync(async () => {
      const plan = await cloudCall<{ epoch: string; version: number; members: number; applications: number; semesters: number; classes: number; courses: number; records: number; files: number; resetId: string }>("resetAllPreview");
      wx.showModal({ title: plan.resetId ? "继续彻底重置" : "彻底重置试用环境",
        content: `永久清空全部 ${plan.members} 名成员（含你和所有管理员）、${plan.applications} 份申请、${plan.semesters} 个学期、${plan.classes} 个班级、${plan.courses} 个课程时段、全部排班和无课时间、${plan.records} 份记录、操作记录及照片。已登记照片 ${plan.files} 张；还将扫描试用照片目录清理未登记照片。保留云环境、代码、密钥和你的重新初始化资格。不清除平台备份/日志、手机副本和导出文件。不可撤销，请输入：清空全部业务数据`,
        editable: true, confirmText: "彻底重置", confirmColor: "#c73535",
        success: async r => {
          if (!r.confirm) return;
          if (r.content !== "清空全部业务数据") { wx.showToast({ title: "确认文字不符，未执行", icon: "none" }); return; }
          this.setData({ resettingAll: true, resetProgress: "正在冻结写入…" });
          try {
            await runAsync(async () => {
              const start = await cloudCall<{ resetId: string }>("resetAllBegin", { epoch: plan.epoch, version: plan.version, confirmation: r.content });
              for (let i = 0; i < 100; i++) {
                const next = await cloudCall<{ done: boolean; waitMs: number; snapshot?: CloudSnapshot }>("resetAllStep", { resetId: start.resetId });
                if (next.done && next.snapshot) {
                  acceptSnapshot(next.snapshot);
                  const prefix = "xuedu.form." + runtime.env + ".trial.";
                  for (const key of wx.getStorageInfoSync().keys) if (key.startsWith(prefix)) wx.removeStorageSync(key);
                  wx.reLaunch({ url: "/pages/join/join" });
                  return;
                }
                this.setData({ resetProgress: next.waitMs ? "等待正在上传的请求结束…" : "正在分批核查并清理照片…" });
                if (next.waitMs) await new Promise(resolve => setTimeout(resolve, Math.min(1000, next.waitMs)));
              }
              throw new Error("本轮处理上限已到，写入仍冻结。请再次点击彻底重置继续，不会重复创建任务");
            });
          } finally { this.setData({ resettingAll: false, resetProgress: "如发生中断，请再次预览并继续；未完成前写入保持冻结。" }); }
        },
      });
    });
  },
});
