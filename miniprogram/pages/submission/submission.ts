import { isCloud as cloudEnabled } from "../../config/runtime";
import { registerCloudPage } from "../../services/v2/page";
import { context, command, run, runAsync, notifyError, draftPrefix } from "../../services/store";
import { isCloud } from "../../config/runtime";
import { uploadRecordPhotos } from "../../services/photos";
import {
  METRIC_FIELDS,
  MetricKey,
  Metrics,
  Observation,
  Task,
  UiEvent,
} from "../../domain/types";
import { courseTime, weekDate } from "../../domain/calendar";
import { missingMetrics } from "../../domain/metrics";
import { memberPage } from "../../services/member-page";
if (cloudEnabled()) registerCloudPage("submission"); else memberPage({
  data: {
    taskId: "",
    week: 0,
    title: "",
    classLabel: "",
    date: "",
    time: "",
    name: "",
    fields: [] as { key: MetricKey; label: string; value: string }[],
    absentNames: "",
    leaveNames: "",
    otherDescription: "",
    evaluation: "",
    feedback: "",
    suggestion: "",
    photos: [] as string[],
    busy: false,
    valid: false,
  },
  task: null as Task | null,
  draftKey: "",
  onLoad(query: Record<string, string>) {
    const { state, user, semester } = context();
    const plan = state.plans.find(
      (p) =>
        p.semesterId === semester.id &&
        p.status === "confirmed" &&
        p.tasks.some((t) => t.id === query.task && t.memberId === user.id),
    );
    const task = plan?.tasks.find((t) => t.id === query.task);
    if (!task || !plan) {
      wx.showModal({
        title: "无法填写",
        content: "未找到属于你的正式任务。",
        showCancel: false,
      });
      return;
    }
    if (state.records.some((r) => r.taskId === task.id)) {
      wx.redirectTo({
        url:
          "/pages/record/record?id=" +
          state.records.find((r) => r.taskId === task.id)!.id,
      });
      return;
    }
    this.task = task;
    this.draftKey = draftPrefix() + user.id + "." + task.id;
    const saved = wx.getStorageSync(this.draftKey) as
      | Partial<Observation>
      | undefined;
    const metrics = saved?.metrics || {
      ...missingMetrics(),
      expected: task.course.expected,
    };
    this.setData({
      valid: true,
      taskId: task.id,
      week: plan.week,
      title: task.course.name,
      classLabel: task.classLabel,
      name: user.name,
      date: weekDate(semester, plan.week, task.course.weekday),
      time: courseTime(task.course),
      fields: METRIC_FIELDS.map((f) => ({
        ...f,
        value: metrics[f.key] < 0 ? "" : String(metrics[f.key]),
      })),
      photos: saved?.photos || [],
      absentNames: saved?.absentNames || "",
      leaveNames: saved?.leaveNames || "",
      otherDescription: saved?.otherDescription || "",
      evaluation: saved?.evaluation || "",
      feedback: saved?.feedback || "",
      suggestion: saved?.suggestion || "",
    });
  },
  metric(e: UiEvent) {
    this.setData({
      fields: this.data.fields.map((f) =>
        f.key === e.currentTarget.dataset.key
          ? { ...f, value: e.detail.value }
          : f,
      ),
    });
  },
  text(e: UiEvent) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value });
  },
  missing(e: UiEvent) {
    this.setData({
      fields: this.data.fields.map((f) =>
        f.key === e.currentTarget.dataset.key ? { ...f, value: "" } : f,
      ),
    });
  },
  zero() {
    this.setData({
      fields: this.data.fields.map((f) =>
        f.value === "" && f.key !== "expected" && f.key !== "actual"
          ? { ...f, value: "0" }
          : f,
      ),
    });
  },
  noNames(e: UiEvent) {
    this.setData({ [e.currentTarget.dataset.key]: "无" });
  },
  choosePhoto() {
    if (this.data.busy) return;
    wx.chooseMedia({
      count: 3 - this.data.photos.length,
      mediaType: ["image"],
      sizeType: ["compressed"],
      sourceType: ["camera", "album"],
      success: (res) => {
        this.setData({ busy: true });
        const added: string[] = [];
        const save = (i: number): void => {
          if (i >= res.tempFiles.length) {
            this.setData({
              photos: this.data.photos.concat(added),
              busy: false,
            });
            this.saveDraft(false);
            return;
          }
          wx.getFileSystemManager().saveFile({
            tempFilePath: res.tempFiles[i].tempFilePath,
            success: (r) => {
              added.push(r.savedFilePath);
              save(i + 1);
            },
            fail: (error) => {
              this.setData({
                photos: this.data.photos.concat(added),
                busy: false,
              });
              notifyError(
                new Error(
                  "照片保存失败，请检查设备存储后重试。" + error.errMsg,
                ),
              );
            },
          });
        };
        save(0);
      },
      fail: (error) => {
        if (!error.errMsg.includes("cancel"))
          notifyError(new Error("无法选择照片，请检查相机或相册权限"));
      },
    });
  },
  preview(e: UiEvent) {
    wx.previewImage({
      urls: this.data.photos,
      current: e.currentTarget.dataset.path,
    });
  },
  remove(e: UiEvent) {
    this.setData({
      photos: this.data.photos.filter(
        (p) => p !== e.currentTarget.dataset.path,
      ),
    });
    this.saveDraft(false);
  },
  build(): Observation {
    const { semester, user } = context();
    if (!this.task) throw new Error("任务不存在");
    const metrics = missingMetrics();
    this.data.fields.forEach((f) => {
      metrics[f.key] = f.value.trim() === "" ? -1 : Number(f.value);
    });
    return {
      id: "r-" + this.data.taskId,
      taskId: this.data.taskId,
      semesterId: semester.id,
      week: this.data.week,
      memberId: user.id,
      memberName: user.name,
      course: this.task.course,
      classLabel: this.task.classLabel,
      date: this.data.date,
      metrics: metrics as Metrics,
      absentNames: this.data.absentNames,
      leaveNames: this.data.leaveNames,
      otherDescription: this.data.otherDescription,
      evaluation: this.data.evaluation,
      feedback: this.data.feedback,
      suggestion: this.data.suggestion,
      photos: this.data.photos,
      createdAt: "",
    };
  },
  saveDraft(show = true) {
    if (!this.task) return;
    run(
      () => wx.setStorageSync(this.draftKey, this.build()),
      show ? "草稿已保存" : "",
    );
  },
  draft() {
    this.saveDraft();
  },
  submit() {
    if (this.data.busy) return;
    wx.showModal({
      title: "提交前核对",
      content:
        "请确认人数、名单与纸质表一致，照片包含清晰的老师签字。提交后体验版暂不支持修改。",
      confirmText: "确认提交",
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true });
        let id = "";
        const ok = await runAsync(async () => {
          const record = this.build();
          id = record.id;
          record.photos.forEach((path) =>
            wx.getFileSystemManager().accessSync(path),
          );
          if (isCloud()) record.photos = await uploadRecordPhotos(record.photos, record.taskId);
          await command({ type: "submit", record });
          wx.removeStorageSync(this.draftKey);
        }, "听课记录已提交");
        this.setData({ busy: false });
        if (ok) wx.redirectTo({ url: "/pages/record/record?id=" + id });
      },
    });
  },
});
