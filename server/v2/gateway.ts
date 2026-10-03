import { isManager, canCoordinate, canGeneratePlan, participatesByDefault } from "../../miniprogram/domain/capabilities";
import { summarizeEntities } from "./summary-report";
import { ApiRequest, ApiResponse, Change, CLEAR_CONFIRMATION, Entity, Query, ReadVersion, Resource, RESOURCES, Workspace } from "../../miniprogram/domain/v2/protocol";
import { Repository } from "./repository";
import { readPageData } from "./page-load";
import { PageLoadRequest } from "../../miniprogram/domain/v2/page-data";
import { AppState, Course, Metrics, Semester } from "../../miniprogram/domain/types";
import { generatePlan } from "../../miniprogram/domain/scheduler";
import { inspectImport } from "../../miniprogram/domain/imports";
import { validateMetrics } from "../../miniprogram/domain/metrics";
import { weekDate, currentWeek, boundedWeek, slotsFor } from "../../miniprogram/domain/calendar";

export interface PhotosV2 {
  upload(path: string, base64: string): Promise<string>;
  urls(ids: string[]): Promise<string[]>;
  list(prefix: string, limit: number): Promise<string[]>;
  delete(ids: string[]): Promise<void>;
}
export interface DependenciesV2 {
  repository: Repository; appid: string; bootstrapOpenid: string;
  uuid(): string; now?(): number; photos: PhotosV2; maxExecutionMs: number;
}
export class BusinessError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
function fail(message: string, code = "INVALID_REQUEST"): never { throw new BusinessError(code, message); }
function text(value: unknown, label: string, max = 200, optional = false): string {
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) fail(label + "无效");
  return value.trim();
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) fail(label + "无效");
  return Number(value);
}
function date(value: unknown): string {
  const s = text(value, "日期", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z")) || new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s) fail("日期无效");
  return s;
}
function monday(value: unknown): string {
  const on = date(value); if (new Date(on + "T00:00:00Z").getUTCDay() !== 1) fail("学期首周日期必须是周一"); return on;
}
function strings(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) fail(label + "无效");
  const values = value.map(v => text(v, label, 200));
  if (new Set(values).size !== values.length) fail(label + "不能重复");
  return values;
}
function clean(entity: Entity): Entity {
  const result = JSON.parse(JSON.stringify(entity)) as Entity;
  delete result.identityKey; delete result.data.identityKey;
  return result;
}
const ROLE = ["member", "leader", "admin", "officer"];
const DAY = 86400000;
const OBSERVATION_FIELDS = ["absentNames", "leaveNames", "otherDescription", "evaluation", "feedback", "suggestion"];
export function createGatewayV2(deps: DependenciesV2) {
  const executionConfigured = Number.isInteger(deps.maxExecutionMs) && deps.maxExecutionMs >= 1000 && deps.maxExecutionMs <= 900000;
  const requireExecution = () => { if (!executionConfigured) fail("请配置与云函数实际执行上限一致的 maxExecutionMs", "CONFIGURATION"); };
  const repo = deps.repository;
  return async (input: ApiRequest, context: { OPENID?: string; APPID?: string }): Promise<ApiResponse> => {
    if (!context.OPENID || context.APPID !== deps.appid) fail("微信身份无效", "UNAUTHENTICATED");
    if (!input || input.protocolVersion !== 2) fail("请更新小程序", "UPGRADE_REQUIRED");
    const allowed = ["bootstrap", "initialize", "query", "command", "photo", "photoUrls", "clearPreview", "clearBegin", "clearStep"];
    if (!allowed.includes(input.operation)) fail("请更新小程序", "UPGRADE_REQUIRED");
    if (JSON.stringify(input).length > 1200000) fail("单次请求过大");
    if (input.operation === "bootstrap" && input.payload?.fastPage === true && repo.bootstrapPage &&
        (input.payload.includeHome === true || ["schedule","records","profile","courses","availability"].includes(String((input.payload.page as PageLoadRequest | undefined)?.view)))) {
      const fast = await repo.bootstrapPage(context.OPENID, {...input.payload,epoch:input.epoch},context.OPENID === deps.bootstrapOpenid);
      if (fast) return {...fast,data:{...fast.data,executionConfigured}};
    }
    const identityKey = context.OPENID;
    const now = deps.now?.() ?? Date.now();
    const at = new Date(now).toISOString();
    // Hints only move database reads earlier. They never establish identity or permission.
    const readOnly = ["bootstrap", "query", "photoUrls", "clearPreview"].includes(input.operation);
    const hintId = (value: unknown) => readOnly && typeof value === "string" && value.length <= 200 ? value : "";
    const memberHint = hintId(input.readHint?.memberId);
    const p = input.payload || {};
    // Read the permission fence BEFORE speculative rows, then check it again in response().
    let workspace = await repo.workspace();
    const pageRequest = p.page as PageLoadRequest | undefined;
    const semesterHint = input.operation === "bootstrap" && (p.includeHome === true || p.page !== undefined)
      ? hintId(input.readHint?.semesterId) || hintId(pageRequest?.semesterId) || workspace.activeSemesterId : "";
    const [bindingAhead, memberAhead, semesterAhead] = await Promise.all([
      repo.query("bindings", {eq:{identityKey,epoch:workspace.epoch},limit:1}),
      memberHint ? repo.get("members", memberHint) : Promise.resolve(undefined),
      semesterHint ? repo.get("semesters", semesterHint) : Promise.resolve(undefined),
    ]);
    const reads = new Map<string, ReadVersion>();
    const changes = new Map<string, Change>();
    const resourceVersions: Record<string, number> = { workspace: workspace.version };
    const track = (resource: Resource, row: Entity): Entity => {
      reads.set(resource + ":" + row.id, { resource, id: row.id, version: row.version });
      if (!["bindings", "requests"].includes(resource)) resourceVersions[resource + ":" + row.id] = row.version; return row;
    };
    const get = async (resource: Resource, id: string, required = true): Promise<Entity | undefined> => {
      const row = resource === "semesters" && id === semesterHint && semesterAhead?.epoch === workspace.epoch
        ? semesterAhead : await repo.get(resource, id);
      if ((!row || row.epoch !== workspace.epoch) && required) fail("对象不存在或已清空", "NOT_FOUND");
      return row && row.epoch === workspace.epoch ? track(resource, row) : undefined;
    };
    const page = async (resource: Resource, query: Query = {}) => {
      const result = await repo.query(resource, { ...query, eq: { ...query.eq, epoch: workspace.epoch } });
      result.items.forEach(row => track(resource, row)); return result;
    };
    const all = async (resource: Resource, query: Query = {}): Promise<Entity[]> => {
      const rows: Entity[] = []; let cursor = "";
      do { const next = await page(resource, { ...query, after: cursor, limit: 100 }); rows.push(...next.items); cursor = next.cursor; } while (cursor);
      return rows;
    };
    const binding = bindingAhead.items[0];
    if (binding) track("bindings", binding);
    const actor = binding ? memberAhead && memberAhead.id === binding.memberId && memberAhead.epoch === workspace.epoch
      ? track("members", memberAhead) : await get("members", binding.memberId || "", false) : undefined;
    const validActor = actor?.data.active === true ? actor : undefined;
    const member = () => { if (!validActor) fail("请先申请并通过审核", "FORBIDDEN"); return validActor; };
    const manager = () => { const a = member(); if (!["admin", "leader"].includes(String(a.data.role))) fail("没有管理权限", "FORBIDDEN"); return a; };
    const coordinator = () => { const a = member(); if (!canCoordinate(a.data.role)) fail("没有协作权限", "FORBIDDEN"); return a; };
    const admin = () => { const a = member(); if (a.data.role !== "admin") fail("仅管理员可操作", "FORBIDDEN"); return a; };
    const epoch = () => { if (input.epoch !== workspace.epoch) fail("业务数据已变化，请刷新", "EPOCH_CONFLICT"); };
    const mutable = () => { epoch(); if (workspace.maintenance) fail("业务数据正在维护，请稍后再试", "MAINTENANCE"); };
    const expected = (row: Entity) => {
      if (input.expectedVersion !== row.version) fail("数据已被修改，请刷新后重试", "VERSION_CONFLICT");
    };
    const put = (resource: Resource, row: Entity) => {
      changes.set(resource + ":" + row.id, { resource, id: row.id, expectedVersion: row.version, value: { ...row } });
      return row;
    };
    const add = (resource: Resource, data: Record<string, unknown>, extra: Partial<Entity> = {}, id = deps.uuid()) =>
      put(resource, { ...extra, id, epoch: workspace.epoch, version: 0, data });
    const drop = (resource: Resource, row: Entity) => changes.set(resource + ":" + row.id, { resource, id: row.id, expectedVersion: row.version, value: null });
    const audit = (action: string, target: string, details: Record<string, unknown> = {}) => add("audit", { action, actorId: actor?.id || "", target, at, ...details }, { memberId: actor?.id, semesterId: input.semesterId });
    const response = async (data: Record<string, unknown>, cursor?: string): Promise<ApiResponse> => {
      const current = await repo.workspace();
      if (current.epoch !== workspace.epoch) fail("业务数据已变化，请刷新", "EPOCH_CONFLICT");
      if (current.permissionsVersion !== workspace.permissionsVersion) fail("权限已变化，请刷新后重新操作", "VERSION_CONFLICT");
      return { protocolVersion: 2, epoch: workspace.epoch, resourceVersions, data, ...(cursor === undefined ? {} : { cursor }) };
    };
    const commit = async (result: Record<string, unknown> = {}, patch?: Partial<Workspace>, maintenanceId?: string, initialize = false, autoJoin = false) => {
      const requestId = text(input.requestId, "请求标识", 200);
      const changed = Array.from(changes.values()).filter(c => c.value && c.resource !== "bindings" && c.resource !== "photos" && c.resource !== "audit").map(c => clean({ ...c.value!, version: c.expectedVersion + 1 }));
      const outcome = await repo.commit({ epoch: workspace.epoch, workspaceVersion: workspace.version,
        permissionsVersion: workspace.permissionsVersion, identityKey, actorId: actor?.id || (initialize ? String(result.adminId) : autoJoin ? String(result.memberId) : ""),
        requestId, reads: Array.from(reads.values()), changes: Array.from(changes.values()), workspace: patch,
        maintenanceId, initialize, autoJoin, result: { changed, refresh: Array.from(new Set(Array.from(changes.values()).map(c => c.resource))), ...result } });
      const expectedEpoch = patch?.epoch || workspace.epoch;
      workspace = await repo.workspace();
      if (workspace.epoch !== expectedEpoch) fail("业务数据已变化，请刷新", "EPOCH_CONFLICT");
      resourceVersions.workspace = workspace.version;
      for (const change of changes.values()) if (change.value && !["bindings", "requests"].includes(change.resource)) resourceVersions[change.resource + ":" + change.id] = change.expectedVersion + 1;
      return response(outcome);
    };
    const requireSemester = async () => {
      const id = text(input.semesterId, "学期标识", 200);
      return (await get("semesters", id))!;
    };
    const requireWeek = (semester: Entity) => integer(p.week, "周次", 1, Number(semester.data.weeks));
    const classesFor = async (ids: string[]) => {
      const rows: Entity[] = [];
      for (const id of ids) { const pending = changes.get("classes:" + id)?.value; rows.push(pending ? { ...pending, version: 0 } : (await get("classes", id))!); }
      return rows;
    };
    const validateCourseImport = async (semester: Entity, sourceText: string) => {
      const oldClasses = await all("classes");
      const oldCourses = await all("courses", { eq: { semesterId: semester.id } });
      const sem = { ...semester.data, id: semester.id, grades: semester.data.grades || [] } as unknown as Semester;
      const state = { schema: 1, activeSemesterId: semester.id, actorId: member().id, semesters: [sem], classes: oldClasses.map(c => ({ id: c.id, ...c.data })), courses: oldCourses.map(c => c.data.course), members: [{ id: member().id, ...member().data }], applications: [], availability: [], plans: [], drafts: [], records: [], audit: [], generation: 0 } as unknown as AppState;
      const imported = inspectImport(state, "courses", sourceText);
      if (imported.errors.length) fail(imported.errors.join("\n"));
      const classRows = new Map(oldClasses.map(c => [c.id, c]));
      for (const course of imported.courses) for (const id of course.classIds) {
        if (classRows.get(id)?.data.active === false) fail("不能使用停用班级");
      }
      return { imported, classRows };
    };
    const observation = async (recordId?: string, taskId?: string) => {
      const metrics = p.metrics as Metrics; if (!metrics || typeof metrics !== "object") fail("请填写观察数据"); validateMetrics(metrics);
      const photos = strings(p.photos, "照片", 3); if (!photos.length) fail("每份记录需要1至3张照片");
      for (const id of photos) {
        const photo = (await get("photos", id))!;
        if (recordId && photo.recordId === recordId) continue;
        if (photo.memberId !== member().id || photo.taskId !== taskId || (photo.recordId && photo.recordId !== recordId)) fail("不能引用其他记录或成员的照片", "FORBIDDEN");
      }
      const data: Record<string, unknown> = { metrics: { ...metrics }, photos };
      for (const key of OBSERVATION_FIELDS) data[key] = text(p[key] ?? "", key, 5000, true);
      return data;
    };
    const draftTask = (plan: Entity, task: Entity, data: Record<string, unknown>) => add("tasks", { ...data, status: "draft", replacesTaskId: task.id }, { semesterId: task.semesterId, week: task.week, memberId: String(data.memberId || task.memberId), parentId: plan.id });

    // A receipt is independent from historical business rows; replay before mutable validation.
    if (input.requestId && !["bootstrap", "query", "photoUrls", "clearPreview"].includes(input.operation)) {
      const receipt = (await page("requests", { eq: { identityKey, parentId: input.requestId }, limit: 1 })).items[0];
      if (receipt?.data.result) {
        if (receipt.data.permissionsVersion !== workspace.permissionsVersion) fail("权限已变化，请刷新后重新操作", "VERSION_CONFLICT");
        if (!validActor && !(input.operation === "command" && ["join", "rebindRequest"].includes(String(p.type)))) fail("原微信身份已失效", "FORBIDDEN");
        return response(receipt.data.result as Record<string, unknown>);
      }
    }
    const readWeek = async (semester: Entity, week: number, includeOccurrences = true) => {
      member();
      const filter: Query = { eq: { semesterId: semester.id, week } };
      const visibleFilter = !isManager(member().data.role) ? {eq:{...filter.eq,memberId:member().id}} : filter;
      const [tasks, plans, availability, records, occurrences] = await Promise.all([all("tasks", visibleFilter), all("plans", filter), all("availability", { eq: { ...filter.eq, memberId: member().id } }), all("records", visibleFilter), includeOccurrences ? all("occurrences", filter) : Promise.resolve([])]);
      return { semester: clean(semester), plan: plans.filter(x => ["confirmed", "skipped"].includes(String(x.data.status))).pop(), draft: plans.find(x => x.data.status === "draft"), uncovered: plans.find(x => x.data.status === "draft")?.data.uncovered || [], tasks: tasks.filter(t => isManager(member().data.role) || t.memberId === member().id).map(clean), plans: plans.map(clean), availability: availability[0] ? clean(availability[0]) : null, records: records.map(clean), occurrences: occurrences.map(clean) };
    };

    const paginated: Record<string, Resource> = { autoApproved: "applications", semesters: "semesters", classes: "classes", courses: "courses", members: "members", applications: "applications", rebindings: "rebindings", audit: "audit", records: "records", recordVersions: "record_versions" };
    const readList = async (kind: string, request: {semesterId?:string;week?:unknown;id?:unknown;version?:unknown;cursor?:string;limit?:number}, knownSemester = false) => {
      if (!Object.prototype.hasOwnProperty.call(paginated, kind)) fail("查询类型无效");
      if (kind === "rebindings" || kind === "autoApproved") admin();
      else if (["members", "applications", "audit"].includes(kind)) manager();
      else if (kind !== "classes") member(); // Unapproved applicants need class labels to apply.
      const query: Query = { after: request.cursor || "", limit: integer(request.limit ?? 50, "每页条数", 1, 100) };
      if (kind === "autoApproved") query.eq = { sortKey: "automatic" };
      if (["courses", "records", "recordVersions"].includes(kind)) { if (!knownSemester) await get("semesters", text(request.semesterId, "学期标识", 200)); query.eq = { semesterId: request.semesterId }; }
      if (kind === "records") {
        if (request.week !== undefined) query.eq!.week = integer(request.week, "周次", 1, 60);
        if (!isManager(member().data.role)) query.eq!.memberId = member().id;
      }
      if (kind === "recordVersions") {
        const record = (await get("records", text(request.id, "记录标识")))!;
        if (record.semesterId !== request.semesterId) fail("学期不匹配");
        if (!isManager(member().data.role) && record.memberId !== member().id) fail("不可查看他人记录", "FORBIDDEN");
        query.eq!.recordId = record.id;
      }
      const result = await page(paginated[kind], query);
      if (request.version !== undefined && request.version !== workspace.version) fail("列表已变化，请刷新后重试", "VERSION_CONFLICT");
      return { items: result.items.map(row => kind === "members" && member().data.role !== "admin" ? { ...clean(row), studentNo: undefined, data: { ...row.data, studentNo: "" } } : clean(row)), cursor: result.cursor };
    };
    if (input.operation === "bootstrap") {
      // Every initialized transaction is constrained to retain an effective admin.
      const hasAdministrator = workspace.version > 0;
      const status = !hasAdministrator ? "needsAdministrator" : !workspace.activeSemesterId ? "preparing" : "ready";
      const application = validActor ? undefined : (await page("applications", { eq: { identityKey }, limit: 1 })).items[0];
      // Home uses the same permission-filtered week data, within this request's identity check.
      let home;
      if (p.includeHome === true) {
        const semester = validActor && !workspace.maintenance && workspace.activeSemesterId ? await get("semesters", workspace.activeSemesterId) : undefined;
        const week = semester ? boundedWeek(semester.data as unknown as Semester, new Date(now)) : 1;
        home = { semester: semester ? clean(semester) : null, week, weekData: semester ? await readWeek(semester, week, false) : null };
      }
      let pageData;
      if (p.page !== undefined) {
        if (!p.page || typeof p.page !== "object" || Array.isArray(p.page)) fail("页面参数无效");
        const request = p.page as unknown as PageLoadRequest;
        if (request.more) epoch();
        // A cleared workspace invalidates saved semester selections; reset the client before querying.
        const staleEpoch = !!input.epoch && input.epoch !== workspace.epoch;
        pageData = validActor && !workspace.maintenance && !staleEpoch ? await readPageData(request, {
          actor: validActor, workspace, now, get, page, all, clean, fail,
          count: (resource, query) => repo.count(resource, {...query,eq:{...query.eq,epoch:workspace.epoch}}),
          list: (kind, semester, week, cursor) => readList(kind, {semesterId:semester?.id,week,cursor}, !!semester),
        }) : null;
      }
      return response({ ...(p.page !== undefined ? {page:pageData} : {}), ...(home ? { home } : {}), workspace: { ...workspace, autoApproval: validActor?.data.role === "admin" ? workspace.autoApproval : undefined }, member: validActor ? clean(validActor) : null, status, canInitialize: !hasAdministrator && context.OPENID === deps.bootstrapOpenid,
        application: application ? clean(application) : null, removed: !!actor && !validActor, executionConfigured });
    }
    if (input.operation === "initialize") {
      mutable(); if (context.OPENID !== deps.bootstrapOpenid) fail("仅指定初始化微信可建立首位管理员", "FORBIDDEN");
      if (workspace.version !== 0) fail("已存在管理员，不能重复初始化");
      const classInput = p.schoolClass as Record<string, unknown> || {};
      const semesterInput = p.semester as Record<string, unknown> || {};
      const schoolClass = add("classes", { name: text(classInput.name, "班级名称"), major: text(classInput.major, "专业"), grade: text(classInput.grade, "年级", 10), active: true });
      const semester = add("semesters", { name: text(semesterInput.name, "学期名称"), startDate: monday(semesterInput.startDate), weeks: integer(semesterInput.weeks, "周数", 1, 60), days: integer(semesterInput.days ?? 7, "每周天数", 1, 7), periods: integer(semesterInput.periods ?? 14, "每日节数", 1, 30), edition: text(semesterInput.edition ?? "", "届数", 50, true), status: "active" });
      const memberInput = p.member as Record<string, unknown> || p;
      const administrator = add("members", { name: text(memberInput.name, "姓名", 50), studentNo: text(memberInput.studentNo, "学号", 50), classId: schoolClass.id, role: "admin", active: true }, { studentNo: text(memberInput.studentNo, "学号", 50) });
      add("bindings", {}, { identityKey, memberId: administrator.id });
      add("semester_classes", {}, { semesterId: semester.id, parentId: schoolClass.id });
      audit("initialize", administrator.id);
      return commit({ adminId: administrator.id }, { activeSemesterId: semester.id, maxExecutionMs: deps.maxExecutionMs }, undefined, true);
    }
    if (input.operation === "query") {
      epoch(); if (workspace.maintenance) fail("业务数据正在维护", "MAINTENANCE");
      const kind = text(p.kind, "查询类型");
      if (kind === "importInspect") {
        admin(); const semester = await requireSemester();
        const { imported } = await validateCourseImport(semester, text(p.text, "JSON课表", 300000));
        return response({ courses: imported.courses.length, classes: imported.classes.length, version: workspace.version });
      }
      if (kind === "autoApproval") {
        admin(); const setting = workspace.autoApproval;
        return response({ setting: setting || null, active: setting?.enabled === true && Date.parse(setting.expiresAt) > now, expired: setting?.enabled === true && Date.parse(setting.expiresAt) <= now, version: workspace.version, serverNow: now });
      }
      if (Object.prototype.hasOwnProperty.call(paginated, kind)) {
        const result = await readList(kind, {semesterId:input.semesterId,week:p.week,id:p.id,version:p.version,cursor:input.cursor,limit:input.limit});
        return response({version:workspace.version,items:result.items},result.cursor);
      }
      if (kind === "semester") {
        member(); const semester = await requireSemester();
        const links = await all("semester_classes", { eq: { semesterId: semester.id } });
        return response({ semester: clean(semester), classIds: links.map(row => row.parentId) });
      }
      if (kind === "task") {
        member(); await requireSemester(); const task = (await get("tasks", text(p.id, "任务标识")))!;
        if (task.semesterId !== input.semesterId || !isManager(member().data.role) && task.memberId !== member().id) fail("不可查看他人任务", "FORBIDDEN");
        return response({ task: clean(task) });
      }
      if (kind === "submissionStatus") {
        coordinator(); const semester = await requireSemester(), week = requireWeek(semester);
        if (p.version !== undefined && p.version !== workspace.version) fail("名单已变化，请刷新", "VERSION_CONFLICT");
        const people = await page("members", {after:input.cursor || "",limit:integer(input.limit ?? 50,"每页条数",1,100)});
        const filter: Query = {eq:{semesterId:semester.id,week}};
        const [availability,tasks,records,plans,classes] = await Promise.all([
          all("availability",filter),all("tasks",filter),all("records",filter),all("plans",filter),
          all("classes",{in:{id:Array.from(new Set(people.items.map(m=>String(m.data.classId || ""))))}}),
        ]);
        const skipped = plans.some(plan=>plan.data.status === "skipped");
        const items = people.items.map(m=>{
          const av=availability.find(v=>v.memberId===m.id);
          const assigned=tasks.filter(t=>t.memberId===m.id && ["confirmed","submitted","pendingAdjustment"].includes(String(t.data.status)));
          const submitted=assigned.filter(t=>records.some(r=>r.taskId===t.id)).length;
          const required=m.data.active===true && (participatesByDefault(m.data.role) || av?.data.optedIn===true);
          return {id:m.id,name:String(m.data.name || ""),className:String(classes.find(c=>c.id===m.data.classId)?.data.name || ""),
            availability:skipped?"已跳过":av?"已提交":required?"未提交":"无需提交",
            record:skipped?"已跳过":!assigned.length?"无任务":submitted===assigned.length?"已提交":"未提交",
            assigned:skipped?0:assigned.length,submitted:skipped?0:submitted};
        });
        if ((await repo.workspace()).version !== workspace.version) fail("名单已变化，请刷新", "VERSION_CONFLICT");
        return response({items,version:workspace.version},people.cursor);
      }
      if (kind === "summaryReport") {
        coordinator(); const semester = await requireSemester(),week = requireWeek(semester);
        const filter: Query = {eq:{semesterId:semester.id,week}};
        const [records,plans] = await Promise.all([all("records",filter),all("plans",filter)]);
        if ((await repo.workspace()).version !== workspace.version) fail("报表数据已变化，请重新生成", "VERSION_CONFLICT");
        return response({summary:summarizeEntities(semester,week,records,plans.some(v=>v.data.status==='skipped')),version:workspace.version});
      }
      if (kind === "reportCheck") {
        coordinator(); if (p.format === "xlsx") admin(); await requireSemester();
        if (p.version !== workspace.version) fail("报表数据已变化，请重新生成", "VERSION_CONFLICT");
        return response({ valid: true, version: workspace.version });
      }
      if (kind === "record") {
        member(); await requireSemester(); const record = (await get("records", text(p.id, "记录标识")))!;
        if (record.semesterId !== input.semesterId) fail("学期不匹配");
        if (!isManager(member().data.role) && record.memberId !== member().id) fail("不可查看他人记录", "FORBIDDEN");
        return response({ record: clean(record), canEdit: member().data.role === "admin" || record.memberId === member().id && now - Date.parse(String(record.data.firstSubmittedAt)) < DAY });
      }
      if (kind === "week" || kind === "report" || kind === "excelReport") {
        member(); const semester = await requireSemester(); const week = requireWeek(semester);
        const filter: Query = { eq: { semesterId: semester.id, week } };
        if (kind === "report" || kind === "excelReport") {
          if (kind === "excelReport" || p.format === "xlsx") admin();
          manager(); if (p.reportVersion !== undefined && p.reportVersion !== workspace.version) fail("报表数据已变化，请重新生成", "VERSION_CONFLICT");
          const records = await all("records", filter);
          const latest = await repo.workspace(); if (latest.version !== workspace.version) fail("报表数据已变化，请重新生成", "VERSION_CONFLICT");
          const recordsData = records.map(r => ({ ...r.data, id: r.id, semesterId: r.semesterId, week: r.week, memberId: r.memberId, taskId: r.taskId })) as any[];
          const [occurrences, links, reportTasks, reportPlans] = await Promise.all([all("occurrences", filter), all("semester_classes", { eq: { semesterId: semester.id } }), all("tasks", filter), all("plans", filter)]);
          const participating = await classesFor(links.map(link => link.parentId!));
          const classMap = new Map<string, any>();
          for (const c of participating) classMap.set(c.id, { id: c.id, ...c.data });
          for (const occurrence of occurrences) for (const c of (occurrence.data.classes || []) as any[]) classMap.set(c.id, c);
          // Frozen observations override live labels for covered classes; each record also carries its own snapshot.
          for (const r of records) for (const c of (r.data.classes || []) as any[]) classMap.set(c.id, c);
          const classes = Array.from(classMap.values());
          const currentPlan = reportPlans.find(plan => ["confirmed", "skipped"].includes(String(plan.data.status)));
          const plans = currentPlan ? [{ ...currentPlan.data, semesterId: semester.id, week, revision: currentPlan.version, tasks: reportTasks.filter(task => ["confirmed", "submitted", "pendingAdjustment"].includes(String(task.data.status))).map(task => ({ id: task.id, memberId: task.memberId, ...task.data })) }] as any[] : [];
          const state: AppState = { schema: 1, activeSemesterId: semester.id, actorId: member().id, semesters: [{ ...semester.data, id: semester.id, grades: Array.from(new Set(classes.map(c => c.grade))) } as unknown as Semester], classes, members: [{ id: member().id, ...member().data } as any], applications: [], courses: occurrences.filter(o => o.data.status === "active").map(o => ({ ...(o.data.course as unknown as Course), id: o.id })), availability: [], plans, drafts: [], records: recordsData, audit: [], generation: 0 };
          if ((await repo.workspace()).version !== workspace.version) fail("报表数据已变化，请重新生成", "VERSION_CONFLICT");
          return response({ records: records.map(clean), semester: clean(semester), reportVersion: workspace.version, version: workspace.version, state });
        }
        return response(await readWeek(semester, week));
      }
      fail("查询类型无效");
    }
    if (input.operation === "photo") {
      requireExecution(); mutable(); member(); const task = (await get("tasks", text(p.taskId, "任务标识")))!;
      if (task.semesterId !== input.semesterId) fail("学期不匹配");
      const record = (await page("records", { eq: { taskId: task.id }, limit: 1 })).items[0];
      if (task.memberId !== member().id && member().data.role !== "admin") fail("不可上传他人任务照片", "FORBIDDEN");
      if (record && member().data.role !== "admin" && now - Date.parse(String(record.data.firstSubmittedAt)) >= DAY) fail("本人修改期限已过");
      const base64 = text(p.base64, "照片内容", 700000);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length * 3 / 4 > 512000) fail("单张照片不得超过500KB");
      const path = `cloud/${workspace.epoch}/${deps.uuid()}.jpg`;
      const storageId = await deps.photos.upload(path, base64);
      const photo = add("photos", { storageId, path, createdAt: at }, { semesterId: task.semesterId, memberId: member().id, taskId: task.id });
      // A failed commit leaves an orphan only inside this fixed epoch directory; maintenance sweeps it.
      return commit({ photoId: photo.id, fileID: photo.id });
    }
    if (input.operation === "photoUrls") {
      epoch(); member(); if (workspace.maintenance) fail("正在维护", "MAINTENANCE");
      let ids: string[];
      if (p.recordId) {
        const record = (await get("records", text(p.recordId, "记录标识")))!;
        if (record.semesterId !== input.semesterId || !isManager(member().data.role) && record.memberId !== member().id) fail("不可查看他人照片", "FORBIDDEN");
        let source = record;
        if (p.versionId) { source = (await get("record_versions", text(p.versionId, "版本标识")))!; if (source.recordId !== record.id) fail("版本归属不匹配", "FORBIDDEN"); }
        ids = strings(source.data.photos, "照片", 3);
      } else ids = strings(p.ids, "照片", 30);
      const storageIds: string[] = [];
      for (const id of ids) {
        const photo = (await get("photos", id))!;
        if (!input.semesterId || photo.semesterId !== input.semesterId) fail("照片学期不匹配");
        if (photo.recordId) {
          const record = (await get("records", photo.recordId))!;
          if (!isManager(member().data.role) && record.memberId !== member().id) fail("不可查看他人照片", "FORBIDDEN");
        } else if (photo.memberId !== member().id) fail("不可查看他人未提交照片", "FORBIDDEN");
        storageIds.push(String(photo.data.storageId));
      }
      return response({ urls: await deps.photos.urls(storageIds) });
    }
    if (input.operation.startsWith("clear")) {
      requireExecution(); admin(); epoch();
      const administrators = (await all("members")).filter(row => row.data.role === "admin");
      if (!administrators.some(row => row.data.active)) fail("没有有效管理员，停止清空");
      const retainedIds = Array.from(new Set(administrators.map(row => String(row.data.classId || ""))));
      if (retainedIds.includes("")) fail("管理员缺少绑定班级，停止清空");
      const retainedClasses = await classesFor(retainedIds);
      if (input.operation === "clearPreview") {
        const count = (resource: Resource) => repo.count(resource, { eq: { epoch: workspace.epoch } });
        const [classes, members, semesters, courses, records, photos] = await Promise.all([count("classes"), count("members"), count("semesters"), count("courses"), count("records"), count("photos")]);
        return response({ administrators: administrators.length, retainedClasses: retainedClasses.length, deletedClasses: classes - retainedClasses.length,
          members: members - administrators.length, semesters, courses, records, photos, version: workspace.version, jobId: workspace.maintenance });
      }
      if (input.operation === "clearBegin") {
        if (p.confirmation !== CLEAR_CONFIRMATION || input.expectedVersion !== workspace.version) fail("确认文字不符或数据已变化，请重新预览");
        if (workspace.maintenance) fail("已有维护任务，请继续处理");
        const job = add("maintenance", { status: "draining", oldEpoch: workspace.epoch, prefix: `cloud/${workspace.epoch}/`, startedAt: now,
          drainUntil: now + deps.maxExecutionMs + 1000, leaseUntil: 0, leaseToken: "", maxExecutionMs: deps.maxExecutionMs,
          retainedMemberIds: administrators.map(row => row.id), retainedClassIds: retainedIds, deletedPhotos: 0, resourceIndex: 0 });
        audit("clearBegin", job.id, { retainedAdministrators: administrators.length, retainedClasses: retainedIds.length });
        return commit({ jobId: job.id, done: false, waitMs: deps.maxExecutionMs + 1000 }, { maintenance: job.id, maxExecutionMs: deps.maxExecutionMs });
      }
      const jobId = text(p.jobId, "清空任务标识");
      const job = (await get("maintenance", jobId))!;
      if (job.data.status === "completed") return response({ done: true, jobId, waitMs: 0 });
      if (workspace.maintenance !== job.id || job.data.oldEpoch !== workspace.epoch || job.data.prefix !== `cloud/${workspace.epoch}/`) fail("旧维护任务不能处理当前轮次", "EPOCH_CONFLICT");
      if (job.data.maxExecutionMs !== deps.maxExecutionMs) fail("执行上限已改变，请按原维护配置恢复后继续", "CONFIGURATION");
      const waitMs = Math.max(0, Number(job.data.drainUntil) - now, Number(job.data.leaseUntil) - now);
      if (waitMs) return response({ done: false, jobId, waitMs });
      const token = deps.uuid(); job.data.leaseToken = token; job.data.leaseUntil = now + deps.maxExecutionMs + 1000;
      put("maintenance", job);
      // Acquire a persisted lease before touching storage. Each phase uses its own receipt.
      const stepId = text(input.requestId, "请求标识");
      input.requestId = "lease:" + token;
      await commit({ jobId, done: false }, undefined, job.id);
      changes.clear(); reads.clear();
      const held = (await get("maintenance", job.id))!;
      if (held.data.leaseToken !== token || held.data.oldEpoch !== workspace.epoch || workspace.maintenance !== held.id) fail("清理执行权已变化，请重试", "VERSION_CONFLICT");
      try {
        const files = await deps.photos.list(String(held.data.prefix), 20);
        if (files.length) {
          if (files.some(id => !id.startsWith("pg://xuedu-photos/" + String(held.data.prefix)))) fail("照片清单越过固定旧轮次，已停止清空");
          await deps.photos.delete(files);
          held.data.deletedPhotos = Number(held.data.deletedPhotos || 0) + files.length;
          held.data.status = "photos";
        } else {
          const retainedMembers = held.data.retainedMemberIds as string[];
          const retainedClassesIds = held.data.retainedClassIds as string[];
          const deletable: Resource[] = ["bindings", ...RESOURCES.filter(r => r !== "bindings")];
          let index = Number(held.data.resourceIndex || 0);
          let count = 0;
          while (index < deletable.length && count < 50) {
            const resource = deletable[index];
            const cursorKey = "cursor:" + resource;
            const result = await page(resource, { after: String(held.data[cursorKey] || ""), limit: 50 - count });
            for (const row of result.items) {
              const keep = resource === "maintenance" && row.id === held.id || resource === "members" && retainedMembers.includes(row.id) || resource === "bindings" && retainedMembers.includes(row.memberId || "") || resource === "classes" && retainedClassesIds.includes(row.id);
              if (!keep) { drop(resource, row); count++; }
            }
            if (result.cursor) { held.data[cursorKey] = result.cursor; break; }
            index++; held.data.resourceIndex = index;
          }
          held.data.status = "data";
          if (index === deletable.length) {
            const newEpoch = deps.uuid();
            for (const id of retainedMembers) { const row = (await get("members", id))!; row.epoch = newEpoch; put("members", row); }
            for (const row of await all("bindings")) if (retainedMembers.includes(row.memberId || "")) { row.epoch = newEpoch; put("bindings", row); }
            for (const id of retainedClassesIds) { const row = (await get("classes", id))!; row.epoch = newEpoch; put("classes", row); }
            held.data.status = "completed"; held.data.completedAt = at; held.data.leaseUntil = 0; held.epoch = newEpoch; put("maintenance", held);
            const entry = audit("clearComplete", job.id, { retainedAdministrators: retainedMembers.length, retainedClasses: retainedClassesIds.length }); entry.epoch = newEpoch; put("audit", entry);
            input.requestId = stepId;
            return commit({ done: true, jobId, waitMs: 0 }, { epoch: newEpoch, maintenance: "", activeSemesterId: "", autoApproval: null }, job.id);
          }
        }
        held.data.leaseUntil = 0; held.data.leaseToken = ""; put("maintenance", held);
        input.requestId = stepId;
        return commit({ done: false, jobId, waitMs: 0 }, undefined, job.id);
      } catch (error) {
        // Leave the lease persisted. A retry after maxExecutionMs cannot overlap the failed holder.
        throw error;
      }
    }
    if (input.operation !== "command") fail("请求操作无效");
    mutable();
    const type = text(p.type, "命令类型");
    const reason = () => text(p.reason, "操作原因", 1000);
    const confirmation = () => { if (p.confirmed !== true) fail("请再次确认操作"); };
    if (type === "join") {
      if (actor) fail(actor.data.active ? "已有成员身份" : "资格已取消，请联系管理员恢复");
      const classId = text(p.classId, "班级"); const klass = (await get("classes", classId))!;
      if (klass.data.active === false) fail("班级已停用");
      const studentNo = text(p.studentNo, "学号", 50);
      if ((await page("members", { eq: { studentNo }, limit: 1 })).items.length) fail("学号已登记，请使用微信换绑申请");
      const existing = (await page("applications", { eq: { identityKey }, limit: 1 })).items[0];
      if (existing) { expected(existing); if (existing.data.status !== "rejected") fail("已有申请，请勿重复提交"); }
      const data = { name: text(p.name, "姓名", 50), studentNo, classId, classLabel: klass.data.name, status: "pending", createdAt: at };
      const application = existing ? put("applications", { ...existing, data, studentNo }) : add("applications", data, { identityKey, studentNo });
      const setting = workspace.autoApproval;
      if (setting?.enabled === true && Date.parse(setting.expiresAt) > now) {
        const joined = add("members", { name: data.name, studentNo, classId, active: true, role: "member", joinedAt: at, approvalMode: "automatic" }, { studentNo });
        add("bindings", {}, { memberId: joined.id, identityKey });
        application.data = { ...data, status: "approved", approvalMode: "automatic", memberId: joined.id, reviewedAt: at, autoApprovalEnabledBy: setting.updatedBy, autoApprovalExpiresAt: setting.expiresAt };
        application.sortKey = "automatic"; put("applications", application);
        audit("autoApproveApplication", application.id, { memberId: joined.id, enabledBy: setting.updatedBy, deadline: setting.expiresAt });
        try { return await commit({ memberId: joined.id, automaticallyApproved: true }, undefined, undefined, false, true); }
        catch (error) { if (error instanceof Error && error.message === "AUTO_APPROVAL_EXPIRED") fail("自动通过已到期，请重新提交转入人工审核", "AUTO_APPROVAL_EXPIRED"); throw error; }
      }
      return commit({ automaticallyApproved: false });
    }
    if (type === "rebindRequest") {
      if (actor) fail("当前微信已有成员绑定，不能认领其他成员");
      const studentNo = text(p.studentNo, "学号", 50);
      const target = (await page("members", { eq: { studentNo }, limit: 1 })).items[0];
      if (!target || !target.data.active) fail("无法申请换绑，请联系管理员核实");
      const previous = (await page("rebindings", { eq: { identityKey }, limit: 1 })).items[0];
      if (previous && previous.data.status === "pending") fail("已有换绑申请等待核实");
      add("rebindings", { status: "pending", reason: reason(), createdAt: at }, { identityKey, memberId: target.id, studentNo });
      return commit();
    }
    member();
    if (type === "autoApprovalSet") {
      admin(); if (input.expectedVersion !== workspace.version) fail("设置已变化，请刷新后重试", "VERSION_CONFLICT");
      if (typeof p.enabled !== "boolean") fail("开关状态无效");
      let expiresAt = workspace.autoApproval?.expiresAt || "";
      if (p.enabled) {
        const inputDate = text(p.expiresAt, "截止时间", 40);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(inputDate) || !Number.isFinite(Date.parse(inputDate)) || Date.parse(inputDate) <= now) fail("请设置晚于当前时间的截止时间");
        date(inputDate.slice(0, 10));
        expiresAt = new Date(inputDate).toISOString();
      }
      const setting = { enabled: p.enabled, expiresAt, updatedBy: member().id, updatedByName: String(member().data.name), updatedAt: at };
      audit(p.enabled ? "autoApprovalEnabled" : "autoApprovalDisabled", "workspace", { before: workspace.autoApproval || null, after: setting, actorName: member().data.name });
      return commit({}, { autoApproval: setting });
    }
    if (type === "applicationReview") {
      manager(); const application = (await get("applications", text(p.id, "申请标识")))!; expected(application);
      if (application.data.status !== "pending") fail("申请已经处理");
      if (p.approved === true) {
        const klass = (await get("classes", String(application.data.classId)))!; if (klass.data.active === false) fail("班级已停用");
        if ((await page("members", { eq: { studentNo: application.studentNo }, limit: 1 })).items.length || (await page("bindings", { eq: { identityKey: application.identityKey }, limit: 1 })).items.length) fail("身份或学号已登记");
        const joined = add("members", { name: application.data.name, studentNo: application.studentNo, classId: application.data.classId, active: true, role: "member" }, { studentNo: application.studentNo });
        add("bindings", {}, { memberId: joined.id, identityKey: application.identityKey });
        application.data.memberId = joined.id; application.data.status = "approved";
      } else { application.data.status = "rejected"; application.data.reason = reason(); }
      application.data.reviewedBy = member().id; application.data.reviewedAt = at; put("applications", application); audit(type, application.id); return commit();
    }
    if (["roleChange", "memberRestore", "memberRemove", "memberStatus"].includes(type)) {
      const target = (await get("members", text(p.id, "成员标识")))!; expected(target);
      const before = { ...target.data }; const why = reason();
      if (type === "roleChange") { admin(); confirmation(); if (!target.data.active || !ROLE.includes(String(p.role))) fail("仅可为已审核有效成员调整角色"); target.data.role = p.role; }
      else if (type === "memberRestore") { admin(); if (target.data.role !== "member" || target.data.active) fail("仅可恢复已移除普通成员"); target.data.active = true; delete target.data.removedAt; }
      else if (type === "memberStatus") { admin(); confirmation(); if (typeof p.active !== "boolean") fail("启停状态无效"); target.data.active = p.active; }
      else { manager(); if (target.data.role !== "member") fail("只能移除普通成员"); target.data.active = false; target.data.removedAt = at; }
      if (before.role === "admin" && (!target.data.active || target.data.role !== "admin")) {
        const admins = (await all("members")).filter(m => m.id !== target.id && m.data.role === "admin" && m.data.active);
        if (!admins.length) fail("必须保留至少一名有效管理员");
      }
      put("members", target);
      if (target.data.active === false) {
        for (const task of await all("tasks", { eq: { memberId: target.id }, in: { status: ["confirmed", "pendingAdjustment", "draft"] } })) {
          if (["confirmed", "pendingAdjustment", "draft"].includes(String(task.data.status))) { task.data.status = "cancelled"; task.data.reason = why; put("tasks", task); }
        }
      }
      audit(type, target.id, { before, after: target.data, reason: why }); return commit();
    }
    if (type === "rebindConfirm") {
      admin(); confirmation(); const why = reason(); const request = (await get("rebindings", text(p.id, "换绑申请")))!; expected(request);
      if (request.data.status !== "pending") fail("换绑申请已处理");
      const target = (await get("members", request.memberId || ""))!; if (!target.data.active) fail("成员已停用");
      if ((await page("bindings", { eq: { identityKey: request.identityKey }, limit: 1 })).items.length) fail("新微信已有绑定");
      for (const old of await all("bindings", { eq: { memberId: target.id } })) drop("bindings", old);
      add("bindings", {}, { identityKey: request.identityKey, memberId: target.id });
      request.data.status = "approved"; request.data.reviewedAt = at; request.data.reviewedBy = member().id; put("rebindings", request);
      audit(type, target.id, { reason: why }); return commit();
    }
    if (type === "classSave" || type === "classDisable") {
      admin(); const row = p.id ? (await get("classes", text(p.id, "班级标识")))! : undefined;
      if (row) expected(row);
      if (type === "classDisable") { if (!row || typeof p.active !== "boolean") fail("班级状态无效"); row.data.active = p.active; put("classes", row); }
      else {
        const data = { name: text(p.name, "班级名称"), grade: text(p.grade, "年级", 10), major: text(p.major, "专业"), active: row?.data.active ?? true };
        if (row) { row.data = data; put("classes", row); } else add("classes", data);
      }
      audit(type, row?.id || "new"); return commit();
    }
    if (type === "semesterCreate") {
      admin(); const semester = add("semesters", { name: text(p.name, "学期名称"), startDate: monday(p.startDate), weeks: integer(p.weeks, "周数", 1, 60), days: integer(p.days ?? 7, "每周天数", 1, 7), periods: integer(p.periods ?? 14, "每日节数", 1, 30), edition: text(p.edition ?? "", "届数", 50, true), status: "draft" });
      audit(type, semester.id); return commit();
    }
    if (type === "semesterActivate" || type === "semesterParticipants") {
      admin(); const semester = await requireSemester(); if (p.id && p.id !== semester.id) fail("学期不匹配"); expected(semester);
      if (type === "semesterActivate") {
        confirmation(); const why = reason(); semester.data.status = "active"; put("semesters", semester); audit(type, semester.id, { reason: why, previous: workspace.activeSemesterId });
        return commit({}, { activeSemesterId: semester.id });
      }
      const ids = strings(p.classIds, "参与班级", 200); const classes = await classesFor(ids);
      if (classes.some(c => c.data.active === false)) fail("不能加入已停用班级");
      for (const old of await all("semester_classes", { eq: { semesterId: semester.id } })) drop("semester_classes", old);
      for (const id of ids) add("semester_classes", {}, { semesterId: semester.id, parentId: id });
      semester.data.grades = Array.from(new Set(classes.map(c => c.data.grade))); put("semesters", semester); audit(type, semester.id); return commit();
    }
    const semester = await requireSemester();
    const sem = { ...semester.data, id: semester.id, grades: semester.data.grades || [] } as unknown as Semester;
    const makeDraft = async (week: number, why: string) => {
      for (const old of await all("plans", { eq: { semesterId: semester.id, week } })) {
        if (old.data.status === "draft") {
          old.data.status = "superseded"; put("plans", old);
          for (const task of await all("tasks", { eq: { parentId: old.id } })) if (task.data.status === "draft") { task.data.status = "superseded"; put("tasks", task); }
        }
      }
      return add("plans", { status: "draft", reason: why, createdAt: at, uncovered: [] }, { semesterId: semester.id, week });
    };
    const eligibleTask = async (who: string, occurrence: Entity, week: number, used: Set<string>) => {
      const m = (await get("members", who))!;
      const course = occurrence.data.course as unknown as Course;
      if (!m.data.active || !m.data.classId || course.classIds.includes(String(m.data.classId))) fail("成员不能听本人班级且必须有效");
      if (used.has(who)) fail("每人每周至多一次，已完成任务也计入");
      const av = (await page("availability", { eq: { semesterId: semester.id, week, memberId: who }, limit: 1 })).items[0];
      if (!av || !Array.isArray(av.data.slots) || !slotsFor(course).every(slot => (av.data.slots as string[]).includes(slot)) || !participatesByDefault(m.data.role) && !av.data.optedIn) fail("成员未申报完整可用时段或未自愿参加");
      if (occurrence.data.status !== "active" || occurrence.semesterId !== semester.id || occurrence.week !== week) fail("上课实例已失效或周次不匹配");
      used.add(who); return m;
    };
    const taskData = (occurrence: Entity, m: Entity) => ({ occurrenceId: occurrence.id, course: occurrence.data.course, classes: occurrence.data.classes, classLabel: occurrence.data.classLabel,
      date: occurrence.date, memberId: m.id, memberName: m.data.name, status: "draft" });
    const updateDraftCoverage = async (plan: Entity) => {
      const week = plan.week!;
      const mergePending = (resource: Resource, rows: Entity[]) => {
        const merged = new Map(rows.map(row => [row.id, row]));
        for (const change of changes.values()) if (change.resource === resource) {
          if (!change.value) merged.delete(change.id);
          else if (change.value.semesterId === semester.id && change.value.week === week) merged.set(change.id, { ...change.value, version: change.expectedVersion });
          else merged.delete(change.id);
        }
        return Array.from(merged.values());
      };
      const tasks = mergePending("tasks", await all("tasks", { eq: { semesterId: semester.id, week } }));
      const occurrences = mergePending("occurrences", await all("occurrences", { eq: { semesterId: semester.id, week } })).filter(row => row.data.status === "active");
      const draftTasks = tasks.filter(task => task.parentId === plan.id && task.data.status === "draft");
      const replaced = new Set(draftTasks.map(task => String(task.data.replacesTaskId || "")));
      const currentTasks = tasks.filter(task => ["confirmed", "submitted", "pendingAdjustment"].includes(String(task.data.status)) && !replaced.has(task.id));
      const covered = new Set([...currentTasks, ...draftTasks.filter(task => !task.data.cancel)].flatMap(task => ((task.data.course as unknown as Course)?.classIds || [])));
      const links = await all("semester_classes", { eq: { semesterId: semester.id } });
      const participating = (await classesFor(links.map(link => link.parentId!))).filter(row => row.data.active !== false);
      const groups = new Map<string, string[]>();
      for (const occurrence of occurrences) {
        const ids = (occurrence.data.course as unknown as Course).classIds.filter(id => participating.some(c => c.id === id)).slice().sort();
        if (ids.length) groups.set(ids.join("|"), ids);
      }
      for (const klass of participating) if (![...groups.values()].some(ids => ids.includes(klass.id))) groups.set(klass.id, [klass.id]);
      const uncovered = [...groups.values()].filter(ids => !ids.every(id => covered.has(id))).map(ids => ({
        label: ids.map(id => participating.find(c => c.id === id)?.data.name || id).join(" / "),
        reason: (occurrences.some(row => (row.data.course as unknown as Course).classIds.some(id => ids.includes(id))) ? "调整后尚未安排，等待补排" : "本周无有效上课实例，等待课表维护") + "；" + String(plan.data.reason || "调整草稿"),
      }));
      plan.data.uncovered = uncovered; put("plans", plan);
    };
    const rebuildCourse = async (courseRow: Entity, effectiveDate: string) => {
      const versions = await all("course_versions", { eq: { parentId: courseRow.id } });
      for (const change of changes.values()) if (change.resource === "course_versions" && change.value?.parentId === courseRow.id) versions.push({ ...change.value, version: change.expectedVersion + 1 });
      versions.sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.data.sequence || 0) - Number(b.data.sequence || 0));
      const existing = await all("occurrences", { eq: { parentId: courseRow.id } });
      const exceptions = await all("exceptions", { eq: { parentId: courseRow.id } });
      for (const change of changes.values()) if (change.resource === "exceptions" && change.value?.parentId === courseRow.id) {
        const i = exceptions.findIndex(e => e.id === change.id); if (i >= 0) exceptions.splice(i, 1);
        exceptions.push({ ...change.value, version: change.expectedVersion + 1 });
      }
      const desired = new Map<string, Entity>();
      const addOccurrence = async (on: string, version: Entity, exception?: Entity, extra = false) => {
        const course = { ...(version.data.course as unknown as Course), id: courseRow.id, semesterId: semester.id };
        let targetDate = on;
        if (exception?.data.kind === "cancel") return;
        if (exception?.data.newDate) targetDate = String(exception.data.newDate);
        if (exception?.data.start !== undefined) course.start = Number(exception.data.start);
        if (exception?.data.end !== undefined) course.end = Number(exception.data.end);
        if (exception?.data.classroom !== undefined) course.classroom = String(exception.data.classroom);
        const targetWeek = currentWeek(sem, new Date(targetDate + "T12:00:00+08:00"));
        if (targetWeek < 1 || targetWeek > sem.weeks) fail("调补课日期超出学期范围");
        const offset = Math.round((Date.parse(targetDate + "T00:00:00Z") - Date.parse(sem.startDate + "T00:00:00Z")) / DAY);
        course.weekday = offset % 7 + 1; course.weeks = [targetWeek];
        if (course.start > course.end || course.end > sem.periods) fail("调课节次无效");
        const klasses = await classesFor(course.classIds);
        const id = courseRow.id + ":" + on + (extra ? ":extra:" + exception!.id : "");
        const old = existing.find(e => e.id === id);
        desired.set(id, { id, epoch: workspace.epoch, version: old?.version || 0, semesterId: semester.id, week: targetWeek, date: targetDate, parentId: courseRow.id,
          data: { course, classes: klasses.map(c => ({ id: c.id, ...c.data })), classLabel: klasses.map(c => c.data.name).join(" / "), status: "active", originalDate: on, courseVersionId: version.id } });
      };
      for (let w = 1; w <= sem.weeks; w++) for (let day = 1; day <= 7; day++) {
        const on = weekDate(sem, w, day); if (on < effectiveDate) continue;
        const version = versions.filter(v => String(v.date) <= on).pop();
        if (!version || version.data.active === false) continue;
        const course = version.data.course as unknown as Course;
        if (course.weekday !== day || !course.weeks.includes(w)) continue;
        await addOccurrence(on, version, exceptions.find(e => e.date === on && e.data.kind !== "extra"));
      }
      for (const exception of exceptions.filter(e => e.data.kind === "extra" && String(e.date) >= effectiveDate)) {
        const version = versions.filter(v => String(v.date) <= String(exception.date)).pop();
        if (version && version.data.active !== false) await addOccurrence(String(exception.date), version, exception, true);
      }
      const affected: Entity[] = [];
      for (const old of existing) {
        if (String(old.data.originalDate || old.date) < effectiveDate) continue;
        if (!desired.has(old.id)) { old.data.status = "cancelled"; put("occurrences", old); affected.push(old); }
      }
      for (const occurrence of desired.values()) {
        const old = existing.find(e => e.id === occurrence.id);
        if (!old || JSON.stringify(old.data) !== JSON.stringify(occurrence.data) || old.date !== occurrence.date) { put("occurrences", occurrence); if (old) affected.push(occurrence); }
      }
      const impacted: Entity[] = [];
      const draftByWeek = new Map<number, Entity>();
      for (const occurrence of affected) {
        for (const task of await all("tasks", { eq: { semesterId: semester.id, week: existing.find(e => e.id === occurrence.id)?.week || occurrence.week } })) {
          if (task.data.occurrenceId !== occurrence.id || !["confirmed", "pendingAdjustment"].includes(String(task.data.status))) continue;
          task.data.status = "pendingAdjustment"; put("tasks", task); impacted.push(task);
          let plan = draftByWeek.get(task.week!);
          if (!plan) { plan = await makeDraft(task.week!, "课程或停调课影响任务，需人工确认"); draftByWeek.set(task.week!, plan); }
          const replacement = { ...task.data, ...(occurrence.data.status === "active" ? { course: occurrence.data.course, classes: occurrence.data.classes, classLabel: occurrence.data.classLabel, date: occurrence.date, occurrenceId: occurrence.id } : {}), cancel: occurrence.data.status !== "active" || occurrence.week !== task.week };
          draftTask(plan, task, replacement);
          if (occurrence.data.status === "active" && occurrence.week !== task.week) {
            let destination = draftByWeek.get(occurrence.week!);
            if (!destination) { destination = await makeDraft(occurrence.week!, "调课跨周，请核对新周成员时间后确认"); draftByWeek.set(occurrence.week!, destination); }
            const m = (await get("members", task.memberId!))!;
            add("tasks", taskData(occurrence, m), { semesterId: semester.id, week: occurrence.week, memberId: task.memberId, parentId: destination.id });
          }
        }
      }
      for (const plan of draftByWeek.values()) await updateDraftCoverage(plan);
      return impacted.map(clean);
    };
    if (type === "import") {
      admin(); const sourceText = text(p.text, "JSON课表", 300000);
      const { imported, classRows } = await validateCourseImport(semester, sourceText);
      if (imported.classes.length + imported.courses.length > 200 || imported.courses.reduce((n, c) => n + c.weeks.length, 0) > 700) fail("单批最多200个班级和课程、700个上课日期，请分批导入");
      const participants = await all("semester_classes", { eq: { semesterId: semester.id } });
      for (const c of imported.classes) classRows.set(c.id, add("classes", { name: c.name, grade: c.grade, major: c.major, active: true }, {}, c.id));
      const classIds = Array.from(new Set(imported.courses.flatMap(c => c.classIds)));
      for (const id of classIds) if (!participants.some(row => row.parentId === id)) add("semester_classes", {}, { semesterId: semester.id, parentId: id });
      for (const course of imported.courses) {
        const normalized = { ...course, semesterId: semester.id };
        const row = add("courses", { name: course.name, course: normalized, active: true }, { semesterId: semester.id }, course.id);
        const version = add("course_versions", { course: normalized, active: true, createdAt: at, sequence: workspace.version + 1 }, { semesterId: semester.id, parentId: row.id, date: sem.startDate });
        // Imported IDs are new: there are no historical versions, exceptions or tasks to rebuild.
        // Reuse the already validated class snapshots, avoiding database reads per course/date.
        const klasses = course.classIds.map(id => classRows.get(id)!);
        for (const week of new Set(course.weeks)) {
          const on = weekDate(sem, week, course.weekday);
          add("occurrences", { course: { ...normalized, weeks: [week] }, classes: klasses.map(c => ({ id: c.id, ...c.data })),
            classLabel: klasses.map(c => c.data.name).join(" / "), status: "active", originalDate: on, courseVersionId: version.id },
            { semesterId: semester.id, parentId: row.id, week, date: on }, row.id + ":" + on);
        }
      }
      audit(type, semester.id, { classes: imported.classes.length, courses: imported.courses.length }); return commit();
    }
    if (["courseSave", "courseDisable", "exceptionSave"].includes(type)) {
      admin(); const id = type === "exceptionSave" ? p.courseId : p.id;
      const row = id ? (await get("courses", text(id, "课程标识")))! : undefined;
      if (row) { if (row.semesterId !== semester.id) fail("学期不匹配"); expected(row); }
      const effectiveDate = date(type === "exceptionSave" ? p.date : p.effectiveDate);
      if (effectiveDate < sem.startDate || effectiveDate > weekDate(sem, sem.weeks, 7)) fail("生效日期超出学期范围");
      let courseRow: Entity;
      if (type === "exceptionSave") {
        if (!row) fail("课程不存在");
        if (!["cancel", "move", "extra"].includes(String(p.kind))) fail("停调课类型无效");
        const exceptionData: Record<string, unknown> = { kind: p.kind, reason: reason() };
        if (p.kind !== "cancel") {
          exceptionData.newDate = date(p.newDate ?? p.date);
          if (p.start !== undefined) exceptionData.start = integer(p.start, "开始节次", 1, sem.periods);
          if (p.end !== undefined) exceptionData.end = integer(p.end, "结束节次", 1, sem.periods);
          if (p.classroom !== undefined) exceptionData.classroom = text(p.classroom, "教室");
        }
        const old = p.kind === "extra" ? undefined : (await all("exceptions", { eq: { parentId: row.id, date: effectiveDate } })).find(e => e.data.kind !== "extra");
        if (old) { old.data = exceptionData; put("exceptions", old); } else add("exceptions", exceptionData, { semesterId: semester.id, parentId: row.id, date: effectiveDate });
        courseRow = row; put("courses", row);
      } else if (type === "courseDisable") {
        if (!row) fail("课程不存在"); courseRow = row; row.data.active = false; put("courses", row);
        add("course_versions", { course: row.data.course, active: false, createdAt: at, sequence: workspace.version + 1 }, { semesterId: semester.id, parentId: row.id, date: effectiveDate });
      } else {
        const classIds = strings(p.classIds, "课程班级", 200); if (!classIds.length) fail("请选择课程班级");
        const klasses = await classesFor(classIds); if (klasses.some(c => c.data.active === false)) fail("不能使用停用班级");
        const participants = await all("semester_classes", { eq: { semesterId: semester.id } });
        if (classIds.some(id => !participants.some(s => s.parentId === id))) fail("课程班级须先加入当期参与范围");
        if (!Array.isArray(p.weeks) || !p.weeks.length || p.weeks.length > sem.weeks) fail("有效周次无效");
        const weeks = p.weeks.map(w => integer(w, "有效周次", 1, sem.weeks));
        const course: Course = { id: row?.id || deps.uuid(), semesterId: semester.id, name: text(p.name, "课程名称"), teacher: text(p.teacher ?? "", "教师", 100, true), nature: text(p.nature ?? "", "课程性质", 100, true), classIds, classroom: text(p.classroom, "教室"), weekday: integer(p.weekday, "星期", 1, 7), start: integer(p.start, "开始节次", 1, sem.periods), end: integer(p.end, "结束节次", 1, sem.periods), weeks, expected: integer(p.expected, "应到人数", 0, 10000) };
        if (course.start > course.end) fail("开始节次不得晚于结束节次");
        if (row) { row.data = { name: course.name, course, active: true }; courseRow = put("courses", row); }
        else courseRow = add("courses", { name: course.name, course, active: true }, { semesterId: semester.id }, course.id);
        add("course_versions", { course, active: true, createdAt: at, sequence: workspace.version + 1 }, { semesterId: semester.id, parentId: courseRow.id, date: effectiveDate });
      }
      const impacts = await rebuildCourse(courseRow, effectiveDate); audit(type, courseRow.id, { effectiveDate }); return commit({ impacts });
    }
    if (type === "availabilitySave") {
      const week = requireWeek(semester); const slots = strings(p.slots, "无课时段", 210);
      if (slots.some(s => !/^([1-7]):([1-9]|[12][0-9]|30)$/.test(s) || Number(s.split(":")[1]) > sem.periods)) fail("无课时段超出范围");
      const old = (await page("availability", { eq: { semesterId: semester.id, week, memberId: member().id }, limit: 1 })).items[0];
      const data = { slots, optedIn: p.optedIn === true, note: text(p.note ?? "", "备注", 1000, true), updatedAt: at };
      if (old) { expected(old); old.data = data; put("availability", old); } else add("availability", data, { semesterId: semester.id, week, memberId: member().id });
      return commit();
    }
    if (["planGenerate", "taskAdjust", "planConfirm", "planSkip"].includes(type)) {
      if (type === "planSkip" || type === "planConfirm") admin();
      else if (type === "planGenerate") { if (!canGeneratePlan(member().data.role)) fail("无权生成排班草稿", "FORBIDDEN"); }
      else manager();
      if (type === "planConfirm") {
        const plan = (await get("plans", text(p.id, "草稿标识")))!; expected(plan);
        if (plan.semesterId !== semester.id || plan.data.status !== "draft") fail("草稿不存在或已失效");
        const week = plan.week!;
        if (plan.data.skip && (await page("records", { eq: { semesterId: semester.id, week }, limit: 1 })).items.length) fail("本周已有提交记录，不能整周跳过");
        const drafts = (await all("tasks", { eq: { parentId: plan.id } })).filter(t => t.data.status === "draft");
        const replaced = new Set(drafts.map(t => String(t.data.replacesTaskId || "")));
        const weekTasks = await all("tasks", { eq: { semesterId: semester.id, week } });
        const used = new Set(weekTasks.filter(t => ["confirmed", "submitted", "pendingAdjustment"].includes(String(t.data.status)) && !replaced.has(t.id)).map(t => t.memberId!));
        for (const task of drafts) {
          if (task.data.replacesTaskId) {
            const original = (await get("tasks", String(task.data.replacesTaskId)))!;
            if (original.data.status === "submitted" || (await page("records", { eq: { taskId: original.id }, limit: 1 })).items.length) fail("已完成任务不可调整");
            if (!["confirmed", "pendingAdjustment"].includes(String(original.data.status))) fail("原任务已改变，请重新生成草稿");
            original.data.status = "cancelled"; original.data.reason = plan.data.reason; put("tasks", original);
          }
          if (task.data.cancel) { task.data.status = "cancelled"; put("tasks", task); continue; }
          const occurrence = (await get("occurrences", String(task.data.occurrenceId)))!;
          await eligibleTask(task.memberId!, occurrence, week, used);
          if (JSON.stringify(task.data.course) !== JSON.stringify(occurrence.data.course) || task.data.date !== occurrence.date) fail("课程已变化，请重新生成草稿");
          task.data.status = "confirmed"; put("tasks", task);
        }
        for (const prior of await all("plans", { eq: { semesterId: semester.id, week } })) if (prior.id !== plan.id && ["confirmed", "skipped"].includes(String(prior.data.status))) { prior.data.status = "superseded"; put("plans", prior); }
        plan.data.status = plan.data.skip ? "skipped" : "confirmed"; plan.data.confirmedBy = member().id; plan.data.confirmedAt = at; put("plans", plan); audit(type, plan.id); return commit();
      }
      const week = requireWeek(semester);
      const currentPlan = (await all("plans", { eq: { semesterId: semester.id, week } })).find(plan => ["confirmed", "skipped"].includes(String(plan.data.status)));
      if (input.expectedVersion !== (currentPlan?.version || 0)) fail("周安排已变化，请刷新", "VERSION_CONFLICT");
      const tasks = await all("tasks", { eq: { semesterId: semester.id, week } });
      if (type === "planSkip") {
        const why = reason();
        if (tasks.some(task => task.data.status === "submitted") || (await page("records", { eq: { semesterId: semester.id, week }, limit: 1 })).items.length) fail("本周已有提交记录，不能整周跳过");
        const plan = await makeDraft(week, why); plan.data.skip = true;
        for (const task of tasks) if (["confirmed", "pendingAdjustment"].includes(String(task.data.status))) draftTask(plan, task, { ...task.data, cancel: true });
        audit(type, plan.id, { reason: why }); return commit();
      }
      if (type === "taskAdjust") {
        const why = reason(); if (!Array.isArray(p.changes) || !p.changes.length || p.changes.length > 100) fail("调整清单无效");
        const plan = await makeDraft(week, why);
        const adjustments = p.changes as Record<string, unknown>[];
        const replaced = new Set(adjustments.map(c => String(c.taskId || "")));
        if (replaced.size !== adjustments.filter(c => c.taskId).length + (adjustments.some(c => !c.taskId) ? 1 : 0)) fail("同一任务不能重复调整");
        const used = new Set(tasks.filter(t => ["confirmed", "submitted", "pendingAdjustment"].includes(String(t.data.status)) && !replaced.has(t.id)).map(t => t.memberId!));
        for (const change of adjustments) {
          const original = change.taskId ? tasks.find(t => t.id === change.taskId) : undefined;
          if (change.taskId && (!original || !["confirmed", "pendingAdjustment"].includes(String(original.data.status)))) fail("仅可调整未提交的有效任务");
          if (original && (await page("records", { eq: { taskId: original.id }, limit: 1 })).items.length) fail("已完成任务不可调整");
          if (change.cancel === true) { if (!original) fail("取消须指定原任务"); draftTask(plan, original, { ...original.data, cancel: true }); continue; }
          const occurrence = (await get("occurrences", text(change.occurrenceId || original?.data.occurrenceId, "上课实例")))!;
          const m = await eligibleTask(text(change.memberId || original?.memberId, "成员"), occurrence, week, used);
          const data = taskData(occurrence, m);
          if (original) draftTask(plan, original, data); else add("tasks", data, { semesterId: semester.id, week, memberId: m.id, parentId: plan.id });
        }
        await updateDraftCoverage(plan);
        audit(type, plan.id, { reason: why }); return commit();
      }
      const participants = await all("semester_classes", { eq: { semesterId: semester.id } });
      const activeClassIds = (await classesFor(participants.map(c => c.parentId!))).filter(c => c.data.active !== false).map(c => c.id);
      const occurrences = (await all("occurrences", { eq: { semesterId: semester.id, week } })).filter(o => o.data.status === "active" && (o.data.course as unknown as Course).classIds.every(id => activeClassIds.includes(id)));
      const previous = week > 1 ? await all("records", { eq: { semesterId: semester.id, week: week - 1 } }) : [];
      const completed = tasks.filter(t => t.data.status === "submitted");
      const used = new Set(completed.map(t => t.memberId));
      const covered = new Set(completed.flatMap(t => ((t.data.course as unknown as Course)?.classIds || [])));
      const members = await all("members"); const availability = await all("availability", { eq: { semesterId: semester.id, week } });
      const relatedClassIds = Array.from(new Set(occurrences.flatMap(o => (o.data.course as unknown as Course).classIds)));
      const classes = await classesFor(relatedClassIds);
      const state: AppState = { schema: 1, activeSemesterId: semester.id, actorId: member().id, semesters: [{ ...sem, grades: Array.from(new Set(classes.map(c => String(c.data.grade)))) }], classes: classes.map(c => ({ id: c.id, ...c.data } as any)), members: members.filter(m => !used.has(m.id)).map(m => ({ id: m.id, ...m.data } as any)), applications: [], courses: occurrences.filter(o => !(o.data.course as unknown as Course).classIds.some(id => covered.has(id))).map(o => ({ ...(o.data.course as unknown as Course), id: o.id })), availability: availability.map(a => ({ ...a.data, semesterId: a.semesterId, week: a.week, memberId: a.memberId } as any)), plans: [], drafts: [], records: previous.map(r => ({ ...r.data, id: r.id, semesterId: r.semesterId, week: r.week, memberId: r.memberId } as any)), audit: [], generation: 0 };
      const generated = generatePlan(state, semester.id, week, workspace.version);
      const plan = await makeDraft(week, "生成排班"); plan.data.uncovered = generated.uncovered;
      const replacing = tasks.filter(t => ["confirmed", "pendingAdjustment"].includes(String(t.data.status)));
      for (const task of replacing) draftTask(plan, task, { ...task.data, cancel: true });
      for (const task of generated.tasks) {
        const occurrence = occurrences.find(o => o.id === task.course.id)!;
        const m = members.find(m => m.id === task.memberId)!;
        add("tasks", taskData(occurrence, m), { semesterId: semester.id, week, memberId: m.id, parentId: plan.id });
      }
      audit(type, plan.id); return commit();
    }
    if (type === "recordSubmit" || type === "recordEdit") {
      if (type === "recordSubmit") {
        const task = (await get("tasks", text(p.taskId, "任务标识")))!; expected(task);
        if (task.semesterId !== semester.id || task.memberId !== member().id) fail("只能提交本人任务", "FORBIDDEN");
        if (task.data.status !== "confirmed") fail("任务尚未生效、待调整或已提交");
        const occurrence = (await get("occurrences", String(task.data.occurrenceId)))!;
        if (occurrence.data.status !== "active" || occurrence.date !== task.data.date || JSON.stringify(occurrence.data.course) !== JSON.stringify(task.data.course)) fail("课表已变化，请等待任务调整");
        if ((await page("records", { eq: { taskId: task.id }, limit: 1 })).items.length) fail("该任务已有记录");
        const observed = await observation(undefined, task.id);
        const record = add("records", { ...observed, course: task.data.course, classes: task.data.classes, classLabel: task.data.classLabel, memberName: task.data.memberName, date: task.data.date, firstSubmittedAt: at, createdAt: at, correctedAt: "", revision: 1 }, { semesterId: semester.id, week: task.week, memberId: member().id, taskId: task.id, date: String(task.data.date) });
        add("record_versions", { ...record.data, reason: "首次提交", actorId: member().id, editedAt: at, recordVersion: 1 }, { semesterId: semester.id, week: task.week, memberId: member().id, recordId: record.id });
        for (const id of observed.photos as string[]) { const photo = (await get("photos", id))!; photo.recordId = record.id; put("photos", photo); }
        task.data.status = "submitted"; put("tasks", task); audit(type, record.id); return commit();
      }
      const record = (await get("records", text(p.id, "记录标识")))!; expected(record);
      if (record.semesterId !== semester.id) fail("学期不匹配");
      if (member().data.role !== "admin") {
        if (record.memberId !== member().id) fail("只能修改本人记录", "FORBIDDEN");
        if (now - Date.parse(String(record.data.firstSubmittedAt)) >= DAY || now < Date.parse(String(record.data.firstSubmittedAt))) fail("首次提交已满24小时，请联系管理员纠错", "EDIT_WINDOW_CLOSED");
      }
      const why = reason();
      for (const key of ["memberId", "taskId", "semesterId", "course", "date", "firstSubmittedAt", "createdAt", "classes"]) if (p[key] !== undefined) fail("不能修改记录归属或首次提交时间");
      const observed = await observation(record.id, record.taskId);
      record.data = { ...record.data, ...observed, correctedAt: at, revision: Number(record.data.revision) + 1 };
      put("records", record);
      add("record_versions", { ...record.data, reason: why, actorId: member().id, editedAt: at, recordVersion: record.version + 1 }, { semesterId: semester.id, week: record.week, memberId: record.memberId, recordId: record.id });
      for (const id of observed.photos as string[]) { const photo = (await get("photos", id))!; photo.recordId = record.id; put("photos", photo); }
      audit(type, record.id, { reason: why, previousVersion: record.version }); return commit();
    }
    fail("命令类型无效");
  };
}
