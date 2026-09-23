import { Entity, CLEAR_CONFIRMATION, AutoApproval } from "../../domain/v2/protocol";
import { AppState, METRIC_FIELDS, UiEvent, Semester } from "../../domain/types";
import { exportTxt, exportXlsx, gradeStats } from "../../domain/reports";
import { saveExport, openExport } from "../files";
import { bootstrap, call, command, query, currentBoot, selectSemester, viewSemester, clearLocalDrafts, requestId, draftKey } from "./client";

import { boundedWeek, weekRange } from "../../domain/calendar";

interface AutoApprovalView { setting: AutoApproval | null; active: boolean; expired: boolean; version: number; serverNow: number; }
const localTime = (value: string) => value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0,16).replace("T", " ") + "（北京时间）" : "";
type View = "home" | "schedule" | "records" | "profile" | "manage" | "join" | "record" | "submission" | "availability" | "courses";
interface Option { label: string; value: string; checked?: boolean; }
interface Field { key: string; label: string; value: string; kind: string; options: Option[]; selected: string[]; }
interface Row extends Entity { selected?: boolean; label: string; detail: string; status: string; active: boolean; role: string; statusLabel: string; cancel: boolean; replaces: boolean; historyFields: {label:string;value:string}[]; }
interface WeekData { records?: Entity[]; semester?: Entity; tasks: Entity[]; occurrences: Entity[]; plan?: Entity; draft?: Entity; availability?: Entity; uncovered?: { label: string; reason: string }[]; }
const titles: Record<View, string> = { home: "学风督察", schedule: "听课安排", records: "听课记录", profile: "我的", manage: "管理工作台", join: "申请加入", record: "听课记录详情", submission: "填写听课记录", availability: "无课时间", courses: "课程总表" };
const s = (value: unknown) => value === undefined || value === null ? "" : String(value);
const actionLabels: Record<string,string> = { autoApprovalEnabled:"开启自动通过", autoApprovalDisabled:"关闭自动通过", autoApproveApplication:"自动通过入组申请", initialize:"首次初始化", roleChange:"调整角色", memberStatus:"调整启停状态", memberRemove:"移除成员", memberRestore:"恢复成员", classSave:"维护班级", classDisable:"停用班级", semesterCreate:"建立学期草稿", semesterActivate:"启用学期", semesterParticipants:"配置参与班级", courseSave:"维护课程", courseDisable:"停用课程", exceptionSave:"停调补课", planGenerate:"生成排班草稿", planConfirm:"确认排班", taskAdjust:"调整任务草稿", recordSubmit:"提交记录", recordEdit:"更正记录", rebindConfirm:"确认微信换绑", applicationReview:"审核申请", clearBegin:"开始业务清空", import:"导入课表" };
const statusLabels: Record<string, string> = { pending: "待审核", approved: "已通过", rejected: "已驳回", draft: "草稿", active: "已启用", confirmed: "已确认", submitted: "已提交", pendingAdjustment: "待调整", cancelled: "已取消" };
const row = (e: Entity): Row => {
  const course = e.data.course as Record<string, unknown> | undefined;
  return { ...e, label: s(e.data.name || e.data.memberName || e.data.classLabel || (actionLabels[s(e.data.action)] || e.data.action) || e.date || "业务资料"),
    detail: [e.data.studentNo, e.data.classLabel, e.data.approvalMode === "automatic" ? "自动通过 · " + localTime(s(e.data.reviewedAt)) : "", course?.name, e.data.grade, e.data.major, e.data.teacher || course?.teacher, e.data.date || e.date, course ? `第${course.start}–${course.end}节 ${course.classroom || ""}` : "", e.data.reason, e.data.detail, e.data.correctedAt ? "更正于 " + s(e.data.correctedAt) : ""].filter(Boolean).join(" · "),
    status: s(e.data.status), statusLabel: statusLabels[s(e.data.status)] || s(e.data.status), active: e.data.active !== false, role: s(e.data.role), cancel: e.data.cancel === true, replaces: !!e.data.replacesTaskId, historyFields: e.data.metrics ? METRIC_FIELDS.map(f => ({label:f.label,value:(e.data.metrics as Record<string,number>)[f.key] === -1 ? "信息缺失" : s((e.data.metrics as Record<string,number>)[f.key])})) : [] };
};
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

