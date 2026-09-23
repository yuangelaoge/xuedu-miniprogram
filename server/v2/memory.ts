import { Commit, Entity, PageResult, Query, Resource, RESOURCES, Workspace } from "../../miniprogram/domain/v2/protocol";
import { validateAutoJoin } from "./auto-approval";
import { Repository } from "./repository";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const EMPTY_WORKSPACE: Workspace = { id: "main", epoch: "initial", version: 0, permissionsVersion: 0, protocolVersion: 2, activeSemesterId: "", maintenance: "", maxExecutionMs: 0 };
const fail = (code: string): never => { throw new Error(code); };
const token = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 256;
export function validateQuery(q: Query): number {
  const limit = q.limit === undefined ? 50 : q.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("INVALID_QUERY");
  const keys = ["status", "id", "epoch", "semesterId", "week", "memberId", "taskId", "recordId", "parentId", "identityKey", "studentNo", "date", "sortKey"];
  for (const key of [...Object.keys(q.eq || {}), ...Object.keys(q.in || {})]) if (!keys.includes(key)) fail("INVALID_QUERY");
  for (const list of Object.values(q.in || {})) if (!Array.isArray(list) || list.length > 100) fail("INVALID_QUERY");
  return limit;
}
export function validateCommit(c: Commit) {
  if (!token(c.epoch) || !token(c.identityKey) || !token(c.requestId) || !Array.isArray(c.changes) || c.changes.length > 1000 || !Array.isArray(c.reads) || c.reads.length > 5000 || JSON.stringify(c).length > 2000000) fail("INVALID_COMMIT");
  const seen = new Set<string>();
  for (const ch of c.changes) {
    if (!RESOURCES.includes(ch.resource) || (ch.resource === "requests" && (!c.maintenanceId || ch.value !== null)) || !(ch.resource === "requests" ? typeof ch.id === "string" && ch.id.length <= 1024 : token(ch.id)) || !Number.isSafeInteger(ch.expectedVersion) || ch.expectedVersion < 0 || seen.has(ch.resource + ":" + ch.id)) fail("INVALID_CHANGE");
    seen.add(ch.resource + ":" + ch.id);
    if (ch.resource === "members" && ch.value && (typeof ch.value.data.active !== "boolean" || !["admin", "leader", "member"].includes(String(ch.value.data.role)))) fail("INVALID_ENTITY");
    if (ch.value && (ch.value.id !== ch.id || !token(ch.value.epoch) || JSON.stringify(ch.value.data).length > 131072 || ch.value.data === null || Array.isArray(ch.value.data))) fail("INVALID_ENTITY");
  }
}
/** Transactional test repository. No await inside mutation: each commit is atomic. */
export class MemoryRepository implements Repository {
  private state: Workspace;
  private rows = new Map<Resource, Map<string, Entity>>();
  constructor(workspace: Workspace = EMPTY_WORKSPACE, seed: Partial<Record<Resource, Entity[]>> = {}, private readonly now: () => number = Date.now) {
    this.state = clone(workspace);
    for (const resource of RESOURCES) this.rows.set(resource, new Map((seed[resource] || []).map(e => [e.id, clone(e)])));
  }
  async workspace() { return clone(this.state); }
  async get(resource: Resource, id: string) { const row = this.rows.get(resource)?.get(id); return row ? clone(row) : undefined; }
  async query(resource: Resource, q: Query): Promise<PageResult> {
    if (!RESOURCES.includes(resource)) fail("INVALID_RESOURCE");
    const limit = validateQuery(q);
    const values = this.matching(resource, q).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { items: clone(values.slice(0, limit)), cursor: values.length > limit ? values[limit - 1].id : "" };
  }
  private matching(resource: Resource, q: Query) {
    if (!RESOURCES.includes(resource)) fail("INVALID_RESOURCE");
    return [...this.rows.get(resource)!.values()].filter(row => {
      const obj = { ...row, status: row.data.status } as unknown as Record<string, unknown>;
      return (!q.after || row.id > q.after) && (!q.dateFrom || !!row.date && row.date >= q.dateFrom) && (!q.dateTo || !!row.date && row.date <= q.dateTo) &&
        Object.entries(q.eq || {}).every(([k, v]) => obj[k] === v) && Object.entries(q.in || {}).every(([k, v]) => v!.includes(obj[k] as never));
    });
  }
  async count(resource: Resource, query: Query) { validateQuery(query); return this.matching(resource, query).length; }
  async commit(c: Commit): Promise<Record<string, unknown>> {
    validateCommit(c);
    const requestKey = JSON.stringify([c.epoch, c.identityKey, c.requestId]);
    const w = this.state;
    if (c.epoch !== w.epoch) fail("EPOCH_CHANGED");
    const receipt = [...this.rows.get("requests")!.values()].find(r => r.epoch === c.epoch && r.identityKey === c.identityKey && r.parentId === c.requestId);
    if (receipt) {
      if (receipt.data.permissionsVersion !== w.permissionsVersion) fail("IDENTITY_CHANGED");
      const originalActor = String(receipt.data.actorId || "");
      if (originalActor && (this.rows.get("members")!.get(originalActor)?.data.active !== true || ![...this.rows.get("bindings")!.values()].some(b => b.epoch === w.epoch && b.memberId === originalActor && b.identityKey === c.identityKey))) fail("IDENTITY_CHANGED");
      return clone(receipt.data.result as Record<string, unknown>);
    }
    if (c.workspaceVersion !== w.version || c.permissionsVersion !== w.permissionsVersion) fail("VERSION_CONFLICT");
    if (w.maintenance && c.maintenanceId !== w.maintenance) fail("MAINTENANCE");
    if (c.maintenanceId && w.maintenance !== c.maintenanceId) fail("MAINTENANCE_CHANGED");
    const members = this.rows.get("members")!;
    if (c.initialize) { if (members.size || w.version !== 0) fail("ALREADY_INITIALIZED"); }
    else if (c.autoJoin) { validateAutoJoin(c, w, this.now(), (r, id) => this.rows.get(r)!.get(id), [...this.rows.get("bindings")!.values()].some(b => b.identityKey === c.identityKey)); }
    else if (c.actorId) {
      const actor = members.get(c.actorId);
      const bound = [...this.rows.get("bindings")!.values()].some(b => b.epoch === w.epoch && b.identityKey === c.identityKey && b.memberId === c.actorId);
      if (!actor || actor.epoch !== w.epoch || actor.data.active !== true || !bound) fail("IDENTITY_CHANGED");
    } else {
      if (c.workspace || c.changes.some(ch => !["applications", "rebindings"].includes(ch.resource) || !ch.value || ch.value.identityKey !== c.identityKey || (this.rows.get(ch.resource)!.get(ch.id)?.identityKey || c.identityKey) !== c.identityKey)) fail("FORBIDDEN");
    }
    if (c.workspace && "autoApproval" in c.workspace) {
      if (members.get(c.actorId)?.data.role !== "admin") fail("FORBIDDEN");
      const setting = c.workspace.autoApproval;
      if (setting && (typeof setting.enabled !== "boolean" || setting.updatedBy !== c.actorId || setting.enabled && !(Date.parse(setting.expiresAt) > this.now()))) fail("INVALID_CHANGE");
    }
    for (const read of c.reads) if ((this.rows.get(read.resource)?.get(read.id)?.version || 0) !== read.version) fail("VERSION_CONFLICT");
    const next = new Map<Resource, Map<string, Entity>>();
    for (const [r, map] of this.rows) next.set(r, new Map(map));
    for (const ch of c.changes) {
      const map = next.get(ch.resource)!;
      if ((map.get(ch.id)?.version || 0) !== ch.expectedVersion) fail("VERSION_CONFLICT");
      if (ch.value) {
        if (ch.value.epoch !== (c.workspace?.epoch || w.epoch)) fail("INVALID_EPOCH");
        map.set(ch.id, clone({ ...ch.value, version: ch.expectedVersion + 1 }));
      } else map.delete(ch.id);
    }
    const updated = [...next.get("members")!.values()];
    if (!updated.some(m => m.data.role === "admin" && m.data.active === true)) fail("LAST_ADMIN");
    for (const [r, key] of [["members", "studentNo"], ["bindings", "identityKey"], ["bindings", "memberId"], ["records", "taskId"]] as const) {
      const seen = new Set<string>();
      for (const row of next.get(r)!.values()) if (row[key]) { if (seen.has(row[key]!)) fail("UNIQUE_CONFLICT"); seen.add(row[key]!); }
    }
    for (const [resource, keys] of [["semester_classes", ["semesterId", "parentId"]], ["availability", ["semesterId", "week", "memberId"]], ["applications", ["identityKey"]]] as [Resource, (keyof Entity)[]][]) {
      const seen = new Set<string>();
      for (const row of next.get(resource)!.values()) {
        if (keys.some(key => row[key] === undefined || row[key] === null)) continue;
        const key = JSON.stringify(keys.map(key => row[key]));
        if (seen.has(key)) fail("UNIQUE_CONFLICT"); seen.add(key);
      }
    }
    for (const b of next.get("bindings")!.values()) if (!next.get("members")!.has(b.memberId || "")) fail("INVALID_BINDING");
    if (updated.some(m => m.data.role === "admin" && !next.get("classes")!.has(String(m.data.classId || "")))) fail("INVALID_ADMIN_CLASS");
    if (c.initialize && ![...next.get("bindings")!.values()].some(b => b.memberId === c.actorId && b.identityKey === c.identityKey && next.get("members")!.get(c.actorId)?.data.role === "admin" && next.get("members")!.get(c.actorId)?.data.active === true)) fail("INVALID_BINDING");
    const permissionsChanged = c.changes.some(ch => ch.resource === "members" || ch.resource === "bindings");
    if (c.autoJoin && !(Date.parse(w.autoApproval!.expiresAt) > this.now())) fail("AUTO_APPROVAL_EXPIRED");
    this.state = { ...w, ...c.workspace, version: w.version + 1, permissionsVersion: w.permissionsVersion + (permissionsChanged ? 1 : 0) };
    this.rows = next;
    this.rows.get("requests")!.set(requestKey, { id: requestKey, epoch: c.epoch, version: 1, identityKey: c.identityKey, parentId: c.requestId, data: { result: clone(c.result), permissionsVersion: this.state.permissionsVersion, actorId: c.actorId } });
    return clone(c.result);
  }
}
