import { MAX_RECORD_PHOTOS } from "../../domain/photo-limits";
import { preparePhoto, uploadPreparedPhoto } from "./photo-upload";
import { loadReportState } from "./report-loader";
import { ScheduleReport, exportScheduleXlsx } from "../../domain/schedule-report";
import { courseHeadcountText } from "../../domain/course-headcount";
import { taskCourseOptions, TaskCourseOption } from "../../domain/v2/task-options";
import { isManager, canViewAllRecords, canViewAllRecordPhotos, canCoordinate, canGeneratePlan, canConfirmPlan, canExportFullXlsx, canAdjustTasks, canExportNames, participatesByDefault } from "../../domain/capabilities";
import { SummaryReport } from "../../domain/v2/summary-report";
import { summaryGradeStats } from "../../domain/summary-xlsx";
import { Entity, CLEAR_CONFIRMATION, AutoApproval } from "../../domain/v2/protocol";
import { METRIC_FIELDS, UiEvent, Semester } from "../../domain/types";
import { exportTxt, exportXlsx, gradeStats } from "../../domain/reports";
import { saveExport, openExport } from "../files";
import { Boot, WeekData, bootstrap, pageBootstrap, call, command, query, currentBoot, selectSemester, viewSemester, clearLocalDrafts, requestId, draftKey, reviewActive, pageFreshnessKey, queueScheduleFocus, takeScheduleFocus } from "./client";
import { runtime } from "../../config/runtime";
import { ImportPlan, planCourseImport } from "./import-batch";
import { syncAvailabilityExitAlert } from "../availability-exit";

import { boundedWeek, weekRange } from "../../domain/calendar";

interface AutoApprovalView { setting: AutoApproval | null; active: boolean; expired: boolean; version: number; serverNow: number; }
const localTime = (value: string) => value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0,16).replace("T", " ") + "（北京时间）" : "";
type View = "home" | "schedule" | "records" | "profile" | "manage" | "join" | "record" | "submission" | "availability" | "courses";
interface Option { label: string; value: string; checked?: boolean; }
interface Field { key: string; label: string; value: string; kind: string; options: Option[]; selected: string[]; }
interface Row extends Entity { courseCounts: {id:string;label:string;name:string;timeLabel:string;classroom:string;teacher:string;count:string;combined:boolean}[]; courseHeadcount:string; courseCombined:boolean; courseGrades?: string[]; courseClassLabel?: string; selected?: boolean; label: string; detail: string; status: string; active: boolean; role: string; statusLabel: string; cancel: boolean; replaces: boolean; historyFields: {label:string;value:string}[]; }
const titles: Record<View, string> = { home: "学风督察", schedule: "听课安排", records: "听课记录", profile: "我的", manage: "管理工作台", join: "申请加入", record: "听课记录详情", submission: "填写听课记录", availability: "无课时间", courses: "课程总表" };
const s = (value: unknown) => value === undefined || value === null ? "" : String(value);
const actionLabels: Record<string,string> = { autoApprovalEnabled:"开启自动通过", autoApprovalDisabled:"关闭自动通过", autoApproveApplication:"自动通过入组申请", initialize:"首次初始化", roleChange:"调整角色", memberStatus:"调整启停状态", memberRemove:"移除成员", memberRestore:"恢复成员", classSave:"维护班级", classDisable:"停用班级", semesterCreate:"建立学期草稿", semesterActivate:"启用学期", semesterParticipants:"配置参与班级", courseSave:"维护课程", courseDisable:"停用课程", exceptionSave:"停调补课", planGenerate:"生成排班草稿", planConfirm:"确认排班", taskAdjust:"调整任务草稿", recordSubmit:"提交记录", recordEdit:"更正记录", rebindConfirm:"确认微信换绑", applicationReview:"审核申请", clearBegin:"开始业务清空", import:"导入课表" };
const statusLabels: Record<string, string> = { pending: "待审核", approved: "已通过", rejected: "已驳回", draft: "草稿", active: "已启用", confirmed: "已确认", submitted: "已提交", pendingAdjustment: "待调整", cancelled: "已取消" };
const row = (e: Entity): Row => {
  const course = e.data.course as Record<string, unknown> | undefined;
  // Older single-course tasks may carry an empty options array; keep their snapshot visible.
  const displayTask = Array.isArray(e.data.courseOptions) && !e.data.courseOptions.length
    ? {...e,data:{...e.data,courseOptions:undefined}} : e;
  const courseCounts = course ? taskCourseOptions(displayTask).map(option => ({id:option.occurrenceId,
    label:`${option.course.name} · ${option.date} 第${option.course.start}–${option.course.end}节`,
    name:option.course.name,timeLabel:`${option.date} · 第${option.course.start}–${option.course.end}节`,
    classroom:option.course.classroom || '未填写',teacher:option.course.teacher || '未填写',
    count:courseHeadcountText(option.course.expected),combined:option.course.classIds?.length > 1})) : [];
  return { ...e, courseCounts, courseHeadcount:courseHeadcountText(course?.expected),courseCombined:Array.isArray(course?.classIds) && course.classIds.length > 1,
    label: s(e.data.name || e.data.memberName || e.data.classLabel || (actionLabels[s(e.data.action)] || e.data.action) || e.date || "业务资料"),
    detail: [e.data.studentNo, e.data.classLabel, e.data.approvalMode === "automatic" ? "自动通过 · " + localTime(s(e.data.reviewedAt)) : "", course?.name, e.data.grade, e.data.major, e.data.teacher || course?.teacher, e.data.date || e.date, course ? `第${course.start}–${course.end}节 ${course.classroom || ""}` : "", e.data.reason, e.data.detail, e.data.correctedAt ? "更正于 " + s(e.data.correctedAt) : ""].filter(Boolean).join(" · "),
    status: s(e.data.status), statusLabel: statusLabels[s(e.data.status)] || s(e.data.status), active: e.data.active !== false, role: s(e.data.role), cancel: e.data.cancel === true, replaces: !!e.data.replacesTaskId, historyFields: e.data.metrics ? METRIC_FIELDS.map(f => ({label:f.label,value:(e.data.metrics as Record<string,number>)[f.key] === -1 ? "信息缺失" : s((e.data.metrics as Record<string,number>)[f.key])})) : [] };
};
const homeTask = (t: Entity, records: Entity[] = []) => ({...row(t), classLabel:s(t.data.classLabel),
  course:(t.data.course || {}) as Record<string,unknown>,
  timeLabel:s(t.data.date || t.date) + " · 第" + s((t.data.course as Record<string,unknown>)?.start) + "–" + s((t.data.course as Record<string,unknown>)?.end) + "节",
  done:t.data.status === "submitted", recordId:records.find(r=>r.taskId===t.id)?.id || ""});
const field = (key: string, label: string, value: unknown = "", kind = "text", options: Option[] = []): Field => ({ key, label, value: s(value), kind, options, selected: Array.isArray(value) ? value.map(String) : [] });
const numberFields = new Set(["expected", "actual", "late", "early", "sleep", "phone", "talk", "other", "start", "end", "weekday", "weeksCount", "days", "periods", "week"]);
function rangeList(value: string): number[] {
  const result = new Set<number>();
  for (const part of value.split(/[,，\s]+/).filter(Boolean)) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error("周次请填写如 1-16 或 1,3,5");
    const a = Number(match[1]), b = Number(match[2] || match[1]);
    if (a < 1 || b < a || b > 60) throw new Error("周次范围为1至60");
    for (let i = a; i <= b; i++) result.add(i);
  }
  return [...result];
}
async function optionsFor(kind: string, semesterId = ""): Promise<Option[]> {
  const result: Option[] = []; let cursor = "";
  do {
    const response = await query(kind, semesterId, {}, cursor, 100);
    result.push(...response.data.items.filter(e => !["classes", "members"].includes(kind) || e.data.active !== false).map(e => ({ value: e.id, label: s(e.data.name || e.data.memberName || e.data.classLabel || e.date || "资料") })));
    cursor = response.cursor || "";
  } while (cursor);
  return result;
}
function availabilityGrid(slots: {key:string}[], selected: string[]) {
  const days = [...new Set(slots.map(slot => Number(slot.key.split(":")[0])))];
  const periods = [...new Set(slots.map(slot => Number(slot.key.split(":")[1])))];
  return { availabilityDays: days.map(n => ({n, name: "周" + "一二三四五六日"[n-1]})), availabilityRows: periods.map(n => ({n, cells: days.map(d => ({key: d + ":" + n, selected: selected.includes(d + ":" + n)}))})) };
}
function displayError(e: unknown): void { wx.showModal({ title: "未完成", content: e instanceof Error ? e.message : "操作失败，请刷新重试", showCancel: false }); }

function importPlanKey(semesterId: string): string {
  const boot = currentBoot();
  return ["xuedu.import.v2", runtime.env, reviewActive() ? "review" : "cloud", boot.workspace.epoch, boot.member?.id || "visitor", semesterId].join(".");
}
function readImportPlan(semesterId: string): ImportPlan | null {
  const stored = wx.getStorageSync(importPlanKey(semesterId)) as ImportPlan | undefined;
  if (!stored) return null;
  const boot = currentBoot();
  if (stored.semesterId !== semesterId || stored.epoch !== boot.workspace.epoch || stored.memberId !== boot.member?.id ||
      stored.permissionsVersion !== boot.workspace.permissionsVersion || !Array.isArray(stored.batches) ||
      !Number.isInteger(stored.next) || stored.next < 0 || stored.next > stored.batches.length || typeof stored.sourceText !== "string")
    throw new Error("本机导入续传状态与当前身份不符，请核对已导入资料后清除续传记录");
  let index = 0;
  const expected = planCourseImport(stored.sourceText, () => stored.batches[index++]?.requestId || "");
  if (expected.length !== stored.batches.length || expected.some((batch, i) =>
      batch.text !== stored.batches[i].text || batch.courses !== stored.batches[i].courses ||
      batch.classes !== stored.batches[i].classes || batch.dates !== stored.batches[i].dates))
    throw new Error("本机导入续传状态损坏，请核对已导入资料后清除续传记录");
  return stored;
}

export async function previewAuthorizedImages(urls: string[], index = 0): Promise<void> {
  if (!urls.length) return;
  let visible = urls;
  if (reviewActive() && urls.some(url => url === "/assets/review-signature.png")) {
    // Code-package images are valid for <image>, but previewImage expects a local file path.
    const sample = await wx.getImageInfo({ src: "/assets/review-signature.png" });
    visible = urls.map(url => url === "/assets/review-signature.png" ? sample.path : url);
  }
  await wx.previewImage({ urls: visible, current: visible[Math.max(0, Math.min(index, visible.length - 1))] });
}

