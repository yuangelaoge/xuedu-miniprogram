import { AppState } from "../miniprogram/domain/types";
import { Command, executeCommand } from "../miniprogram/domain/commands";
import { membershipFor, applyForMembership } from "../miniprogram/domain/membership";
import { requireRole } from "../miniprogram/domain/actions";
import { clearTrialPeople, emptyWorkspace, initialState, visibleState } from "./policy";
import { validateSemester } from "../miniprogram/domain/imports";

export interface Document {
  stage: "trial" | "production";
  epoch: string;
  version: number;
  state: AppState;
  receipts: string[];
  files: { id: string; owner: string; task: string }[];
  cleaning?: boolean;
  resetAll?: { id: string; startedAt: number };
  lastResetId?: string;
}
export interface Dependencies {
  stage: "trial" | "production";
  appid: string;
  bootstrapOpenid: string;
  transact<T>(fn: (doc: Document) => Promise<T>): Promise<T>;
  upload(path: string, base64: string): Promise<string>;
  deleteFiles(ids: string[]): Promise<void>;
  urls(ids: string[]): Promise<string[]>;
  uuid(): string;
  now?(): number;
  listResetFiles?(): Promise<string[]>;
}
export function freshDocument(stage: "trial" | "production", epoch: string): Document {
  return { stage, epoch, version: 0, state: initialState(stage), receipts: [], files: [] };
}
export function createGateway(deps: Dependencies) {
  return async (event: any, context: { OPENID?: string; APPID?: string }) => {
    const openid = context.OPENID;
    if (!openid || context.APPID !== deps.appid) throw new Error("微信身份无效或 AppID 不匹配");
    if (!event || typeof event.operation !== "string") throw new Error("无效请求");
    const attach = (doc: Document) => {
      if (doc.stage !== deps.stage) throw new Error("环境配置不一致");
      doc.state.actorId = membershipFor(doc.state, openid)?.id || "";
    };
    const result = (doc: Document) => ({ stage: doc.stage, epoch: doc.epoch, version: doc.version, identity: "self", state: visibleState(doc.state, openid) });
    const checkEpoch = (doc: Document) => {
      if (event.epoch !== doc.epoch) throw new Error("试用数据已重置，请重新打开小程序");
      if (doc.cleaning) throw new Error("试用数据正在清理，请稍后再进入");
    };
    if (event.operation === "identity") return { openid };
    if (event.operation === "bootstrapWorkspace") {
      if (deps.stage !== "trial" || !deps.bootstrapOpenid || openid !== deps.bootstrapOpenid) throw new Error("无权重新初始化");
      return deps.transact(async doc => {
        attach(doc); checkEpoch(doc);
        if (doc.state.members.length || doc.state.semesters.length || doc.state.classes.length) throw new Error("工作区不是空白状态");
        validateSemester(event.semester);
        const c = event.schoolClass;
        if (!c || typeof c.grade !== "string" || !event.semester.grades.includes(c.grade) ||
          typeof c.major !== "string" || !c.major.trim() || c.major.length > 60 ||
          typeof c.name !== "string" || !c.name.trim() || c.name.length > 60) throw new Error("班级资料无效");
        const s = event.semester;
        doc.state.semesters = [{ id: "semester-" + deps.uuid(), name: s.name, startDate: s.startDate, weeks: s.weeks, grades: [...new Set<string>(s.grades)], days: s.days, periods: s.periods, edition: s.edition }];
        doc.state.activeSemesterId = doc.state.semesters[0].id;
        doc.state.classes = [{ id: "class-" + deps.uuid(), grade: c.grade, major: c.major.trim(), name: c.name.trim() }];
        doc.version++;
        return result(doc);
      });
    }
    if (["resetAllPreview", "resetAllBegin", "resetAllStep"].includes(event.operation)) {
      if (deps.stage !== "trial" || !deps.bootstrapOpenid || openid !== deps.bootstrapOpenid || !deps.listResetFiles) throw new Error("彻底重置仅限试用环境的初始化微信，且必须支持存储核查");
      const now = () => deps.now?.() ?? Date.now();
      if (event.operation === "resetAllPreview") {
        const preview = await deps.transact(async doc => {
        attach(doc); requireRole(doc.state, ["admin"]);
        return { epoch: doc.epoch, version: doc.version, members: doc.state.members.length, applications: doc.state.applications.length, semesters: doc.state.semesters.length, classes: doc.state.classes.length, courses: doc.state.courses.length, records: doc.state.records.length, files: doc.files.length, resetId: doc.resetAll?.id || "" };
        });
        // Read-only storage probe: fail before offering a destructive action when listing is unavailable.
        const batch = await deps.listResetFiles();
        return { ...preview, storageVerified: true, firstPhotoBatch: batch.length };
      }
      if (event.operation === "resetAllBegin") return deps.transact(async doc => {
        attach(doc); requireRole(doc.state, ["admin"]);
        if (event.confirmation !== "清空全部业务数据" || event.epoch !== doc.epoch || event.version !== doc.version) throw new Error("确认文字不符或数据已变化，请重新预览");
        if (doc.cleaning && !doc.resetAll) throw new Error("请先完成正在进行的试用清理");
        if (!doc.resetAll) { doc.resetAll = { id: deps.uuid(), startedAt: now() }; doc.cleaning = true; doc.version++; }
        return { resetId: doc.resetAll.id };
      });
      const status = await deps.transact(async doc => {
        attach(doc);
        if (typeof event.resetId !== "string" || !event.resetId) throw new Error("重置标识无效");
        if (doc.lastResetId === event.resetId) return { done: true, snapshot: result(doc), waitMs: 0 };
        requireRole(doc.state, ["admin"]);
        if (!doc.cleaning || !doc.resetAll || doc.resetAll.id !== event.resetId) throw new Error("重置任务不存在");
        // Deployed trial execution limit is 3s. Allow old in-flight uploads to finish before sweeping.
        return { done: false, waitMs: Math.max(0, 10000 - (now() - doc.resetAll.startedAt)) };
      });
      if (status.done || status.waitMs) return status;
      const files = await deps.listResetFiles();
      if (files.length) { await deps.deleteFiles(files); return { done: false, waitMs: 0 }; }
      return deps.transact(async doc => {
        attach(doc);
        if (doc.lastResetId === event.resetId) return { done: true, snapshot: result(doc), waitMs: 0 };
        requireRole(doc.state, ["admin"]);
        if (!doc.cleaning || !doc.resetAll || doc.resetAll.id !== event.resetId) throw new Error("重置状态变化");
        doc.state = emptyWorkspace(); doc.files = []; doc.receipts = [];
        doc.epoch = deps.uuid(); doc.version++; doc.cleaning = false;
        doc.lastResetId = doc.resetAll.id; delete doc.resetAll;
        return { done: true, snapshot: result(doc), waitMs: 0 };
      });
    }
    // Deployment-only trial setup, restricted to the explicitly allowed first admin.
    // This cannot edit existing classes, register a member, or run after admin creation.
    if (event.operation === "bootstrapClass") {
      if (deps.stage !== "trial" || !deps.bootstrapOpenid || openid !== deps.bootstrapOpenid) throw new Error("无权初始化班级");
      return deps.transact(async doc => {
        attach(doc); checkEpoch(doc);
        if (doc.state.members.some(m => m.role === "admin")) throw new Error("管理员已创建，请使用管理工作台");
        const c = event.schoolClass;
        if (!c || typeof c.grade !== "string" || !/^\d{2}$/.test(c.grade) ||
          !doc.state.semesters.find(s => s.id === doc.state.activeSemesterId)?.grades.includes(c.grade) ||
          typeof c.major !== "string" || !c.major.trim() || c.major.length > 60 ||
          typeof c.name !== "string" || !c.name.trim() || c.name.length > 60) throw new Error("班级资料无效，请核对当前学期年级与班级名称");
        const major = c.major.trim(), name = c.name.trim();
        const existing = doc.state.classes.find(x => x.grade === c.grade && x.name === name);
        if (existing) {
          if (existing.major !== major) throw new Error("同名班级专业不一致，请人工核对");
          return { classId: existing.id, created: false };
        }
        if (doc.state.classes.length >= 100) throw new Error("初始化班级数量已达上限");
        const classId = "class-" + deps.uuid();
        doc.state.classes.push({ id: classId, grade: c.grade, major, name });
        doc.state.audit.push({ at: new Date().toISOString(), actor: "server-bootstrap", action: "初始化班级", detail: c.grade + "级 / " + major + " / " + name });
        doc.version++;
        return { classId, created: true };
      });
    }
    if (event.operation === "snapshot") return deps.transact(async doc => { attach(doc); if (doc.cleaning && membershipFor(doc.state, openid)?.role !== "admin") throw new Error("试用数据正在清理"); return result(doc); });
    if (event.operation === "command") return deps.transact(async doc => {
      attach(doc); checkEpoch(doc);
      const id = event.requestId;
      if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(id)) throw new Error("请求标识无效");
      const receipt = openid + ":" + id;
      if (doc.receipts.includes(receipt)) return result(doc);
      if (JSON.stringify(event.command).length > 150000) throw new Error("单次数据过大，请分批处理");
      const command = event.command as Command;
      if (command.type === "join" && openid === deps.bootstrapOpenid && !doc.state.members.some(m => m.role === "admin")) {
        const a = applyForMembership(doc.state, openid, command.form);
        const member = { id: "admin-initial", identityKey: openid, classId: a.classId, name: a.name, studentNo: a.studentNo, role: "admin" as const, active: true };
        doc.state.members.push(member);
        a.memberId = member.id; a.status = "approved"; a.reviewedBy = "server-bootstrap"; a.reviewedAt = new Date().toISOString();
      } else {
        if (command.type === "submit") {
          const r = command.record;
          if (!Array.isArray(r.photos) || r.photos.length < 1 || r.photos.length > 3 || new Set(r.photos).size !== r.photos.length) throw new Error("请提供 1–3 张不同的签字照片");
          if (r.photos.some(id => !doc.files.some(f => f.id === id && f.owner === openid && f.task === r.taskId))) throw new Error("照片不属于此微信身份及任务");
          r.id = "r-" + r.taskId;
        }
        executeCommand(doc.state, command, openid);
      }
      doc.version++;
      doc.receipts = doc.receipts.concat(receipt).slice(-500);
      // 单文档事务用于小规模试用；到达阈值停止写入，不能默默丢弃历史。
      if (encodeURIComponent(JSON.stringify(doc)).replace(/%[0-9A-F]{2}/g, "_").length > 650000) throw new Error("试用数据已接近容量上限，请联系管理员拆分存储后继续");
      return result(doc);
    });
    if (event.operation === "photo") {
      if (typeof event.base64 !== "string" || event.base64.length > 700000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.base64)) throw new Error("照片过大，请压缩至 500KB 内");
      const extension = event.base64.startsWith("/9j/") ? "jpg" : event.base64.startsWith("iVBORw0KGgo") ? "png" : "";
      if (!extension) throw new Error("仅支持 JPEG 或 PNG 签字照片");
      const validate = (doc: Document) => {
        attach(doc); checkEpoch(doc); requireRole(doc.state, ["member", "leader", "admin"]);
        if (!doc.state.plans.some(p => p.status === "confirmed" && p.tasks.some(t => t.id === event.taskId && t.memberId === doc.state.actorId)) || doc.state.records.some(r => r.taskId === event.taskId)) throw new Error("当前任务不可上传照片");
        if (doc.files.filter(f => f.task === event.taskId && f.owner === openid).length >= 12) throw new Error("本任务上传次数已达上限，请联系管理员");
      };
      await deps.transact(async doc => validate(doc));
      const file = await deps.upload(deps.stage + "/" + event.epoch + "/" + deps.uuid() + "." + extension, event.base64);
      try {
        await deps.transact(async doc => { validate(doc); doc.files.push({ id: file, owner: openid, task: event.taskId }); doc.version++; });
      } catch (e) { await deps.deleteFiles([file]); throw e; }
      return { fileID: file };
    }
    if (event.operation === "photoUrls") {
      const ids = await deps.transact(async doc => {
        attach(doc); checkEpoch(doc); requireRole(doc.state, ["member", "leader", "admin"]);
        const user = membershipFor(doc.state, openid)!;
        const record = doc.state.records.find(r => r.id === event.recordId);
        if (!record || (user.role === "member" && record.memberId !== user.id)) throw new Error("无权查看此记录照片");
        return record.photos;
      });
      return { urls: await deps.urls(ids) };
    }
    if (event.operation === "cleanupPreview") return deps.transact(async doc => {
      attach(doc); requireRole(doc.state, ["admin"]);
      if (deps.stage !== "trial") throw new Error("正式环境禁止试用清理");
      return { epoch: doc.epoch, version: doc.version, members: doc.state.members.filter(m => m.role !== "admin").length, applications: doc.state.applications.length, records: doc.state.records.length, files: doc.files.length };
    });
    if (event.operation === "cleanup") {
      if (deps.stage !== "trial" || event.confirmation !== "清空试用数据") throw new Error("仅允许明确确认后清理试用数据");
      const ids = await deps.transact(async doc => {
        attach(doc); requireRole(doc.state, ["admin"]);
        if (doc.resetAll) throw new Error("正在彻底重置，不能切换为普通试用清理");
        if (event.epoch !== doc.epoch || event.version !== doc.version) throw new Error("数据已变化，请重新查看清理范围");
        doc.cleaning = true;
        return doc.files.map(f => f.id);
      });
      // 先冻结试用写入再逐批删除照片；失败保留清单，管理员可再次预览后重试。
      await deps.deleteFiles(ids);
      return deps.transact(async doc => {
        attach(doc); requireRole(doc.state, ["admin"]);
        if (!doc.cleaning || doc.epoch !== event.epoch) throw new Error("清理状态变化");
        doc.state = clearTrialPeople(doc.state); doc.files = []; doc.receipts = [];
        doc.epoch = deps.uuid(); doc.version++; doc.cleaning = false;
        return result(doc);
      });
    }
    throw new Error("不支持此操作");
  };
}