export function registerCloudPage(view: View): void {
  let autoExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  Page({
    data: {
      importPreview: [] as string[], importCount: 0, importClassCount: 0, importReady: false,
      pendingCount: 0, pendingMore: false, pendingLabel: "", searchText: "", applicationFilter: "pending", visibleRows: [] as Row[], visibleTasks: [] as Row[],
      dirty: false, weekInitialized: false, maxWeek: 60, filename: "", filePath: "", fileOwner: "",
      modeLabel: "云端试用", roleLabel: "", initial: "", className: "", studentNo: "", dates: "", availabilityReady: false,
      homeTasks: [] as (Row & {classLabel:string;course:Record<string,unknown>;timeLabel:string;done:boolean;recordId:string})[], taskCount: 0, recordCount: 0, coverage: 0, skipped: false,
      availabilityDays: [] as {n:number;name:string}[], availabilityRows: [] as {n:number;cells:{key:string;selected:boolean}[]}[],
      recordTab: "all", weekTotal: 0, weekSubmitted: 0, weekProgress: 0,
      eyebrow: ({home:"",schedule:"WEEKLY SCHEDULE",records:"WEEKLY REPORTS",profile:"MY WORKSPACE",manage:"MANAGEMENT",join:"JOIN US",record:"OBSERVATION RECORD",submission:"CLASSROOM OBSERVATION",availability:"YOUR AVAILABILITY",courses:"COURSE CATALOG"})[view],
      cloudMode: true, title: titles[view], view, busy: false, error: "", status: "", canInitialize: false, removed: false,
      admin: false, manager: false, memberName: "", memberId: "", role: "", maintenance: "",
      autoApprovalActive: false, autoApprovalExpired: false, autoApprovalDeadline: "", autoApprovalUpdated: "", autoApprovalVersion: 0,
      selectedApplications: [] as string[], section: view === "manage" ? "members" : view === "records" ? "records" : "", rows: [] as Row[], cursor: "",
      sections: [{ id: "members", label: "成员" }, { id: "applications", label: "入组申请" }, { id: "autoApproved", label: "自动通过人员" }, { id: "rebindings", label: "换绑申请" }, { id: "classes", label: "班级" }, { id: "semesters", label: "学期" }, { id: "courses", label: "课表" }, { id: "audit", label: "操作记录" }],
      semesterId: "", semesterName: "", activeSemesterId: "", semesters: [] as Entity[], semesterOptions: [] as Option[], semesterCursor: "", semesterIndex: 0,
      fixedSemester: "", targetId: "", week: 1, weekData: { tasks: [], occurrences: [] } as WeekData, tasks: [] as Row[],
      record: null as Entity | null, recordFields: [] as { label: string; value: string }[], canEdit: false, versions: [] as Row[], versionCursor: "", photoUrls: [] as string[],
      formType: "", formTitle: "", formId: "", formVersion: 0, fields: [] as Field[], formExtra: {} as Record<string, unknown>, photoIds: [] as string[], formPhotos: [] as string[],
      impacts: [] as Row[], stats: [] as {grade:string;count:number;valid:number;rate:string}[], statsCount: 0, statsLoaded: false, clearProgress: "", slots: [] as { key: string; label: string; checked: boolean }[], selectedSlots: [] as string[], optedIn: false, availabilityNote: "",
    },
    onLoad(q: Record<string, string>) { this.setData({section: view === "manage" && q.section === "applications" ? "applications" : this.data.section, fixedSemester: q.semesterId || "", targetId: q.id || q.taskId || "", week: Number(q.week) || 1, weekInitialized: Number(q.week) > 0 }); },
    onShow() { void this.load(); },
    onHide() { if (autoExpiryTimer) clearTimeout(autoExpiryTimer); },
    onUnload() { if (autoExpiryTimer) clearTimeout(autoExpiryTimer); },
    onPullDownRefresh() { void this.load().finally(() => wx.stopPullDownRefresh()); },
    async load(more = false): Promise<void> {
      if (this.data.busy) return;
      this.setData({ busy: true, error: "", statsLoaded: false });
      try {
        const boot = await bootstrap(), member = boot.member;
        const admin = member?.data.role === "admin", manager = !!member && member.data.role !== "member";
        if (this.data.memberId && (this.data.memberId !== member?.id || this.data.role !== member?.data.role)) this.setData({filePath:"",filename:"",pendingCount:0,pendingMore:false,pendingLabel:"",visibleRows:[],visibleTasks:[],record:null,versions:[],photoUrls:[],rows:[],tasks:[],homeTasks:[],formType:"",fields:[]});
        if(view === "records" && (this.data.memberId !== member?.id || this.data.role !== member?.data.role))this.setData({recordTab:manager ? "all" : "mine"});
        this.setData({ status: boot.status, canInitialize: boot.canInitialize, removed: !!boot.removed, admin, manager, memberName: s(member?.data.name), memberId: member?.id || "", role: s(member?.data.role), activeSemesterId: boot.workspace.activeSemesterId, maintenance: boot.workspace.maintenance });
        this.setData({roleLabel: admin ? "管理员" : manager ? "组部长" : "普通成员", initial: s(member?.data.name).slice(0,1), studentNo: s(member?.data.studentNo)});
        if (!member || !member.data.active) {
          this.setData({ pendingCount:0,pendingMore:false,pendingLabel:"",filePath:"",filename:"",visibleRows:[],visibleTasks:[],rows: [], tasks: [], homeTasks: [], semesters: [], record: null, versions: [], photoUrls: [], fields: [], formType: "" });
          if (boot.status !== "needsAdministrator") {
            this.setData({ rows: boot.application ? [row(boot.application)] : [], cursor: "" });
          }
          return;
        }
        if (view === "profile") {
          const classes = await optionsFor("classes");
          this.setData({className: classes.find(c => c.value === member.data.classId)?.label || "班级未设置",pendingCount:0,pendingMore:false,pendingLabel:""});
          if (manager) {
            const applications = await query("applications");
            const count = applications.data.items.filter(a => a.data.status === "pending").length, more = !!applications.cursor;
            this.setData({pendingCount:count,pendingMore:more,pendingLabel:count ? `${count}${more ? "+" : ""} 待审核` : more ? "查看申请" : ""});
          }
        }
        if (!this.data.semesters.length || !more) {
          const response = await query("semesters");
          this.setData({ semesters: response.data.items, semesterCursor: response.cursor || "", semesterOptions: response.data.items.map(e => ({label: s(e.data.name), value: e.id})) });
        }
        const selected = this.data.fixedSemester || (view === "home" || view === "availability" ? boot.workspace.activeSemesterId : viewSemester());
        let selectedSemester = this.data.semesters.find(e => e.id === selected);
        if (selected && !selectedSemester) selectedSemester = (await query<{semester:Entity}>("semester", selected)).data.semester;
        const semesterId = selected || boot.workspace.activeSemesterId;
        const maxWeek = Number(selectedSemester?.data.weeks || 60);
        const calendarWeek = selectedSemester?.data.startDate ? boundedWeek(selectedSemester.data as unknown as Semester) : 1;
        const displayedWeek = view === "home" ? calendarWeek : !this.data.weekInitialized && ["schedule","availability","records"].includes(view)
          ? Math.min(maxWeek, calendarWeek + (["schedule","availability"].includes(view) ? 1 : 0)) : Math.min(maxWeek, Math.max(1,this.data.week));
        if (!semesterId) this.setData({tasks:[],homeTasks:[],weekData:{tasks:[],occurrences:[]},taskCount:0,recordCount:0,coverage:0,weekTotal:0,weekSubmitted:0,weekProgress:0,availabilityReady:false});
        this.setData({ semesterId, semesterIndex: Math.max(0, this.data.semesters.findIndex(e => e.id === semesterId)), semesterName: s(selectedSemester?.data.name || (semesterId ? "所选历史学期" : "尚未启用学期")) });
        this.setData({week: displayedWeek, maxWeek, weekInitialized: !!semesterId, dates: selectedSemester?.data.startDate ? weekRange(selectedSemester.data as unknown as Semester, displayedWeek) : ""});
        if (view === "manage" || view === "records" || view === "courses") {
          const kind = view === "manage" ? this.data.section : view === "courses" ? "courses" : "records";
          if (admin && view === "manage" && ["applications", "autoApproved"].includes(kind)) {
            const setting = await query<AutoApprovalView>("autoApproval");
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
          if (view === "records" && semesterId) {
            const w = (await query<WeekData>("week", semesterId, {week:this.data.week})).data;
            const total = w.tasks.filter(t => ["confirmed","submitted","pendingAdjustment"].includes(s(t.data.status))).length;
            const submitted = (w.records || []).length;
            this.setData({weekTotal:total,weekSubmitted:submitted,weekProgress:total ? Math.min(100,Math.round(submitted / total * 100)) : 0,skipped:w.plan?.data.status === "skipped"});
          }
          const response = await query(kind, ["courses", "records"].includes(kind) ? semesterId : "", kind === "records" ? { week: this.data.week } : {}, more ? this.data.cursor : "");
          this.setData({ rows: (more ? this.data.rows : []).concat(response.data.items.map(row)).map(r=>({...r,selected:this.data.selectedApplications.includes(r.id)})), cursor: response.cursor || "" });
        } else if (["home", "schedule", "availability"].includes(view) && semesterId) {
          const response = await query<WeekData>("week", semesterId, { week: displayedWeek });
          const w = response.data;
          const visibleTasks = (w.tasks || []).filter(t => ["confirmed","submitted","pendingAdjustment"].includes(s(t.data.status)));
          this.setData({ weekData: w, tasks: (w.tasks || []).map(row), availabilityReady: !!w.availability,
            taskCount: visibleTasks.length, recordCount: (w.records || []).length, coverage: new Set((w.records || []).map(r => s(r.data.classLabel))).size, skipped: w.plan?.data.status === "skipped",
            homeTasks: visibleTasks.filter(t => t.memberId === member.id).map(t => ({...row(t), classLabel:s(t.data.classLabel), course:(t.data.course || {}) as Record<string,unknown>, timeLabel:s(t.data.date || t.date) + " · 第" + s((t.data.course as Record<string,unknown>)?.start) + "–" + s((t.data.course as Record<string,unknown>)?.end) + "节", done:t.data.status === "submitted", recordId:(w.records || []).find(r => r.taskId === t.id)?.id || ""})) });
          if (view === "availability") {
            const days = Number(w.semester?.data.days || selectedSemester?.data.days || 5), periods = Number(w.semester?.data.periods || selectedSemester?.data.periods || 14);
            const own = w.availability;
            const selectedSlots = Array.isArray(own?.data.slots) ? own.data.slots.map(String) : [];
            this.setData({ dirty:false, selectedSlots, optedIn: own?.data.optedIn === true, availabilityNote: s(own?.data.note), slots: Array.from({ length: days * periods }, (_, i) => { const d = Math.floor(i / periods) + 1, p = i % periods + 1, key = d + ":" + p; return { key, label: "周" + "一二三四五六日"[d - 1] + "第" + p + "节", checked: selectedSlots.includes(key) }; }) });
          }
          if (view === "availability") this.setData(availabilityGrid(this.data.slots, this.data.selectedSlots));
        } else if (view === "record" && this.data.targetId) {
          const response = await query<{ record: Entity; canEdit: boolean }>("record", semesterId, { id: this.data.targetId });
          const record = response.data.record;
          const metrics = record.data.metrics as Record<string, number>;
          this.setData({ record, canEdit: response.data.canEdit, recordFields: METRIC_FIELDS.map(f => ({ label: f.label, value: metrics?.[f.key] === -1 ? "信息缺失" : s(metrics?.[f.key]) })) });
          const urls = await call<{ urls: string[] }>("photoUrls", { semesterId, payload: { recordId: record.id } });
          this.setData({ photoUrls: urls.data.urls });
        } else if (view === "submission" && this.data.targetId && !this.data.formType) {
          const response = await query<{ task: Entity }>("task", semesterId, { id: this.data.targetId });
          this.openRecordForm(response.data.task);
        }
        this.filterRows();
      } catch (e) { this.setData({ visibleRows:[],visibleTasks:[],pendingCount:0,pendingMore:false,pendingLabel:"",filePath:"",filename:"",error: e instanceof Error ? e.message : "连接失败", record: null, photoUrls: [], versions: [], rows: [], tasks: [], homeTasks: [] }); }
      finally { this.setData({ busy: false }); }
    },
    async more() { await this.load(true); },
    async moreSemesters() {
      if (!this.data.semesterCursor) return;
      try { const r = await query("semesters", "", {}, this.data.semesterCursor); this.setData({ semesters: this.data.semesters.concat(r.data.items), semesterCursor: r.cursor || "", semesterOptions: this.data.semesters.concat(r.data.items).map(e => ({label: s(e.data.name), value: e.id})) }); } catch (e) { displayError(e); }
    },
    filterRows() {
      const needle = this.data.searchText.trim().toLowerCase();
      const matches = (r: Row) => !needle || [r.label,r.detail,r.data.name,r.data.memberName,r.data.studentNo,(r.data.course as Record<string,unknown>)?.name].map(s).join(" ").toLowerCase().includes(needle);
      this.setData({visibleRows:this.data.rows.filter(r => matches(r) && (view !== "records" || this.data.recordTab !== "mine" || r.memberId === this.data.memberId) && (view !== "manage" || this.data.section !== "applications" || this.data.applicationFilter !== "pending" || r.status === "pending")),visibleTasks:this.data.tasks.filter(r => ["confirmed","submitted","pendingAdjustment"].includes(r.status) && matches(r))});
    },
    search(e: UiEvent) { this.setData({searchText:e.detail.value,selectedApplications:[],rows:this.data.rows.map(r=>({...r,selected:false}))}); this.filterRows(); },
    applicationFilter(e: UiEvent) { if(this.data.busy)return; this.setData({applicationFilter:e.currentTarget.dataset.id,selectedApplications:[],rows:this.data.rows.map(r=>({...r,selected:false}))});this.filterRows(); },
    section(e: UiEvent) { if (this.data.busy) return; this.setData({ section: e.currentTarget.dataset.id, selectedApplications: [], rows: [], visibleRows:[], searchText:"",cursor: "", formType: "" }); void this.load(); },
    chooseSemester(e: UiEvent) { if (this.data.busy) return; const chosen = this.data.semesters[Number(e.detail.value)]; if (!chosen) return; selectSemester(chosen.id); this.setData({ fixedSemester: "", semesterId: chosen.id, formType: "", rows: [], visibleRows:[], filePath:"",filename:"",week: 1,weekInitialized:chosen.id !== this.data.activeSemesterId }); void this.load(); },
    weekChange(e: UiEvent) { const next = Number(e.detail.value); if (Number.isInteger(next) && next >= 1 && next <= 60) this.setData({ week: next }); },
    refreshWeek() { void this.load(); },
    recordTab(e: UiEvent) { if(this.data.busy)return; this.setData({recordTab:e.currentTarget.dataset.id}); this.filterRows(); if (e.currentTarget.dataset.id === "stats" && this.data.semesterId) void this.showStats(); },
    async moveWeek(e: UiEvent) {
      if (!this.data.semesterId || this.data.busy) return;
      const next = Math.min(this.data.maxWeek, Math.max(1, this.data.week + Number(e.currentTarget.dataset.delta)));
      if(next === this.data.week)return;
      if(this.data.dirty && !(await wx.showModal({title:"尚未保存",content:"切换周次会放弃本页未保存的无课时间修改。"})).confirm)return;
      this.setData({week:next, rows:[],visibleRows:[],visibleTasks:[],filePath:"",filename:"",cursor:"",formType:"",dirty:false}); await this.load();
    },
    toggleSlot(e: UiEvent) {
      if(this.data.busy)return;
      const key = e.currentTarget.dataset.key;
      const selected = this.data.selectedSlots.includes(key) ? this.data.selectedSlots.filter(s => s !== key) : this.data.selectedSlots.concat(key);
      this.setData({dirty:true,selectedSlots:selected, ...availabilityGrid(this.data.slots, selected)});
    },
    toggleDay(e: UiEvent) {
      if(this.data.busy)return;
      const keys = this.data.slots.filter(s => s.key.startsWith(e.currentTarget.dataset.day + ":")).map(s => s.key);
      const all = keys.every(k => this.data.selectedSlots.includes(k));
      const selected = this.data.selectedSlots.filter(k => !keys.includes(k)).concat(all ? [] : keys);
      this.setData({dirty:true,selectedSlots:selected, ...availabilityGrid(this.data.slots, selected)});
    },
    rules() { wx.showModal({title:"听课与提交说明",content:"1. 不能听自己班，每周最多一次。\n2. 无课时间按周保存，以正式安排为准。\n3. 按实际情况填写人数，缺失信息单独标记。\n4. 上传清晰、带有老师签字的听课表。",showCancel:false}); },
    navigate(e: UiEvent) {
      const target = e.currentTarget.dataset.target;
      if (["schedule", "reports", "profile", "index"].includes(target)) { wx.switchTab({url:"/pages/" + target + "/" + target}); return; }
      if (["manage", "courses", "availability", "join"].includes(target)) {
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
        if (type === "import") fields = [field("text", "粘贴JSON课表（先解析预览）", "", "textarea")];
        this.setData({ importPreview:[],importReady:false,formType: type, formTitle: ({ autoApprovalSet: "限时自动通过新申请", classSave: "维护班级", courseSave: "维护课程", semesterCreate: "建立学期草稿", semesterParticipants: "选择参与班级", exceptionSave: "停课与调补课", join: "提交入组申请", initialize: "首次登记", rebindRequest: "申请微信换绑", import: "JSON课表导入" } as Record<string, string>)[type] || "维护资料", formId: id, formVersion: type === "autoApprovalSet" ? this.data.autoApprovalVersion : entity?.version || 0, fields: fields.map(f => ({ ...f, options: f.options.map(o => ({ ...o, checked: f.selected.includes(o.value) })) })), formExtra: extra, photoIds: [], formPhotos: [] });
      } catch (e) { displayError(e); }
    },
    input(e: UiEvent) {
      const key = e.currentTarget.dataset.key;
      const fields = this.data.fields.map(f => f.key === key ? { ...f, value: e.detail.value } : f);
      this.setData({ fields, ...(key === "text" ? {importReady:false,importPreview:[]} : {}) });
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
    cancelForm() { this.setData({ formType: "", photoIds: [], formPhotos: [] }); },
    async saveForm() {
      if (this.data.busy) return;
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
          const confirmation = await wx.showModal({ title: "确认导入", content: `预览：${parsed.courses.length} 条课程、${parsed.classes?.length || 0} 个班级。云端将完整校验后再保存。` });
          if (!confirmation.confirm) return;
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
        } else { const result = await command(type, payload, ["join", "classSave", "rebindRequest", "semesterCreate", "autoApprovalSet"].includes(type) ? "" : type === "semesterParticipants" ? this.data.formId : this.data.semesterId, this.data.formVersion); admitted = type === "join" && result.data.automaticallyApproved === true; this.setData({ impacts: Array.isArray(result.data.impacts) ? (result.data.impacts as Entity[]).map(row) : [] }); }
        if (type === "recordSubmit") wx.removeStorageSync(draftKey(s(payload.taskId)));
        this.setData({ formType: "", record: null, rows: [], versions: [], versionCursor: "" });
        wx.showToast({ title: "已保存", icon: "success" });
      } catch (e) { displayError(e); }
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
        const labels: Record<string, string> = { admin: "授予管理员", member: "降为普通成员", leader: "设为组部长", remove: "停用成员", restore: "恢复成员", approve: "通过申请", reject: "驳回申请", rebind: "确认微信换绑（已线下核实）", activate: "启用学期", disable: "停用", enable: "启用" };
        const r = await wx.showModal({ title: labels[action], content: `对象：${target.label}。请核对并填写操作原因；角色变更立即影响权限。`, editable: true });
        if (!r.confirm) return;
        if (!r.content?.trim()) throw new Error("请填写原因");
        let type = "", payload: Record<string, unknown> = { id, reason: r.content, confirmed: true };
        if (["admin", "leader", "member"].includes(action)) { type = "roleChange"; payload.role = action; }
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
    async generate() { try { await command("planGenerate", { week: this.data.week }, this.data.semesterId, this.data.weekData.plan?.version || 0); await this.load(); } catch (e) { displayError(e); } },
    async confirmPlan() {
      try { const draft = this.data.weekData.draft; if (!draft) return; const r = await wx.showModal({ title: "确认排班调整", content: "请核对下方草稿任务和未覆盖班级。确认后生效，已完成任务保留。", editable: true, placeholderText: "确认原因" }); if (!r.confirm) return;
        await command("planConfirm", { id: draft.id, reason: r.content || "人工确认" }, this.data.semesterId, draft.version); await this.load();
      } catch (e) { displayError(e); }
    },
    async adjust(e: UiEvent) {
      try {
        const task = this.data.tasks.find(t => t.id === e.currentTarget.dataset.id);
        const members = await optionsFor("members");
        const occurrences = this.data.weekData.occurrences.filter(o => o.data.status === "active");
        this.setData({ formType: "taskAdjust", formTitle: task ? "转派或取消任务（生成草稿）" : "补排任务（生成草稿）", formId: "", formVersion: this.data.weekData.plan?.version || 0,
          fields: [field("memberId", "承担成员", Math.max(0, members.findIndex(m => m.value === task?.memberId)), "select", members), field("occurrenceId", "上课日期与课程", Math.max(0, occurrences.findIndex(o => o.id === task?.data.occurrenceId)), "select", occurrences.map(o => ({ label: s(o.data.classLabel) + " · " + s(o.date || o.data.date) + " · " + s((o.data.course as Record<string, unknown>)?.name), value: o.id }))), field("cancel", "操作", "0", "select", [{ value: "false", label: task ? "转派" : "补排" }, ...(task ? [{ value: "true", label: "取消任务" }] : [])]), field("reason", "调整原因", "", "textarea")], formExtra: { taskId: task?.id || "", week: this.data.week } });
      } catch (e) { displayError(e); }
    },
    slotsChange(e: WechatMiniprogram.CheckboxGroupChange) { this.setData({ selectedSlots: e.detail.value }); },
    optIn(e: WechatMiniprogram.SwitchChange) { if(this.data.busy)return; this.setData({ dirty:true,optedIn: e.detail.value }); },
    availabilityNote(e: UiEvent) { if(this.data.busy)return; this.setData({ dirty:true,availabilityNote: e.detail.value }); },
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
      }catch(e){displayError(e);}finally{this.setData({busy:false});}
    },
    async saveAvailability() { if(this.data.busy)return; this.setData({busy:true}); try { await command("availabilitySave", { week: this.data.week, slots: this.data.selectedSlots, optedIn: this.data.role === "member" || this.data.optedIn, note: this.data.availabilityNote }, this.data.semesterId, this.data.weekData.availability?.version || 0); this.setData({busy:false}); await this.load(); wx.showToast({ title: "已保存", icon: "success" }); } catch (e) { displayError(e); } finally{this.setData({busy:false});} },
    openRecordForm(target: Entity, editing = false) {
      const d = target.data, metrics = d.metrics as Record<string, number> | undefined;
      this.setData({ formType: editing ? "recordEdit" : "recordSubmit", formTitle: editing ? "更正听课记录" : "填写听课记录", formId: editing ? target.id : "", formVersion: target.version,
        fields: [...METRIC_FIELDS.map(f => field(f.key, f.label + "（未知填信息缺失）", metrics?.[f.key] === -1 ? "信息缺失" : metrics?.[f.key] === undefined ? "" : metrics[f.key])), ...[["absentNames", "旷课名单（没有填无）"], ["leaveNames", "请假名单（没有填无）"], ["evaluation", "班风评价"], ["feedback", "异常情况及反馈"], ["suggestion", "教师建议"], ["otherDescription", "其他情况说明"]].map(([key, label]) => field(key, label, d[key], "textarea")), ...(editing ? [field("reason", "本次更正原因（必填）", "", "textarea")] : [])],
        formExtra: { taskId: editing ? target.taskId || d.taskId : target.id }, photoIds: editing && Array.isArray(d.photos) ? d.photos.map(String) : [], formPhotos: editing ? this.data.photoUrls : [] });
      if (!editing) {
        const draft = wx.getStorageSync(draftKey(target.id)) as { fields?: Field[] };
        if (draft?.fields) this.setData({ fields: draft.fields });
      }
    },
    editRecord() { if (this.data.record && this.data.canEdit) this.openRecordForm(this.data.record, true); },
    saveDraft() { wx.setStorageSync(draftKey(s(this.data.formExtra.taskId)), { fields: this.data.fields }); wx.showToast({ title: "草稿已保存在本机", icon: "success" }); },
    async choosePhotos() {
      try {
        if (this.data.busy) return;
        this.setData({ busy: true });
        if (this.data.photoIds.length >= 3) throw new Error("每份记录最多3张照片");
        const chosen = await wx.chooseMedia({ count: 3 - this.data.photoIds.length, mediaType: ["image"], sizeType: ["compressed"] });
        for (const image of chosen.tempFiles) {
          let path = image.tempFilePath, base64 = s(wx.getFileSystemManager().readFileSync(path, "base64"));
          if (base64.length > 680000) { const compressed = await wx.compressImage({ src: path, quality: 65 }); path = compressed.tempFilePath; base64 = s(wx.getFileSystemManager().readFileSync(path, "base64")); }
          if (base64.length > 680000) throw new Error("请裁剪照片至约500KB以内，并保证签字清晰");
          const response = await call<{ fileID: string }>("photo", { requestId: requestId(), semesterId: this.data.semesterId, payload: { taskId: this.data.formExtra.taskId, recordId: this.data.formType === "recordEdit" ? this.data.formId : undefined, base64 } });
          this.setData({ photoIds: this.data.photoIds.concat(response.data.fileID), formPhotos: this.data.formPhotos.concat(path) });
        }
      } catch (e) { displayError(e); } finally { this.setData({ busy: false }); }
    },
    removePhoto(e: UiEvent) { const i = Number(e.currentTarget.dataset.index); this.setData({ photoIds: this.data.photoIds.filter((_, n) => n !== i), formPhotos: this.data.formPhotos.filter((_, n) => n !== i) }); },
    previewPhoto(e: UiEvent) { wx.previewImage({ urls: this.data.photoUrls, current: e.currentTarget.dataset.url }); },
    async history() { try { if (!this.data.record) return; if (this.data.versions.length && !this.data.versionCursor) return; const r = await query("recordVersions", this.data.semesterId, { id: this.data.record.id }, this.data.versionCursor); this.setData({ versions: this.data.versions.concat(r.data.items.map(row)), versionCursor: r.cursor || "" }); } catch (e) { displayError(e); } },
    async versionPhotos(e: UiEvent) { try { const r = await call<{ urls: string[] }>("photoUrls", { semesterId: this.data.semesterId, payload: { recordId: this.data.targetId, versionId: e.currentTarget.dataset.id } }); wx.previewImage({ urls: r.data.urls }); } catch (e) { displayError(e); } },
    async showStats() {
      if(this.data.busy || !this.data.manager)return;
      this.setData({busy:true,statsLoaded:false,recordTab:"stats"});
      try {
        const r = await query<{state: AppState; version:number}>("report", this.data.semesterId, {week:this.data.week});
        await query("reportCheck", this.data.semesterId, {week:this.data.week,version:r.data.version});
        this.setData({stats: gradeStats(r.data.state,this.data.week).map(g => ({...g,rate:g.rate === null ? "信息缺失" : (g.rate * 100).toFixed(1) + "%"})),statsCount:r.data.state.records.length,statsLoaded:true});
      } catch(e) {displayError(e);}finally{this.setData({busy:false});}
    },
    async copyReport() { await this.exportReport({currentTarget:{dataset:{kind:"copy"}},detail:{value:""}} as UiEvent); },
    openReport() { if(this.data.filePath && this.data.fileOwner === currentBoot().workspace.epoch + ":" + this.data.memberId)openExport(this.data.filePath); },
    async exportReport(e: UiEvent) {
      if(this.data.busy || !this.data.manager || !this.data.semesterId)return;
      this.setData({busy:true,filePath:"",filename:""});
      const semesterId=this.data.semesterId,week=this.data.week;
      try {
        const r = await query<{ state: AppState; version: number }>("report", semesterId, { week });
        const kind=e.currentTarget.dataset.kind,xlsx=kind === "xlsx",content=xlsx ? exportXlsx(r.data.state,week) : exportTxt(r.data.state,week);
        await query("reportCheck", semesterId, {week,version:r.data.version});
        if(kind === "copy") { await wx.setClipboardData({data:content as string}); return; }
        const filename=semesterId + "-第" + week + "周-" + Date.now() + (xlsx ? "-听课汇总.xlsx" : "-请假旷课名单.txt");
        const path=await new Promise<string>(resolve=>saveExport(filename,xlsx ? content : "\ufeff" + content,resolve,()=>resolve("")));
        if(!path)return;
        await query("reportCheck",semesterId,{week,version:r.data.version});
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