export function registerCloudPage(view: View): void {
  let autoExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let availabilityVisible = true;
  let loadedAt = 0, loadedKey = "", nextWeekLoad = 0;
  let scheduleShowPending = false;
  Page({
    data: {
      metricFields: [] as Field[], nameFields: [] as Field[], feedbackFields: [] as Field[], recordContext: null as Row | null, uploadingPhoto: "",
      courseClasses: [] as Entity[], courseClassCursor: "", courseGrade: "全部", courseGrades: [] as string[], courseClassesIncomplete: false,
      importPreview: [] as string[], importCount: 0, importClassCount: 0, importReady: false, importPending: false, importProgress: "",
      pendingCount: 0, pendingMore: false, pendingLabel: "", searchText: "", applicationFilter: "pending", visibleRows: [] as Row[], visibleTasks: [] as Row[],
      dirty: false, weekInitialized: false, maxWeek: 60, filename: "", filePath: "", fileOwner: "",
      modeLabel: "云端试用", roleLabel: "", initial: "", className: "", studentNo: "", dates: "", availabilityReady: false,
      homeTasks: [] as ReturnType<typeof homeTask>[],
      homeNextTasks: [] as ReturnType<typeof homeTask>[], nextWeek:0, nextWeekLoading:false, nextWeekError:"", nextWeekMessage:"", taskCount: 0, recordCount: 0, coverage: 0, skipped: false,
      availabilityDays: [] as {n:number;name:string}[], availabilityRows: [] as {n:number;cells:{key:string;selected:boolean}[]}[],
      recordTab: "all", weekTotal: 0, weekSubmitted: 0, weekProgress: 0,
      eyebrow: ({home:"",schedule:"WEEKLY SCHEDULE",records:"WEEKLY REPORTS",profile:"MY WORKSPACE",manage:"MANAGEMENT",join:"JOIN US",record:"OBSERVATION RECORD",submission:"CLASSROOM OBSERVATION",availability:"YOUR AVAILABILITY",courses:"COURSE CATALOG"})[view],
      cloudMode: true, reviewMode: reviewActive(), title: titles[view], view, busy: false, refreshing: false, loadingInitial: ["home", "schedule", "records", "profile"].includes(view), hasLoaded: false, error: "", status: "", canInitialize: false, removed: false,
      admin: false, manager: false, canViewRecords:false, coordinator:false, canGenerate:false, canConfirm:false, canExportExcel:false, canAdjust:false, canExportNames:false, officer:false, statusRows:[] as {id:string;name:string;className:string;availability:string;record:string;assigned:number;submitted:number}[], statusCursor:"", statusVersion:0, statusLoaded:false, memberName: "", memberId: "", role: "", maintenance: "",
      autoApprovalActive: false, autoApprovalExpired: false, autoApprovalDeadline: "", autoApprovalUpdated: "", autoApprovalVersion: 0,
      selectedApplications: [] as string[], section: view === "manage" ? "members" : view === "records" ? "records" : "", rows: [] as Row[], cursor: "",
      sections: [{ id: "members", label: "成员" }, { id: "applications", label: "入组申请" }, { id: "autoApproved", label: "自动通过人员" }, { id: "rebindings", label: "换绑申请" }, { id: "classes", label: "班级" }, { id: "semesters", label: "学期" }, { id: "courses", label: "课表" }, { id: "audit", label: "操作记录" }],
      semesterId: "", semesterName: "", activeSemesterId: "", semesters: [] as Entity[], semesterOptions: [] as Option[], semesterCursor: "", semesterIndex: 0,
      fixedSemester: "", targetId: "", week: 1, weekData: { tasks: [], occurrences: [] } as WeekData, tasks: [] as Row[],
      record: null as Entity | null, recordFields: [] as { label: string; value: string }[], canEdit: false, versions: [] as Row[], versionCursor: "", photoUrls: [] as string[], canViewRecordPhotos:false,
      recordOptions: [] as (TaskCourseOption & {label:string})[], recordOptionIndex: 0,
      priorityScope: "", priorityGrade: "", priorityGradeIndex: 0, gradeOptions: ["不特别优先"] as string[],
      formType: "", formTitle: "", formId: "", formVersion: 0, fields: [] as Field[], formExtra: {} as Record<string, unknown>, photoIds: [] as string[], formPhotos: [] as string[],
      impacts: [] as Row[], stats: [] as {grade:string;count:number;valid:number;rate:string}[], statsCount: 0, statsLoaded: false, clearProgress: "", slots: [] as { key: string; label: string; checked: boolean }[], selectedSlots: [] as string[], optedIn: false, availabilityNote: "",
    },
    onLoad(q: Record<string, string>) { this.setData({section: view === "manage" && q.section === "applications" ? "applications" : this.data.section, fixedSemester: q.semesterId || "", targetId: q.id || q.taskId || "", week: Number(q.week) || 1, weekInitialized: Number(q.week) > 0 }); },
    onShow() {
      availabilityVisible = true;
      if (view === "availability") syncAvailabilityExitAlert(this.data.dirty);
      if (view === "schedule") {
        // Finish an existing load before applying a newly requested week.
        if (this.data.busy) { scheduleShowPending = true; return; }
        const focus = takeScheduleFocus();
        if (focus) {
          selectSemester(focus.semesterId);
          loadedKey = "";
          this.setData({fixedSemester:"",semesterId:focus.semesterId,week:focus.week,weekInitialized:true,
            hasLoaded:false,searchText:"",tasks:[],visibleTasks:[],homeTasks:[],weekData:{tasks:[],occurrences:[]},
            formType:"",fields:[],filePath:"",filename:"",statusRows:[],statusLoaded:false});
        }
      }
      // Only automatic tab re-entry may reuse data; explicit refresh and every write load afresh.
      if (["home", "schedule", "records", "profile"].includes(view) && this.data.hasLoaded && this.data.memberId &&
          !this.data.error && !this.data.maintenance && !reviewActive() && loadedKey === pageFreshnessKey() &&
          Date.now() - loadedAt >= 0 && Date.now() - loadedAt < 15000) return;
      return this.load();
    },
    onHide() { availabilityVisible = false; if (autoExpiryTimer) clearTimeout(autoExpiryTimer); },
    onUnload() { nextWeekLoad++; availabilityVisible = false; if (autoExpiryTimer) clearTimeout(autoExpiryTimer); if (view === "availability") syncAvailabilityExitAlert(false); },
    onPullDownRefresh() { void this.load().finally(() => wx.stopPullDownRefresh()); },
    async load(more = false): Promise<void> {
      if (this.data.busy) return;
      if (view === "home") { nextWeekLoad++; this.setData({homeNextTasks:[],nextWeekLoading:false,nextWeekError:"",nextWeekMessage:""}); }
      this.setData({ busy: true, reviewMode: reviewActive(), refreshing: this.data.hasLoaded && !more, loadingInitial: !this.data.hasLoaded && ["home", "schedule", "records", "profile"].includes(view), error: "", statsLoaded: this.data.hasLoaded && this.data.statsLoaded });
      try {
        const boot = view === "home" ? await bootstrap(true) : await pageBootstrap({
          view, section:this.data.section, semesterId:this.data.fixedSemester || (more ? this.data.semesterId : ""),
          selectionOwner:more ? this.data.memberId : undefined, week:this.data.weekInitialized ? this.data.week : undefined,
          targetId:this.data.targetId, cursor:more ? this.data.cursor : "", more,
        });
        const member = boot.member, bundle = view === "home" ? undefined : boot.page;
        const identityChanged = !!this.data.memberId && (this.data.memberId !== member?.id || this.data.role !== member?.data.role);
        const home = view === "home" ? boot.home : undefined;
        const admin = member?.data.role === "admin", manager = isManager(member?.data.role);
        if (this.data.memberId && (this.data.memberId !== member?.id || this.data.role !== member?.data.role)) this.setData({stats:[],statsLoaded:false,dirty:false,filePath:"",filename:"",pendingCount:0,pendingMore:false,pendingLabel:"",visibleRows:[],visibleTasks:[],record:null,versions:[],photoUrls:[],canViewRecordPhotos:false,formPhotos:[],photoIds:[],recordContext:null,recordOptions:[],priorityScope:"",priorityGrade:"",gradeOptions:["不特别优先"],metricFields:[],nameFields:[],feedbackFields:[],rows:[],tasks:[],homeTasks:[],formType:"",fields:[]});
        if(view === "records" && (this.data.memberId !== member?.id || this.data.role !== member?.data.role))this.setData({recordTab:canViewAllRecordPhotos(member?.data.role) ? "all" : "mine"});
        this.setData({coordinator:canCoordinate(member?.data.role),canAdjust:canAdjustTasks(member?.data.role),canExportNames:canExportNames(member?.data.role),canGenerate:canGeneratePlan(member?.data.role),canConfirm:canConfirmPlan(member?.data.role),canExportExcel:canExportFullXlsx(member?.data.role),canViewRecords:canViewAllRecords(member?.data.role),officer:member?.data.role === "officer",statusRows:[],statusCursor:"",statusLoaded:false});
        this.setData({ status: boot.status, canInitialize: boot.canInitialize, removed: !!boot.removed, admin, manager, memberName: s(member?.data.name), memberId: member?.id || "", role: s(member?.data.role), activeSemesterId: boot.workspace.activeSemesterId, maintenance: boot.workspace.maintenance });
        this.setData({roleLabel: admin ? "管理员" : manager ? "组部长" : member?.data.role === "officer" ? "信息部干事" : "普通成员", initial: s(member?.data.name).slice(0,1), studentNo: s(member?.data.studentNo)});
        if (!member || !member.data.active) {
          this.setData({ stats:[],statsLoaded:false,dirty:false,pendingCount:0,pendingMore:false,pendingLabel:"",filePath:"",filename:"",visibleRows:[],visibleTasks:[],rows: [], tasks: [], homeTasks: [], semesters: [], record: null, versions: [], photoUrls: [], canViewRecordPhotos:false, formPhotos:[],photoIds:[],recordContext:null,recordOptions:[],priorityScope:"",priorityGrade:"",gradeOptions:["不特别优先"],metricFields:[],nameFields:[],feedbackFields:[],fields: [], formType: "" });
          if (boot.status !== "needsAdministrator") {
            this.setData({ rows: boot.application ? [row(boot.application)] : [], cursor: "" });
          }
          return;
        }
        if (identityChanged && more) throw new Error("身份已变化，请刷新后重试");
        if (boot.workspace.maintenance) return;
        if (bundle && more) {
          this.setData({rows:this.data.rows.concat((bundle.list?.items || []).map(row)).map(r=>({...r,selected:this.data.selectedApplications.includes(r.id)})),cursor:bundle.list?.cursor || ""});
          this.filterRows();
          return;
        }
        if (view === "profile" && bundle?.profile) {
          const {className,pendingCount} = bundle.profile;
          this.setData({className,pendingCount,pendingMore:false,pendingLabel:pendingCount ? `${pendingCount} 待审核` : ""});
        } else if (view === "profile") {
          const classes = await optionsFor("classes");
          this.setData({className: classes.find(c => c.value === member.data.classId)?.label || "班级未设置",pendingCount:0,pendingMore:false,pendingLabel:""});
          if (manager) {
            const applications = await query("applications");
            const count = applications.data.items.filter(a => a.data.status === "pending").length, more = !!applications.cursor;
            this.setData({pendingCount:count,pendingMore:more,pendingLabel:count ? `${count}${more ? "+" : ""} 待审核` : more ? "查看申请" : ""});
          }
        }
        if (bundle?.semesters) {
          const {items,cursor} = bundle.semesters;
          this.setData({semesters:items,semesterCursor:cursor,semesterOptions:items.map(e=>({label:s(e.data.name),value:e.id}))});
        } else if (home) {
          const semesters = home.semester ? [home.semester] : [];
          this.setData({ semesters, semesterCursor: "", semesterOptions: semesters.map(e => ({label: s(e.data.name), value: e.id})) });
        } else if (!this.data.semesters.length || !more) {
          const response = await query("semesters");
          this.setData({ semesters: response.data.items, semesterCursor: response.cursor || "", semesterOptions: response.data.items.map(e => ({label: s(e.data.name), value: e.id})) });
        }
        const selected = bundle ? bundle.semester?.id || "" : home ? boot.workspace.activeSemesterId : this.data.fixedSemester || (view === "home" || view === "availability" ? boot.workspace.activeSemesterId : viewSemester());
        let selectedSemester = bundle?.semester || this.data.semesters.find(e => e.id === selected);
        if (selected && !selectedSemester) selectedSemester = (await query<{semester:Entity}>("semester", selected)).data.semester;
        const semesterId = selected || boot.workspace.activeSemesterId;
        const maxWeek = Number(selectedSemester?.data.weeks || 60);
        const calendarWeek = home?.week ?? (selectedSemester?.data.startDate ? boundedWeek(selectedSemester.data as unknown as Semester) : 1);
        const displayedWeek = bundle ? bundle.week : view === "home" ? calendarWeek : !this.data.weekInitialized && ["schedule","availability","records"].includes(view)
          ? Math.min(maxWeek, calendarWeek + (["schedule","availability"].includes(view) ? 1 : 0)) : Math.min(maxWeek, Math.max(1,this.data.week));
        if (!semesterId) this.setData({tasks:[],homeTasks:[],weekData:{tasks:[],occurrences:[]},taskCount:0,recordCount:0,coverage:0,weekTotal:0,weekSubmitted:0,weekProgress:0,availabilityReady:false});
        this.setData({ semesterId, semesterIndex: Math.max(0, this.data.semesters.findIndex(e => e.id === semesterId)), semesterName: s(selectedSemester?.data.name || (semesterId ? "所选历史学期" : "尚未启用学期")) });
        this.setData({week: displayedWeek, maxWeek, weekInitialized: !!semesterId, dates: selectedSemester?.data.startDate ? weekRange(selectedSemester.data as unknown as Semester, displayedWeek) : "", statsLoaded: this.data.week === displayedWeek && this.data.statsLoaded});
        if (view === "manage" || view === "records" || view === "courses") {
          const kind = view === "manage" ? this.data.section : view === "courses" ? "courses" : "records";
          if (admin && view === "manage" && ["applications", "autoApproved"].includes(kind)) {
            const setting = bundle?.autoApproval ? {data:bundle.autoApproval} : await query<AutoApprovalView>("autoApproval");
            const {data} = setting;
            this.setData({autoApprovalActive:data.active,autoApprovalExpired:data.expired,autoApprovalVersion:data.version,autoApprovalDeadline:localTime(data.setting?.expiresAt || ""),autoApprovalUpdated:data.setting ? data.setting.updatedByName + " · " + localTime(data.setting.updatedAt) : "尚未开启"});
            if (autoExpiryTimer) clearTimeout(autoExpiryTimer);
            if (data.active && data.setting) {
              const expire = () => { const remaining = Date.parse(data.setting!.expiresAt) - data.serverNow - (Date.now() - started); if (remaining <= 0) this.setData({autoApprovalActive:false,autoApprovalExpired:true}); else autoExpiryTimer = setTimeout(expire,Math.min(remaining,2147483647)); };
              const started = Date.now(); expire();
            }
          }
          if (!manager && view === "manage") throw new Error("无管理权限");
          if (view === "manage" && !admin && ["classes", "semesters", "courses"].includes(kind)) throw new Error("此维护入口仅管理员可用");
          if (["courses", "records"].includes(kind) && !semesterId) { this.setData({ rows: [], cursor: "" }); return; }
          if (view === "records" && bundle?.summary) {
            const {total,submitted,skipped} = bundle.summary;
            this.setData({weekTotal:total,weekSubmitted:submitted,weekProgress:total ? Math.min(100,Math.round(submitted / total * 100)) : 0,skipped});
          } else if (view === "records" && semesterId) {
            const w = (await query<WeekData>("week", semesterId, {week:this.data.week})).data;
            const total = w.tasks.filter(t => ["confirmed","submitted","pendingAdjustment"].includes(s(t.data.status))).length;
            const submitted = (w.records || []).length;
            this.setData({weekTotal:total,weekSubmitted:submitted,weekProgress:total ? Math.min(100,Math.round(submitted / total * 100)) : 0,skipped:w.plan?.data.status === "skipped"});
          }
          const response = bundle?.list ? {data:{items:bundle.list.items},cursor:bundle.list.cursor} : await query(kind, ["courses", "records"].includes(kind) ? semesterId : "", kind === "records" ? { week: this.data.week } : {}, more ? this.data.cursor : "");
          if(kind === "courses" && (!more || !this.data.courseClasses.length)) {
            const classes = bundle?.classes ? {data:{items:bundle.classes.items},cursor:bundle.classes.cursor} : await query("classes");this.setData({courseClasses:classes.data.items,courseClassCursor:classes.cursor || ""});
          }
          this.setData({ rows: (more ? this.data.rows : []).concat(response.data.items.map(row)).map(r=>({...r,selected:this.data.selectedApplications.includes(r.id)})), cursor: response.cursor || "" });
        } else if (["home", "schedule", "availability"].includes(view) && semesterId) {
          const w = bundle?.weekData || home?.weekData || (await query<WeekData>("week", semesterId, { week: displayedWeek })).data;
          if (view === "schedule") {
            const grades = w.gradeOptions || [];
            const scope = [boot.workspace.epoch,member.id,semesterId,displayedWeek].join(":");
            const preferred = scope === this.data.priorityScope ? this.data.priorityGrade : s(w.draft?.data.priorityGrade);
            const selected = grades.includes(preferred) ? preferred : "";
            this.setData({priorityScope:scope,priorityGrade:selected,gradeOptions:["不特别优先",...grades],priorityGradeIndex:selected ? grades.indexOf(selected)+1 : 0});
          }
          const visibleTasks = (w.tasks || []).filter(t => ["confirmed","submitted","pendingAdjustment"].includes(s(t.data.status)));
          this.setData({ weekData: w, tasks: (w.tasks || []).map(row), availabilityReady: !!w.availability,
            taskCount: home?.summary?.taskCount ?? visibleTasks.length, recordCount: home?.summary?.recordCount ?? (w.records || []).length, coverage: home?.summary?.coverage ?? new Set((w.records || []).map(r => s(r.data.classLabel))).size, skipped: w.plan?.data.status === "skipped",
            homeTasks: visibleTasks.filter(t => t.memberId === member.id).map(t=>homeTask(t,w.records)) });
          if (view === "availability") {
            const days = Number(w.semester?.data.days || selectedSemester?.data.days || 5), periods = Number(w.semester?.data.periods || selectedSemester?.data.periods || 14);
            const own = w.availability;
            const selectedSlots = Array.isArray(own?.data.slots) ? own.data.slots.map(String) : [];
            if (!this.data.dirty) this.setData({ selectedSlots, optedIn: own?.data.optedIn === true, availabilityNote: s(own?.data.note), slots: Array.from({ length: days * periods }, (_, i) => { const d = Math.floor(i / periods) + 1, p = i % periods + 1, key = d + ":" + p; return { key, label: "周" + "一二三四五六日"[d - 1] + "第" + p + "节", checked: selectedSlots.includes(key) }; }) });
          }
          if (view === "availability") this.setData(availabilityGrid(this.data.slots, this.data.selectedSlots));
        } else if (view === "record" && this.data.targetId) {
          const response = bundle?.record ? {data:bundle.record} : await query<{ record: Entity; canEdit: boolean }>("record", semesterId, { id: this.data.targetId });
          const record = response.data.record;
          const metrics = record.data.metrics as Record<string, number>;
          const canViewRecordPhotos = record.memberId === member.id || canViewAllRecordPhotos(member.data.role);
          this.setData({ record, canViewRecordPhotos, photoUrls: [], canEdit: response.data.canEdit, recordFields: METRIC_FIELDS.map(f => ({ label: f.label, value: metrics?.[f.key] === -1 ? "信息缺失" : s(metrics?.[f.key]) })) });
          if (canViewRecordPhotos) {
            const urls = await call<{ urls: string[] }>("photoUrls", { semesterId, payload: { recordId: record.id } });
            this.setData({ photoUrls: urls.data.urls });
          }
        } else if (view === "submission" && this.data.targetId && !this.data.formType) {
          const response = bundle?.task ? {data:{task:bundle.task}} : await query<{ task: Entity }>("task", semesterId, { id: this.data.targetId });
          this.openRecordForm(response.data.task);
        }
        this.filterRows();
      } catch (e) {
        const message = e instanceof Error ? e.message : "连接失败";
        if (/权限|身份|登录|未授权|无权|资格|未审核|AUTH|PERMISSION|DENIED|FORBIDDEN|UNAUTHORIZED/i.test(message)) this.setData({dirty:false,coordinator:false,canGenerate:false,canConfirm:false,canExportExcel:false,canAdjust:false,canExportNames:false,officer:false,statusRows:[],statusLoaded:false,memberId:"",memberName:"",studentNo:"",className:"",initial:"",role:"",roleLabel:"",admin:false,manager:false,canViewRecords:false,semesters:[],semesterOptions:[],semesterId:"",rows:[],visibleRows:[],tasks:[],visibleTasks:[],homeTasks:[],record:null,recordFields:[],versions:[],photoUrls:[],canViewRecordPhotos:false,formPhotos:[],photoIds:[],fields:[],formType:"",stats:[],statsLoaded:false,hasLoaded:false});
        // A failed refresh cannot authorize actions from a previously rendered identity.
        this.setData({ error: message, canGenerate:false, canConfirm:false, canExportExcel:false, canAdjust:false, canExportNames:false });
      }
      finally {
        this.setData({ busy: false, refreshing: false, loadingInitial: false, hasLoaded: this.data.hasLoaded || !this.data.error });
        if (view === "availability" && availabilityVisible) syncAvailabilityExitAlert(this.data.dirty);
        if (!this.data.error) { loadedAt = Date.now(); loadedKey = pageFreshnessKey(); }
        if (view === "schedule" && scheduleShowPending) {
          scheduleShowPending = false;
          await this.onShow();
        }
      }
      if (view === "home" && this.data.memberId && this.data.semesterId && !this.data.error && !this.data.maintenance) await this.loadNextWeek();
      if (view === "records" && this.data.recordTab === "stats" && this.data.semesterId && !this.data.error) await this.showStats(true);
    },
    async loadNextWeek() {
      if (view !== "home" || this.data.busy || this.data.nextWeekLoading || !this.data.memberId || !this.data.semesterId || this.data.error || this.data.maintenance)return;
      let session: Boot;
      try { session=currentBoot(); } catch { this.setData({homeNextTasks:[],nextWeekError:"请刷新首页后重试"}); return; }
      const week=this.data.week+1,semesterId=this.data.semesterId,memberId=this.data.memberId;
      const epoch=session.workspace.epoch,permissions=session.workspace.permissionsVersion,token=++nextWeekLoad;
      this.setData({nextWeek:week,homeNextTasks:[],nextWeekError:"",nextWeekMessage:""});
      if(week>this.data.maxWeek){this.setData({nextWeekMessage:"本学期没有下周"});return;}
      this.setData({nextWeekLoading:true});
      const current=()=>{try{return token===nextWeekLoad && this.data.memberId===memberId && this.data.semesterId===semesterId && currentBoot().workspace.epoch===epoch && currentBoot().member?.id===memberId;}catch{return false;}};
      try {
        // Use the existing single-RPC schedule reader without changing the saved page/session.
        const result=await call<Boot>("bootstrap",{payload:{fastPage:true,page:{view:"schedule",semesterId,week}}});
        if(!current())return;
        const boot=result.data,page=boot.page;
        if(boot.workspace.epoch!==epoch || boot.workspace.permissionsVersion!==permissions || boot.member?.id!==memberId || !boot.member.data.active)throw new Error("身份或权限已变化，请刷新首页");
        if(boot.workspace.maintenance)throw new Error("业务数据正在维护，请稍后重试");
        if(!page?.weekData || page.semester?.id!==semesterId || page.week!==week)throw new Error("下周安排暂时无法读取，请重试");
        const w=page.weekData,tasks=w.tasks.filter(t=>t.memberId===memberId && ["confirmed","submitted","pendingAdjustment"].includes(s(t.data.status)));
        this.setData({homeNextTasks:tasks.map(t=>homeTask(t,w.records)),nextWeekMessage:w.plan?.data.status==="skipped" ? "下周已跳过听课" : !w.plan ? "下周安排尚未发布" : "下周暂无个人任务"});
      }catch(e){if(current())this.setData({homeNextTasks:[],nextWeekError:e instanceof Error ? e.message : "下周任务加载失败，请重试"});}
      finally{if(token===nextWeekLoad)this.setData({nextWeekLoading:false});}
    },
    async more() { await this.load(true); },
    async moreSemesters() {
      if (!this.data.semesterCursor) return;
      try { const r = await query("semesters", "", {}, this.data.semesterCursor); this.setData({ semesters: this.data.semesters.concat(r.data.items), semesterCursor: r.cursor || "", semesterOptions: this.data.semesters.concat(r.data.items).map(e => ({label: s(e.data.name), value: e.id})) }); } catch (e) { displayError(e); }
    },
    filterRows() {
      const needle = this.data.searchText.trim().toLowerCase();
      const courseView = view === "courses" || view === "manage" && this.data.section === "courses";
      let rows = this.data.rows;
      if(courseView) {
        let incomplete = false;
        rows = rows.map(r => {
          const c=(r.data.course || {}) as Record<string,unknown>, ids=Array.isArray(c.classIds) ? c.classIds.map(String) : [];
          const classes=ids.map(id=>this.data.courseClasses.find(k=>k.id === id));
          if(classes.some(k=>!k))incomplete=true;
          const courseClassLabel=classes.map(k=>k ? s(k.data.name) : "班级资料未加载").join(" / ");
          return {...row(r),courseClassLabel,courseGrades:[...new Set(classes.filter((k):k is Entity=>!!k).map(k=>s(k.data.grade)))],detail:[courseClassLabel,s(c.teacher),s(c.nature),`周${"一二三四五六日"[Number(c.weekday)-1] || "?"} · 第${c.start}–${c.end}节`,s(c.classroom)].filter(Boolean).join(" · ")};
        });
        this.setData({rows,courseGrades:[...new Set(rows.flatMap(r=>r.courseGrades || []))].sort(),courseClassesIncomplete:incomplete});
      }
      const matches = (r: Row) => !needle || [r.label,r.detail,r.data.name,r.data.memberName,r.data.studentNo,(r.data.course as Record<string,unknown>)?.name,...r.courseCounts.map(c=>c.label)].map(s).join(" ").toLowerCase().includes(needle);
      this.setData({visibleRows:rows.filter(r => matches(r) && (!courseView || this.data.courseGrade === "全部" || (r.courseGrades || []).includes(this.data.courseGrade)) && (view !== "records" || this.data.recordTab !== "mine" || r.memberId === this.data.memberId) && (view !== "manage" || this.data.section !== "applications" || this.data.applicationFilter !== "pending" || r.status === "pending")),visibleTasks:this.data.tasks.filter(r => ["confirmed","submitted","pendingAdjustment"].includes(r.status) && matches(r))});
    },
    filterCourseGrade(e: UiEvent) { if(this.data.busy)return; this.setData({courseGrade:e.currentTarget.dataset.grade});this.filterRows(); },
    async moreCourseClasses() {
      if(this.data.busy || !this.data.courseClassCursor)return;this.setData({busy:true});
      try {const response=await query("classes","",{},this.data.courseClassCursor);this.setData({courseClasses:this.data.courseClasses.concat(response.data.items),courseClassCursor:response.cursor || ""});this.filterRows();}catch(e){displayError(e);}finally{this.setData({busy:false});}
    },
    courseDetails(e: UiEvent) {
      const r=this.data.rows.find(r=>r.id === e.currentTarget.dataset.id);if(!r)return;
      const c=(r.data.course || {}) as Record<string,unknown>;
      wx.showModal({title:s(c.name),content:`${r.detail}\n有效周次：${Array.isArray(c.weeks) ? c.weeks.join("、") : "未提供"}\n课表人数：${c.expected === undefined ? "未提供" : c.expected}\n${r.active ? "课程有效；具体日期以停调课及正式任务为准" : "课程已停用"}`,showCancel:false});
    },
    search(e: UiEvent) { this.setData({searchText:e.detail.value,selectedApplications:[],rows:this.data.rows.map(r=>({...r,selected:false}))}); this.filterRows(); },
    applicationFilter(e: UiEvent) { if(this.data.busy)return; this.setData({applicationFilter:e.currentTarget.dataset.id,selectedApplications:[],rows:this.data.rows.map(r=>({...r,selected:false}))});this.filterRows(); },
    section(e: UiEvent) { if (this.data.busy) return; this.setData({ section: e.currentTarget.dataset.id, courseGrade:"全部",courseClasses:[],courseClassCursor:"",selectedApplications: [], rows: [], visibleRows:[], searchText:"",cursor: "", formType: "" }); void this.load(); },
    chooseSemester(e: UiEvent) { if (this.data.busy) return; const chosen = this.data.semesters[Number(e.detail.value)]; if (!chosen) return; selectSemester(chosen.id); this.setData({ fixedSemester: "", semesterId: chosen.id, courseGrade:"全部",courseClasses:[],courseClassCursor:"",formType: "", rows: [], visibleRows:[], filePath:"",filename:"",statsLoaded:false,week: 1,weekInitialized:chosen.id !== this.data.activeSemesterId }); void this.load(); },
    weekChange(e: UiEvent) { const next = Number(e.detail.value); if (Number.isInteger(next) && next >= 1 && next <= 60) this.setData({ week: next }); },
    refreshWeek() { void this.load(); },
    recordTab(e: UiEvent) { if(this.data.busy)return; this.setData({recordTab:e.currentTarget.dataset.id}); this.filterRows(); if (e.currentTarget.dataset.id === "stats" && this.data.semesterId) void this.showStats(); },
    async moveWeek(e: UiEvent) {
      if (!this.data.semesterId || this.data.busy) return;
      const next = Math.min(this.data.maxWeek, Math.max(1, this.data.week + Number(e.currentTarget.dataset.delta)));
      if(next === this.data.week)return;
      if(this.data.dirty && !(await wx.showModal({title:"尚未保存",content:"切换周次会放弃本页未保存的无课时间修改。"})).confirm)return;
      this.setData({week:next, rows:[],visibleRows:[],visibleTasks:[],filePath:"",filename:"",cursor:"",formType:"",statsLoaded:false,dirty:false}); await this.load();
    },
    toggleSlot(e: UiEvent) {
      if(this.data.busy)return;
      const key = e.currentTarget.dataset.key;
      const selected = this.data.selectedSlots.includes(key) ? this.data.selectedSlots.filter(s => s !== key) : this.data.selectedSlots.concat(key);
      this.setData({dirty:true,selectedSlots:selected, ...availabilityGrid(this.data.slots, selected)});
      syncAvailabilityExitAlert(true);
    },
    toggleDay(e: UiEvent) {
      if(this.data.busy)return;
      const keys = this.data.slots.filter(s => s.key.startsWith(e.currentTarget.dataset.day + ":")).map(s => s.key);
      const all = keys.every(k => this.data.selectedSlots.includes(k));
      const selected = this.data.selectedSlots.filter(k => !keys.includes(k)).concat(all ? [] : keys);
      this.setData({dirty:true,selectedSlots:selected, ...availabilityGrid(this.data.slots, selected)});
      syncAvailabilityExitAlert(true);
    },
    rules() { wx.showModal({title:"听课与提交说明",content:"1. 不能听自己班，每周最多一次。\n2. 无课时间按周保存，以正式安排为准。\n3. 按实际情况填写人数，缺失信息单独标记。\n4. 上传清晰、带有老师签字的听课表。",showCancel:false}); },
    async navigate(e: UiEvent) {
      const target = e.currentTarget.dataset.target;
      if (view === "availability" && this.data.dirty) {
        if (!(await wx.showModal({title:"尚未保存",content:"无课时间还未保存，确定离开吗？",confirmText:"离开",cancelText:"继续填写"})).confirm) return;
        syncAvailabilityExitAlert(false);
      }
      if (["schedule", "reports", "profile", "index"].includes(target)) {
        const cancelFocus = target === "schedule" && view === "home"
          ? queueScheduleFocus(this.data.semesterId, Number(e.currentTarget.dataset.week) || this.data.week) : () => {};
        wx.switchTab({url:"/pages/" + target + "/" + target, fail:cancelFocus}); return;
      }
      if (["manage", "courses", "availability", "join", "review"].includes(target)) {
        const params = target === "manage" && e.currentTarget.dataset.section ? "?section=" + encodeURIComponent(e.currentTarget.dataset.section) : target === "availability" && view === "schedule" ? "?week=" + this.data.week + "&semesterId=" + encodeURIComponent(this.data.semesterId) : target === "courses" ? "?semesterId=" + encodeURIComponent(this.data.semesterId) : "";
        wx.navigateTo({ url: "/pages/" + target + "/" + target + params });
      }
    },
    open(e: UiEvent) {
      if (e.currentTarget.dataset.target === "record") { wx.navigateTo({url:"/pages/record/record?id=" + e.currentTarget.dataset.id + "&semesterId=" + this.data.semesterId}); return; }
      const id = e.currentTarget.dataset.id;
      if (view === "records") wx.navigateTo({ url: "/pages/record/record?id=" + encodeURIComponent(id) + "&semesterId=" + encodeURIComponent(this.data.semesterId) });
      else if (["home", "schedule"].includes(view)) wx.navigateTo({ url: "/pages/submission/submission?taskId=" + encodeURIComponent(id) + "&semesterId=" + encodeURIComponent(this.data.semesterId) });
    },
    async edit(e: UiEvent) {
      if (this.data.busy) return;
      const entity = this.data.rows.find(r => r.id === e.currentTarget.dataset.id);
      await this.openForm(this.data.section === "classes" ? "classSave" : this.data.section === "courses" || view === "courses" ? "courseSave" : "semesterCreate", entity);
    },
    async newForm(e: UiEvent) { const type = e.currentTarget.dataset.type; await this.openForm(type, type === "join" ? currentBoot().application || undefined : undefined); },
    async openForm(type: string, entity?: Entity): Promise<void> {
      try {
        const d = { ...entity?.data, ...(entity?.data.course as Record<string, unknown> || {}) }, id = entity?.id || "", options = () => optionsFor("classes");
        let fields: Field[] = [], extra: Record<string, unknown> = {};
        if (type === "autoApprovalSet") fields = [field("deadlineDate", "截止日期（北京时间）", "", "date"), field("deadlineTime", "截止时刻（北京时间）", "", "time")];
        if (type === "classSave") fields = [field("name", "班级名称", d.name), field("grade", "入学年级（两位数字）", d.grade), field("major", "专业", d.major)];
        if (type === "semesterCreate") fields = [field("name", "学期名称"), field("startDate", "第一周周一", "", "date"), field("weeksCount", "教学周数", "20", "number"), field("days", "每周上课天数", "5", "number"), field("periods", "每天节数", "14", "number"), field("edition", "组织名称", "西南大学计信院学风督察小组")];
        if (type === "semesterParticipants") { const current = await query<{classIds: string[]}>("semester", id); fields = [field("classIds", "参与督察班级", current.data.classIds, "multi", await options())]; }
        if (type === "courseSave") fields = [field("name", "课程名称", d.name), field("teacher", "授课教师", d.teacher), field("nature", "课程性质", d.nature || "必修"), field("classIds", "教学班级（可多选）", d.classIds || [], "multi", await options()), field("classroom", "教室", d.classroom), field("weekday", "星期（1至7）", d.weekday || 1, "number"), field("start", "开始节次", d.start || 1, "number"), field("end", "结束节次", d.end || 2, "number"), field("weeks", "有效周次，例如1-16或1,3,5", Array.isArray(d.weeks) ? d.weeks.join(",") : "1-16"), field("expected", "应到人数", d.expected || 0, "number"), field("effectiveDate", "生效日期", d.effectiveDate || "", "date")];
        if (type === "exceptionSave") { extra.courseId = id; fields = [field("date", "原上课日期", "", "date"), field("kind", "调整类型", "0", "select", [{ value: "cancel", label: "停课" }, { value: "move", label: "调课" }, { value: "extra", label: "补课" }]), field("newDate", "调课／补课日期", "", "date"), field("start", "开始节次", d.start || 1, "number"), field("end", "结束节次", d.end || 2, "number"), field("classroom", "教室", d.classroom), field("reason", "调整原因", "", "textarea")]; }
        if (type === "join") { const classes = await options(); fields = [field("name", "本人真实姓名", d.name), field("studentNo", "学号", d.studentNo), field("classId", "本人班级", Math.max(0,classes.findIndex(c => c.value === d.classId)), "select", classes)]; }
        if (type === "initialize") fields = [field("semesterName", "学期名称"), field("startDate", "第一周周一", "", "date"), field("weeksCount", "教学周数", "20", "number"), field("grade", "本人入学年级（两位数字）"), field("major", "本人专业"), field("className", "本人班级名称"), field("name", "本人真实姓名"), field("studentNo", "本人学号")];
        if (type === "rebindRequest") fields = [field("studentNo", "原成员学号"), field("reason", "换绑原因（需管理员线下核实）", "", "textarea")];
        let pending: ImportPlan | null = null, pendingError = "";
        if (type === "import") try { pending = readImportPlan(this.data.semesterId); }
        catch(e) { pendingError = e instanceof Error ? e.message : "本机导入续传状态不可用"; }
        const importSource = pending ? JSON.parse(pending.sourceText) as {courses:Record<string,unknown>[];classes?:unknown[]} : null;
        if (type === "import") fields = [field("text", "粘贴JSON课表（先解析预览）", pending?.sourceText || "", "textarea")];
        this.setData({ importPreview:importSource ? importSource.courses.slice(0,20).map((c,i)=>`${i+1}. ${s(c?.name) || "未填写课程名称"} · ${s(c?.teacher)} · ${s(c?.classroom)}`) : [],
          importReady:!!pending,importPending:!!pending || !!pendingError,importCount:importSource?.courses.length || 0,importClassCount:importSource?.classes?.length || 0,
          importProgress:pending ? `待续传：已完成 ${pending.next}/${pending.batches.length} 批` : pendingError,
          formType: type, formTitle: ({ autoApprovalSet: "限时自动通过新申请", classSave: "维护班级", courseSave: "维护课程", semesterCreate: "建立学期草稿", semesterParticipants: "选择参与班级", exceptionSave: "停课与调补课", join: "提交入组申请", initialize: "首次登记", rebindRequest: "申请微信换绑", import: "JSON课表导入" } as Record<string, string>)[type] || "维护资料", formId: id, formVersion: type === "autoApprovalSet" ? this.data.autoApprovalVersion : entity?.version || 0, fields: fields.map(f => ({ ...f, options: f.options.map(o => ({ ...o, checked: f.selected.includes(o.value) })) })), formExtra: extra, photoIds: [], formPhotos: [] }, () => {
            if (view === "manage" && typeof wx.pageScrollTo === "function") wx.pageScrollTo({selector:"#v2-active-form",duration:200});
          });
      } catch (e) { displayError(e); }
    },
    input(e: UiEvent) {
      const key = e.currentTarget.dataset.key;
      const fields = this.data.fields.map(f => f.key === key ? { ...f, value: e.detail.value } : f);
      this.setData({ fields, ...(key === "text" ? {importReady:false,importPreview:[]} : {}) });
      this.renderRecordFields();
    },
    multi(e: WechatMiniprogram.CheckboxGroupChange) { const key = s(e.currentTarget.dataset.key); this.setData({ fields: this.data.fields.map(f => f.key === key ? { ...f, selected: e.detail.value } : f) }); },
    async chooseImportFile() {
      if(this.data.busy || !this.data.admin || this.data.formType !== "import")return;
      this.setData({busy:true});
      try {
        const result=await wx.chooseMessageFile({count:1,type:"file",extension:["json","txt"]}),file=result.tempFiles[0];
        if(!file)return;if(file.size>1024*1024)throw new Error("请选择小于1MB的JSON或TXT文件");
        const content=await new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file.path,encoding:"utf8",success:r=>resolve(String(r.data).replace(/^\uFEFF/,"")),fail:()=>reject(new Error("文件读取失败"))}));
        if(content.length>300000)throw new Error("导入内容过大，请分批导入");
        this.setData({fields:this.data.fields.map(f=>f.key === "text" ? {...f,value:content} : f),importReady:false,importPreview:[]});
      }catch(e){if(!(e && typeof e === "object" && "errMsg" in e && /cancel/.test(String(e.errMsg))))displayError(e);}finally{this.setData({busy:false});}
    },
    previewImport() {
      try {
        const content=this.data.fields.find(f=>f.key === "text")?.value || "";
        if(content.length>300000)throw new Error("导入内容过大，请分批导入");
        const parsed=JSON.parse(content);
        if(!parsed || !Array.isArray(parsed.courses) || !parsed.courses.length)throw new Error("JSON缺少有效的courses课程列表");
        if(parsed.members !== undefined)throw new Error("成员通过申请加入，不支持导入成员");
        if(parsed.classes !== undefined && !Array.isArray(parsed.classes))throw new Error("classes必须是班级列表");
        this.setData({importReady:true,importCount:parsed.courses.length,importClassCount:parsed.classes?.length || 0,importPreview:parsed.courses.slice(0,20).map((c:Record<string,unknown>,i:number)=>`${i+1}. ${s(c?.name) || "未填写课程名称"} · ${s(c?.teacher)} · ${s(c?.classroom)}`)});
      }catch(e){this.setData({importReady:false,importPreview:[]});displayError(e);}
    },
    restoreImport() {
      try {
        const pending = readImportPlan(this.data.semesterId);
        if (!pending) throw new Error("没有可续传的导入");
        const parsed = JSON.parse(pending.sourceText);
        this.setData({fields:this.data.fields.map(f=>f.key === "text" ? {...f,value:pending.sourceText} : f),importReady:true,importPending:true,
          importCount:parsed.courses.length,importClassCount:parsed.classes?.length || 0,
          importPreview:parsed.courses.slice(0,20).map((c:Record<string,unknown>,i:number)=>`${i+1}. ${s(c?.name) || "未填写课程名称"} · ${s(c?.teacher)} · ${s(c?.classroom)}`),
          importProgress:`待续传：已完成 ${pending.next}/${pending.batches.length} 批`});
      } catch(e) { displayError(e); }
    },
    async discardImport() {
      if (this.data.busy) return;
      const answer = await wx.showModal({title:"清除本机续传记录",content:"只清除本机的导入进度，不删除云端已成功导入的班级和课程。重新导入相同全文会因重复 ID 被拒绝，请先核对云端列表。"});
      if (!answer.confirm) return;
      wx.removeStorageSync(importPlanKey(this.data.semesterId));
      this.setData({importPending:false,importReady:false,importProgress:"已清除本机续传记录；云端已成功批次仍保留。"});
    },
    async runImport(content: string): Promise<boolean> {
      const semesterId = this.data.semesterId, key = importPlanKey(semesterId);
      let plan = readImportPlan(semesterId);
      if (plan && plan.sourceText !== content) throw new Error("存在未完成导入，请恢复上次内容继续；不能用新文件覆盖续传状态");
      if (!plan) {
        if (reviewActive()) {
          const sample = JSON.parse(content) as {courses?:unknown[]};
          if ((sample.courses?.length || 0) > 20) throw new Error("审核样例仅支持少量课程体验；完整课表请在真实业务身份中导入");
        }
        this.setData({importProgress:"正在校验完整课表，尚未写入云端…"});
        const inspection = await query<{courses:number;classes:number}>("importInspect",semesterId,{text:content});
        const batches = planCourseImport(content,requestId);
        if (batches.reduce((n,b)=>n+b.courses,0) !== inspection.data.courses || batches.reduce((n,b)=>n+b.classes,0) !== inspection.data.classes)
          throw new Error("分批计划与完整课表数量不符，已停止导入");
        const answer = await wx.showModal({title:"确认分批导入",content:`完整校验通过：${inspection.data.courses} 条课程、${inspection.data.classes} 个班级。将分 ${batches.length} 批写入；中断后可在本机继续，已成功批次不会回滚。`});
        if (!answer.confirm) { this.setData({importProgress:"已取消，未写入云端。"}); return false; }
        const boot = currentBoot();
        plan = {sourceText:content,semesterId,epoch:boot.workspace.epoch,memberId:boot.member!.id,
          permissionsVersion:boot.workspace.permissionsVersion,next:0,batches};
        wx.setStorageSync(key,plan); // Must persist request IDs before the first write.
      } else {
        const answer = await wx.showModal({title:"继续导入",content:`已完成 ${plan.next}/${plan.batches.length} 批。将用原请求号重试当前批次，并继续剩余课程。`});
        if (!answer.confirm) return false;
      }
      this.setData({importPending:true});
      while (plan.next < plan.batches.length) {
        const batch = plan.batches[plan.next];
        this.setData({importProgress:`正在导入 ${plan.next+1}/${plan.batches.length} 批（${batch.courses} 条课程、${batch.dates} 个日期）…`});
        await call("command",{semesterId,requestId:batch.requestId,payload:{type:"import",text:batch.text}});
        plan.next++;
        wx.setStorageSync(key,plan); // Lost response retries the same request ID; no duplicate commit.
      }
      wx.removeStorageSync(key);
      this.setData({importPending:false,importProgress:`导入完成：${plan.batches.length} 批，全部课程已提交。`});
      return true;
    },
    cancelForm() { if(this.data.busy)return; this.setData({ formType: "", photoIds: [], formPhotos: [],uploadingPhoto:"",recordContext:null }); },
    async saveForm() {
      if (this.data.busy) return;
      if (this.data.formType === "taskAdjust" && (this.data.error || !this.data.canAdjust || !canAdjustTasks(currentBoot().member?.data.role))) return;
      let admitted = false;
      this.setData({ busy: true });
      try {
        const type = this.data.formType, payload: Record<string, unknown> = { ...this.data.formExtra };
        for (const f of this.data.fields) payload[f.key] = f.kind === "multi" ? f.selected : f.kind === "select" ? f.options[Number(f.value)]?.value || "" : numberFields.has(f.key) ? Number(f.value === "信息缺失" ? -1 : f.value) : f.value;
        if (type === "autoApprovalSet") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(s(payload.deadlineDate)) || !/^\d{2}:\d{2}$/.test(s(payload.deadlineTime))) throw new Error("请完整设置截止日期和时间");
          payload.enabled = true; payload.expiresAt = s(payload.deadlineDate) + "T" + s(payload.deadlineTime) + ":00+08:00";
          delete payload.deadlineDate; delete payload.deadlineTime;
        }
        if (this.data.formId) payload.id = this.data.formId;
        if (type === "taskAdjust") { payload.changes = [{ ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(payload.cancel === "true" ? { cancel: true } : { memberId: payload.memberId, occurrenceId: payload.occurrenceId }) }]; delete payload.taskId; delete payload.memberId; delete payload.occurrenceId; delete payload.cancel; }
        if (type === "courseSave") payload.weeks = rangeList(s(payload.weeks));
        if (type === "semesterCreate") { payload.weeks = payload.weeksCount; delete payload.weeksCount; }
        if (type === "import") {
          if(!this.data.importReady)throw new Error("请先解析预览，再确认导入");
          const parsed = JSON.parse(s(payload.text)) as { courses?: unknown[]; classes?: unknown[] };
          if (!Array.isArray(parsed.courses)) throw new Error("JSON缺少courses课程列表");
        }
        if (type === "recordSubmit" || type === "recordEdit") {
          const metrics: Record<string, number> = {};
          for (const f of METRIC_FIELDS) { const input = this.data.fields.find(x => x.key === f.key)?.value; if (!input?.trim()) throw new Error("请填写全部人数，未知请填“信息缺失”"); metrics[f.key] = Number(payload[f.key]); delete payload[f.key]; }
          payload.metrics = metrics; payload.photos = this.data.photoIds; if (type === "recordEdit") delete payload.taskId;
        }
        if (type === "initialize") {
          await call("initialize", { requestId: requestId(), expectedVersion: currentBoot().workspace.version, payload: {
            semester: { name: payload.semesterName, startDate: payload.startDate, weeks: payload.weeksCount, days: 5, periods: 14, edition: "西南大学计信院学风督察小组" },
            schoolClass: { name: payload.className, grade: payload.grade, major: payload.major }, member: { name: payload.name, studentNo: payload.studentNo },
          } });
        } else if (type === "import") {
          if (!await this.runImport(s(payload.text))) return;
        } else { const result = await command(type === "recordSubmit" && this.data.recordOptions.length ? "recordSubmitChoice" : type, payload, ["join", "classSave", "rebindRequest", "semesterCreate", "autoApprovalSet"].includes(type) ? "" : type === "semesterParticipants" ? this.data.formId : this.data.semesterId, this.data.formVersion); admitted = type === "join" && result.data.automaticallyApproved === true; this.setData({ impacts: Array.isArray(result.data.impacts) ? (result.data.impacts as Entity[]).map(row) : [] }); }
        if (type === "recordSubmit") wx.removeStorageSync(draftKey(s(payload.taskId)));
        this.setData({ formType: "", record: null, rows: [], versions: [], versionCursor: "" });
        wx.showToast({ title: "已保存", icon: "success" });
      } catch (e) {
        if (this.data.formType === "import") try {
          const pending = readImportPlan(this.data.semesterId);
          if (pending) this.setData({importPending:true,importProgress:`导入中断：已完成 ${pending.next}/${pending.batches.length} 批。请确认后继续同一文件。`});
          else this.setData({importProgress:"校验失败，未写入云端。"});
        } catch { /* Keep the original error; a corrupt plan can be cleared explicitly. */ }
        displayError(e);
      }
      finally { this.setData({ busy: false }); }
      await this.load();
      if (admitted && this.data.memberId) wx.switchTab({url:"/pages/index/index"});
    },
    async toggleAutoApproval(e: WechatMiniprogram.SwitchChange) {
      if (!this.data.admin || this.data.busy) return;
      if (e.detail.value) { this.setData({autoApprovalActive:false}); await this.openForm("autoApprovalSet"); return; }
      this.setData({busy:true});
      try { await command("autoApprovalSet",{enabled:false},"",this.data.autoApprovalVersion); }
      catch(error) { displayError(error); }
      finally { this.setData({busy:false}); await this.load(); }
    },
    selectApplication(e: UiEvent) {
      const id = e.currentTarget.dataset.id;
      const selected = this.data.selectedApplications.includes(id) ? this.data.selectedApplications.filter(x=>x!==id) : this.data.selectedApplications.concat(id);
      this.setData({selectedApplications:selected, rows:this.data.rows.map(r=>({...r,selected:selected.includes(r.id)}))}); this.filterRows();
    },
    selectAllApplications() { const selected = this.data.selectedApplications.length ? [] : this.data.visibleRows.filter(r=>r.status === "pending").map(r=>r.id); this.setData({selectedApplications:selected,rows:this.data.rows.map(r=>({...r,selected:selected.includes(r.id)}))}); this.filterRows(); },
    async reviewApplications(e: UiEvent) {
      if (this.data.busy) return;
      let completed = 0;
      try {
        const targets = this.data.visibleRows.filter(r => r.status === "pending" && this.data.selectedApplications.includes(r.id));
        if (!targets.length) throw new Error("请先选择待审核申请");
        const approved = e.currentTarget.dataset.action === "approve";
        const confirmation = await wx.showModal({title: approved ? "批量通过申请" : "批量驳回申请",content:`本次处理已加载列表中选定的 ${targets.length} 人，请填写审核说明。`,editable:true});
        if (!confirmation.confirm) return;
        if (!confirmation.content?.trim()) throw new Error("请填写审核说明");
        this.setData({busy:true});
        for (const target of targets) { await command("applicationReview",{id:target.id,approved,reason:confirmation.content},"",target.version); completed++; }
        wx.showToast({title:`已处理 ${completed} 人`,icon:"none"});
      } catch(e) { displayError(new Error(`已处理 ${completed} 人。` + (e instanceof Error ? e.message : "请刷新重试"))); }
      finally { this.setData({busy:false,selectedApplications:[]}); await this.load(); }
    },
    async skipWeek() { try { const r=await wx.showModal({title:"跳过本周听课",content:"跳过原因必填，将生成待人工确认的取消草稿。有已提交记录的周不能整周跳过。",editable:true});if(!r.confirm)return;await command("planSkip",{week:this.data.week,reason:r.content},this.data.semesterId,this.data.weekData.plan?.version||0);await this.load();}catch(e){displayError(e);} },
    async rowAction(e: UiEvent) {
      const id = e.currentTarget.dataset.id, action = e.currentTarget.dataset.action;
      const target = this.data.rows.find(r => r.id === id);
      if (!target) return;
      if (action === "participants") { await this.openForm("semesterParticipants", target); return; }
      if (action === "exception") { await this.openForm("exceptionSave", target); return; }
      try {
        const labels: Record<string, string> = { admin: "授予管理员", member: "降为普通成员", leader: "设为组部长", officer: "设为信息部干事", remove: "停用成员", restore: "恢复成员", approve: "通过申请", reject: "驳回申请", rebind: "确认微信换绑（已线下核实）", activate: "启用学期", disable: "停用", enable: "启用" };
        const r = await wx.showModal({ title: labels[action], content: `对象：${target.label}。请核对并填写操作原因；角色变更立即影响权限。`, editable: true });
        if (!r.confirm) return;
        if (!r.content?.trim()) throw new Error("请填写原因");
        let type = "", payload: Record<string, unknown> = { id, reason: r.content, confirmed: true };
        if (["admin", "leader", "member", "officer"].includes(action)) { type = "roleChange"; payload.role = action; }
        else if (action === "remove") { type = target.role === "member" ? "memberRemove" : "memberStatus"; payload.active = false; }
        else if (action === "restore") { type = target.role === "member" ? "memberRestore" : "memberStatus"; payload.active = true; }
        else if (["approve", "reject"].includes(action)) { type = "applicationReview"; payload.approved = action === "approve"; }
        else if (action === "rebind") type = "rebindConfirm";
        else if (action === "activate") type = "semesterActivate";
        else if (this.data.section === "classes") { type = "classDisable"; payload.active = action === "enable"; }
        else { type = "courseDisable"; const date = await wx.showModal({ title: "停用生效日期", editable: true, placeholderText: "YYYY-MM-DD" }); if (!date.confirm) return; payload.effectiveDate = date.content; }
        const outcome = await command(type, payload, ["semesterActivate", "courseDisable"].includes(type) ? (type === "semesterActivate" ? id : this.data.semesterId) : "", target.version);
        this.setData({ impacts: Array.isArray(outcome.data.impacts) ? (outcome.data.impacts as Entity[]).map(row) : [] });
        this.setData({ rows: [], semesters: [] }); await this.load();
      } catch (e) { displayError(e); }
    },
    async stepDown() {
      try {
        const r = await wx.showModal({ title: "本人卸任管理员", content: "卸任后成为普通成员。最后一名有效管理员不能卸任。请输入原因。", editable: true });
        if (!r.confirm) return;
        await command("roleChange", { id: this.data.memberId, role: "member", confirmed: true, reason: r.content }, "", currentBoot().member!.version);
        await this.load();
      } catch (e) { displayError(e); }
    },
    choosePriorityGrade(e: UiEvent) {
      if(this.data.busy || !this.data.canGenerate)return;
      const index=Number(e.detail.value);
      if(!Number.isInteger(index) || index<0 || index>=this.data.gradeOptions.length)return;
      this.setData({priorityGradeIndex:index,priorityGrade:index ? this.data.gradeOptions[index] : ""});
    },
    async generate() { if (this.data.busy || this.data.error || !this.data.canGenerate || !canGeneratePlan(currentBoot().member?.data.role)) return; try { await command("planGenerate", { week: this.data.week, priorityGrade:this.data.priorityGrade }, this.data.semesterId, this.data.weekData.plan?.version || 0); await this.load(); } catch (e) { displayError(e); } },
    async confirmPlan() {
      if (this.data.busy || this.data.error || !this.data.canConfirm || !canConfirmPlan(currentBoot().member?.data.role)) return;
      try { const draft = this.data.weekData.draft; if (!draft) return; const r = await wx.showModal({ title: "确认排班调整", content: "请核对下方草稿任务和未覆盖班级。确认后生效，已完成任务保留。", editable: true, placeholderText: "确认原因" }); if (!r.confirm) return;
        await command("planConfirm", { id: draft.id, reason: r.content || "人工确认" }, this.data.semesterId, draft.version); await this.load();
      } catch (e) { displayError(e); }
    },
    async adjust(e: UiEvent) {
      if (this.data.busy || this.data.error || !this.data.canAdjust || !canAdjustTasks(currentBoot().member?.data.role)) return;
      try {
        const task = this.data.tasks.find(t => t.id === e.currentTarget.dataset.id);
        const members = await optionsFor("members");
        const occurrences = this.data.weekData.occurrences.filter(o => o.data.status === "active");
        this.setData({ formType: "taskAdjust", formTitle: task ? "转派或取消任务（生成草稿）" : "补排任务（生成草稿）", formId: "", formVersion: this.data.weekData.plan?.version || 0,
          fields: [field("memberId", "承担成员", Math.max(0, members.findIndex(m => m.value === task?.memberId)), "select", members), field("occurrenceId", "上课日期与课程", Math.max(0, occurrences.findIndex(o => o.id === task?.data.occurrenceId)), "select", occurrences.map(o => ({ label: s(o.data.classLabel) + " · " + s(o.date || o.data.date) + " · " + s((o.data.course as Record<string, unknown>)?.name), value: o.id }))), field("cancel", "操作", "0", "select", [{ value: "false", label: task ? "转派" : "补排" }, ...(task ? [{ value: "true", label: "取消任务" }] : [])]), field("reason", "调整原因", "", "textarea")], formExtra: { taskId: task?.id || "", week: this.data.week } });
      } catch (e) { displayError(e); }
    },
    slotsChange(e: WechatMiniprogram.CheckboxGroupChange) { if(this.data.busy)return; this.setData({ dirty:true,selectedSlots: e.detail.value }); syncAvailabilityExitAlert(true); },
    optIn(e: WechatMiniprogram.SwitchChange) { if(this.data.busy)return; this.setData({ dirty:true,optedIn: e.detail.value }); syncAvailabilityExitAlert(true); },
    availabilityNote(e: UiEvent) { if(this.data.busy)return; this.setData({ dirty:true,availabilityNote: e.detail.value }); syncAvailabilityExitAlert(true); },
    async copyAvailability() {
      if(this.data.busy || this.data.week <= 1)return;
      this.setData({busy:true});
      try {
        const previous = (await query<WeekData>("week",this.data.semesterId,{week:this.data.week-1})).data.availability;
        if(!previous)throw new Error("上一周没有可复制的无课时间");
        if(!(await wx.showModal({title:"复制上一周时间",content:"将替换当前勾选时段和备注，报名状态不复制。请核对后保存。"})).confirm)return;
        const available = new Set(this.data.slots.map(slot=>slot.key));
        const selected = (previous.data.slots as string[] || []).filter(key=>available.has(key));
        this.setData({selectedSlots:selected,availabilityNote:s(previous.data.note),dirty:true,...availabilityGrid(this.data.slots,selected)});
        syncAvailabilityExitAlert(true);
      }catch(e){displayError(e);}finally{this.setData({busy:false});}
    },
    async saveAvailability() { if(this.data.busy)return; this.setData({busy:true}); try { await command("availabilitySave", { week: this.data.week, slots: this.data.selectedSlots, optedIn: participatesByDefault(this.data.role) || this.data.optedIn, note: this.data.availabilityNote }, this.data.semesterId, this.data.weekData.availability?.version || 0); this.setData({busy:false,dirty:false}); syncAvailabilityExitAlert(false); await this.load(); wx.showToast({ title: "已保存", icon: "success" }); } catch (e) { displayError(e); } finally{this.setData({busy:false});} },
    openRecordForm(target: Entity, editing = false) {
      const d = target.data, metrics = d.metrics as Record<string, number> | undefined;
      const options = !editing && Array.isArray(d.courseOptions) ? taskCourseOptions(target).map(option=>({...option,
        label:`${option.course.name} · ${option.date} 第${option.course.start}–${option.course.end}节 · ${option.course.teacher} · ${option.course.classroom}`})) : [];
      this.setData({recordContext:row(target),uploadingPhoto:"",recordOptions:options,recordOptionIndex:Math.max(0,options.findIndex(o=>o.occurrenceId===d.occurrenceId))});
      this.setData({ formType: editing ? "recordEdit" : "recordSubmit", formTitle: editing ? "更正听课记录" : "填写听课记录", formId: editing ? target.id : "", formVersion: target.version,
        fields: [...METRIC_FIELDS.map(f => field(f.key, f.label, metrics?.[f.key] === -1 ? "信息缺失" : metrics?.[f.key] === undefined ? "" : metrics[f.key])), ...[["absentNames", "旷课名单（没有填无）"], ["leaveNames", "请假名单（没有填无）"], ["evaluation", "班风评价"], ["feedback", "异常情况及反馈"], ["suggestion", "教师建议"], ["otherDescription", "其他情况说明"]].map(([key, label]) => field(key, label, d[key], "textarea")), ...(editing ? [field("reason", "本次更正原因（必填）", "", "textarea")] : [])],
        formExtra: { taskId: editing ? target.taskId || d.taskId : target.id }, photoIds: editing && Array.isArray(d.photos) ? d.photos.map(String) : [], formPhotos: editing ? this.data.photoUrls : [] });
      if (!editing) {
        const draft = wx.getStorageSync(draftKey(target.id)) as { fields?: Field[]; occurrenceId?: string };
        if (options.length) {
          const savedIndex=options.findIndex(o=>o.occurrenceId===draft?.occurrenceId);
          this.applyRecordOption(savedIndex<0 ? this.data.recordOptionIndex : savedIndex);
        }
        if (Array.isArray(draft?.fields)) this.setData({ fields: this.data.fields.map(f=>{
          const saved=draft.fields!.find(v=>v?.key === f.key);return saved && typeof saved.value === "string" ? {...f,value:saved.value} : f;
        }) });
      }
      this.renderRecordFields();
    },
    applyRecordOption(index: number) {
      const option=this.data.recordOptions[index];
      if (!option || !this.data.recordContext || this.data.formType !== "recordSubmit")return;
      this.setData({recordOptionIndex:index,formExtra:{...this.data.formExtra,occurrenceId:option.occurrenceId},
        recordContext:row({...this.data.recordContext,data:{...this.data.recordContext.data,...option}})});
    },
    chooseRecordCourse(e: UiEvent) { if(this.data.busy)return;this.applyRecordOption(Number(e.detail.value)); },
    renderRecordFields() {
      if(!["recordSubmit","recordEdit"].includes(this.data.formType))return;
      const metricKeys=new Set<string>(METRIC_FIELDS.map(f=>f.key));
      this.setData({metricFields:this.data.fields.filter(f=>metricKeys.has(f.key)),nameFields:this.data.fields.filter(f=>["absentNames","leaveNames"].includes(f.key)),feedbackFields:this.data.fields.filter(f=>["otherDescription","evaluation","feedback","suggestion","reason"].includes(f.key))});
    },
    markMissing(e: UiEvent) {
      if(this.data.busy || !["recordSubmit","recordEdit"].includes(this.data.formType))return;
      const key=e.currentTarget.dataset.key;if(!METRIC_FIELDS.some(f=>f.key === key))return;
      this.setData({fields:this.data.fields.map(f=>f.key === key ? {...f,value:"信息缺失"} : f)});this.renderRecordFields();
    },
    zeroRemaining() {
      if(this.data.busy || !["recordSubmit","recordEdit"].includes(this.data.formType))return;
      const keys=new Set<string>(METRIC_FIELDS.map(f=>f.key).filter(k=>k!=="expected" && k!=="actual"));
      this.setData({fields:this.data.fields.map(f=>keys.has(f.key) && !f.value.trim() ? {...f,value:"0"} : f)});this.renderRecordFields();
    },
    noNames(e: UiEvent) {
      if(this.data.busy || !["recordSubmit","recordEdit"].includes(this.data.formType))return;
      const key=e.currentTarget.dataset.key;if(!["absentNames","leaveNames"].includes(key))return;
      this.setData({fields:this.data.fields.map(f=>f.key === key ? {...f,value:"无"} : f)});this.renderRecordFields();
    },
    editRecord() { if (this.data.record && this.data.canEdit) this.openRecordForm(this.data.record, true); },
    saveDraft() { wx.setStorageSync(draftKey(s(this.data.formExtra.taskId)), { fields: this.data.fields, occurrenceId:this.data.formExtra.occurrenceId }); wx.showToast({ title: "草稿已保存在本机", icon: "success" }); },
    async choosePhotos() {
      if (this.data.busy) return;
      try {
        this.setData({ busy: true });
        if (this.data.photoIds.length >= MAX_RECORD_PHOTOS) throw new Error("每份记录最多1张照片，请先移除原照片");
        const chosen = await wx.chooseMedia({ count: MAX_RECORD_PHOTOS - this.data.photoIds.length, mediaType: ["image"], sizeType: ["compressed"] });
        if (chosen.tempFiles.length > MAX_RECORD_PHOTOS - this.data.photoIds.length) throw new Error("每份记录最多1张照片");
        for (const image of chosen.tempFiles) {
          this.setData({uploadingPhoto:image.tempFilePath});
          const photo = await preparePhoto(image.tempFilePath), {path} = photo;
          this.setData({uploadingPhoto:path});
          const response = await uploadPreparedPhoto(photo, this.data.semesterId, String(this.data.formExtra.taskId || ""), this.data.formType === "recordEdit" ? this.data.formId : undefined);
          this.setData({ photoIds: this.data.photoIds.concat(response.data.fileID), formPhotos: this.data.formPhotos.concat(path),uploadingPhoto:"" });
        }
      } catch (e) { if(!(e && typeof e === "object" && "errMsg" in e && /cancel/.test(String(e.errMsg))))displayError(e); } finally { this.setData({ busy: false,uploadingPhoto:"" }); }
    },
    removePhoto(e: UiEvent) { if(this.data.busy)return; const i = Number(e.currentTarget.dataset.index); this.setData({ photoIds: this.data.photoIds.filter((_, n) => n !== i), formPhotos: this.data.formPhotos.filter((_, n) => n !== i) }); },
    previewUploadingPhoto() { if(this.data.uploadingPhoto)wx.previewImage({urls:[this.data.uploadingPhoto],current:this.data.uploadingPhoto}); },
    async previewFormPhoto(e: UiEvent) {
      if(this.data.busy)return;const index=Number(e.currentTarget.dataset.index);if(!this.data.photoIds[index])return;
      this.setData({busy:true});
      try {const response=await call<{urls:string[]}>("photoUrls",{semesterId:this.data.semesterId,payload:{ids:this.data.photoIds}});
        if(response.data.urls.length !== this.data.photoIds.length)throw new Error("照片链接不完整，请重试");
        this.setData({formPhotos:response.data.urls});await previewAuthorizedImages(response.data.urls,index);
      }catch(e){displayError(e);}finally{this.setData({busy:false});}
    },
    async previewPhoto(e: UiEvent) {
      if(this.data.busy || !this.data.record || !this.data.canViewRecordPhotos)return;const index=Math.max(0,this.data.photoUrls.indexOf(e.currentTarget.dataset.url));
      this.setData({busy:true});
      try {const r=await call<{urls:string[]}>("photoUrls",{semesterId:this.data.semesterId,payload:{recordId:this.data.record.id}});this.setData({photoUrls:r.data.urls});await previewAuthorizedImages(r.data.urls,index);}catch(e){displayError(e);}finally{this.setData({busy:false});}
    },
    async history() { try { if (!this.data.record) return; if (this.data.versions.length && !this.data.versionCursor) return; const r = await query("recordVersions", this.data.semesterId, { id: this.data.record.id }, this.data.versionCursor); this.setData({ versions: this.data.versions.concat(r.data.items.map(row)), versionCursor: r.cursor || "" }); } catch (e) { displayError(e); } },
    async versionPhotos(e: UiEvent) { if (!this.data.canViewRecordPhotos) return; try { const r = await call<{ urls: string[] }>("photoUrls", { semesterId: this.data.semesterId, payload: { recordId: this.data.targetId, versionId: e.currentTarget.dataset.id } }); await previewAuthorizedImages(r.data.urls); } catch (e) { displayError(e); } },
    async submissionStatus(e?:UiEvent) {
      if(this.data.busy || !this.data.coordinator || !this.data.semesterId)return;
      const more=e?.currentTarget.dataset.more === "true";
      this.setData({busy:true});
      try {
        const r=await query<{items:{id:string;name:string;className:string;availability:string;record:string;assigned:number;submitted:number}[];version:number}>("submissionStatus",this.data.semesterId,{week:this.data.week,...(more?{version:this.data.statusVersion}:{})},more?this.data.statusCursor:"");
        this.setData({statusRows:(more?this.data.statusRows:[]).concat(r.data.items),statusCursor:r.cursor || "",statusVersion:r.data.version,statusLoaded:true});
      } catch(e){this.setData({statusRows:[],statusCursor:"",statusLoaded:false});displayError(e);}finally{this.setData({busy:false});}
    },
    async showStats(preserve = false) {
      if(this.data.busy || !this.data.coordinator)return;
      this.setData({busy:true,statsLoaded:preserve && this.data.statsLoaded,recordTab:"stats"});
      try {
        if(this.data.officer) {
          const r=await query<{summary:SummaryReport;version:number}>("summaryReport",this.data.semesterId,{week:this.data.week});
          await query("reportCheck",this.data.semesterId,{week:this.data.week,version:r.data.version});
          this.setData({stats:summaryGradeStats(r.data.summary).map(g=>({...g,rate:g.rate===null?"信息缺失":(g.rate*100).toFixed(1)+"%"})),statsCount:r.data.summary.rows.reduce((n,r)=>n+r.count,0),statsLoaded:true});
          return;
        }
        const r = await loadReportState("report", this.data.semesterId, this.data.week);
        await query("reportCheck", this.data.semesterId, {week:this.data.week,version:r.data.version});
        this.setData({stats: gradeStats(r.data.state,this.data.week).map(g => ({...g,rate:g.rate === null ? "信息缺失" : (g.rate * 100).toFixed(1) + "%"})),statsCount:r.data.state.records.length,statsLoaded:true});
      } catch(e) {displayError(e);}finally{this.setData({busy:false});}
    },
    async copyReport() { await this.exportReport({currentTarget:{dataset:{kind:"copy"}},detail:{value:""}} as UiEvent); },
    openReport() { if((this.data.canExportExcel || this.data.canExportNames) && !this.data.error && this.data.filePath && this.data.fileOwner === currentBoot().workspace.epoch + ":" + this.data.memberId)openExport(this.data.filePath); },
    async exportSchedule() {
      if(this.data.busy || this.data.error || !this.data.canExportExcel || !canExportFullXlsx(currentBoot().member?.data.role) || !this.data.semesterId)return;
      this.setData({busy:true,filePath:"",filename:""});
      const semesterId=this.data.semesterId,week=this.data.week;
      try {
        const r=await query<{schedule:ScheduleReport;version:number}>("scheduleReport",semesterId,{week});
        const content=exportScheduleXlsx(r.data.schedule);
        await query("reportCheck",semesterId,{week,version:r.data.version,format:"schedule"});
        const filename=`第${week}周-听课安排表-${Date.now()}.xlsx`;
        const path=await new Promise<string>(resolve=>saveExport(filename,content,resolve,()=>resolve("")));
        if(!path)return;
        await query("reportCheck",semesterId,{week,version:r.data.version,format:"schedule"});
        this.setData({filename,filePath:path,fileOwner:currentBoot().workspace.epoch+":"+this.data.memberId});
        wx.showToast({title:"安排表已保存",icon:"success"});
      } catch(e) {displayError(e);} finally {this.setData({busy:false});}
    },
    async exportReport(e: UiEvent) {
      if(this.data.busy || this.data.error || !this.data.coordinator || !this.data.semesterId)return;
      const kind=e.currentTarget.dataset.kind, xlsx=kind === "xlsx";
      if (!["txt", "xlsx", "copy"].includes(kind)) return;
      const role=currentBoot().member?.data.role;
      if (xlsx ? !canExportFullXlsx(role) : !canExportNames(role)) return;
      this.setData({busy:true,filePath:"",filename:""});
      const semesterId=this.data.semesterId,week=this.data.week;
      try {
        const r = await loadReportState(xlsx ? "excelReport" : "namesReport", semesterId, week);
        const content=xlsx ? exportXlsx(r.data.state,week) : exportTxt(r.data.state,week);
        await query("reportCheck", semesterId, {week,version:r.data.version,format:xlsx ? "xlsx" : "txt"});
        if(kind === "copy") { await wx.setClipboardData({data:content as string}); return; }
        const filename=semesterId + "-第" + week + "周-" + Date.now() + (xlsx ? "-听课汇总.xlsx" : "-请假旷课名单.txt");
        const path=await new Promise<string>(resolve=>saveExport(filename,xlsx ? content : "\ufeff" + content,resolve,()=>resolve("")));
        if(!path)return;
        await query("reportCheck",semesterId,{week,version:r.data.version,format:xlsx ? "xlsx" : "txt"});
        this.setData({filename,filePath:path,fileOwner:currentBoot().workspace.epoch + ":" + this.data.memberId});
        wx.showToast({title:"文件已保存",icon:"success"});
      } catch (e) { displayError(e); }finally{this.setData({busy:false});}
    },
    async clearBusiness() {
      if (!this.data.admin || this.data.busy) return;
      this.setData({ busy: true });
      try {
        const r = await call<Record<string, unknown>>("clearPreview"); const p = r.data;
        const answer = await wx.showModal({ title: "清空业务数据", content: `保留 ${p.administrators} 名管理员及 ${p.retainedClasses} 个绑定班级；删除其他 ${p.members} 名成员、${p.deletedClasses} 个班级，以及全部学期、课程、排班、记录和业务照片。不按年份筛选。平台备份、日志与手机副本不在清理范围。请输入：${CLEAR_CONFIRMATION}`, editable: true, confirmText: "确认清空", confirmColor: "#c73535" });
        if (!answer.confirm) return;
        if (answer.content !== CLEAR_CONFIRMATION) throw new Error("确认文字不符，未开始清空");
        const start = p.jobId ? { data: { jobId: String(p.jobId) } } : await call<{ jobId: string }>("clearBegin", { expectedVersion: Number(p.version), requestId: requestId(), payload: { confirmation: answer.content } });
        for (let i = 0; i < 100; i++) {
          const step = await call<{ done: boolean; waitMs?: number }>("clearStep", { requestId: requestId(), payload: { jobId: start.data.jobId } });
          if (step.data.done) { clearLocalDrafts(); this.setData({ section: "semesters", semesters: [], rows: [], clearProgress: "清空完成，管理员及其班级已保留，请建立新学期。" }); return; }
          this.setData({ clearProgress: "正在处理旧轮次资料，关闭页面后可再次预览并继续。" });
          if (step.data.waitMs) await new Promise(resolve => setTimeout(resolve, Math.min(step.data.waitMs!, 1000)));
        }
        throw new Error("本轮处理结束，请重新预览并继续同一任务");
      } catch (e) { displayError(e); this.setData({ clearProgress: "未完成。若清空已开始，写入保持冻结，请重新预览并继续。" }); }
      finally { this.setData({ busy: false }); await this.load(); }
    },
  });
}
