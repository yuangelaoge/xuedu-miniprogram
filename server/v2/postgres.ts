import { SchedulingRead } from "./scheduling-read";
import { ApiResponse, Commit, Entity, PageResult, Query, Resource, Workspace } from "../../miniprogram/domain/v2/protocol";
import { PgRpc } from "../postgres";
import { Repository } from "./repository";

const publicErrors = new Set(["SCHEDULING_LIMIT","AUTO_APPROVAL_EXPIRED","VERSION_CONFLICT", "EPOCH_CHANGED", "MAINTENANCE", "MAINTENANCE_CHANGED", "IDENTITY_CHANGED", "LAST_ADMIN", "ALREADY_INITIALIZED", "UNIQUE_CONFLICT", "FORBIDDEN", "INVALID_QUERY", "INVALID_COMMIT", "INVALID_CHANGE", "INVALID_ENTITY", "INVALID_EPOCH", "INVALID_BINDING", "INVALID_ADMIN_CLASS", "UPDATE_REQUIRED", "LEGACY_MAINTENANCE_PENDING", "CUTOVER_REQUIRED"]);
export class PostgresRepository implements Repository {
  private recordRpcAvailable = true;
  async recordRead(identityKey: string, request: Record<string, unknown>): Promise<SchedulingRead | null> {
    if (!this.recordRpcAvailable) return null;
    const result = await this.db.rpc("xuedu_v2_record_read", {p_identity_key: identityKey, p_request: request});
    const error = result.error as {code?: string; message?: string} | null;
    if (error && ["42883", "PGRST202"].includes(error.code || "")) { this.recordRpcAvailable = false; return null; }
    if (error) {
      if (["40001", "40P01", "55P03"].includes(error.code || "")) throw new Error("VERSION_CONFLICT");
      const safe = (error.message || "").match(/[A-Z][A-Z_]+/g)?.find(s => publicErrors.has(s));
      throw new Error(safe || "DATABASE_UNAVAILABLE");
    }
    return result.data as SchedulingRead;
  }
  private schedulingRpcAvailable = true;
  async schedulingRead(identityKey: string, request: Record<string, unknown>): Promise<SchedulingRead | null> {
    if (!this.schedulingRpcAvailable) return null;
    const result = await this.db.rpc("xuedu_v2_scheduling_read", {p_identity_key: identityKey, p_request: request});
    const error = result.error as {code?: string; message?: string} | null;
    if (error && ["42883", "PGRST202"].includes(error.code || "")) { this.schedulingRpcAvailable = false; return null; }
    if (error) {
      if (["40001", "40P01", "55P03"].includes(error.code || "")) throw new Error("VERSION_CONFLICT");
      const safe = (error.message || "").match(/[A-Z][A-Z_]+/g)?.find(s => publicErrors.has(s));
      throw new Error(safe || "DATABASE_UNAVAILABLE");
    }
    return result.data as SchedulingRead;
  }
  private pageRpcAvailable = true;
  constructor(private readonly db: PgRpc) {}
  async bootstrapPage(identityKey: string, request: Record<string, unknown>, canInitialize: boolean): Promise<ApiResponse | null> {
    if (!this.pageRpcAvailable) return null;
    const result = await this.db.rpc("xuedu_v2_bootstrap_page", {p_identity_key:identityKey,p_request:request,p_can_initialize:canInitialize});
    const error = result.error as {code?:string;message?:string} | null;
    // A staged rollout can run on the prior schema. Only a missing function permits fallback.
    if (error && ["42883","PGRST202"].includes(error.code || "")) { this.pageRpcAvailable=false; return null; }
    if (error) {
      if (["40001","40P01","55P03"].includes(error.code || "")) throw new Error("VERSION_CONFLICT");
      const safe=(error.message || "").match(/[A-Z][A-Z_]+/g)?.find(s=>publicErrors.has(s));
      throw new Error(safe || "DATABASE_UNAVAILABLE");
    }
    return result.data as ApiResponse;
  }
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.db.rpc(name, args);
    if (r.error) {
      const e = r.error as { code?: string; message?: string };
      if (e.code === "23505") throw new Error("UNIQUE_CONFLICT");
      if (e.code === "40001" || e.code === "40P01") throw new Error("VERSION_CONFLICT");
      const safe = (e.message || "").match(/[A-Z][A-Z_]+/g)?.find(s => publicErrors.has(s));
      throw new Error(safe || "DATABASE_UNAVAILABLE");
    }
    return r.data as T;
  }
  count(resource: Resource, query: Query) { return this.rpc<number>("xuedu_v2_count", { p_resource: resource, p_query: query }); }
  workspace() { return this.rpc<Workspace>("xuedu_v2_workspace", {}); }
  query(resource: Resource, query: Query) { return this.rpc<PageResult>("xuedu_v2_query", { p_resource: resource, p_query: query }); }
  async get(resource: Resource, id: string) { return (await this.query(resource, { eq: { id }, limit: 1 })).items[0] as Entity | undefined; }
  commit(command: Commit) { return this.rpc<Record<string, unknown>>("xuedu_v2_commit", { p_command: command }); }
}
export function postgresRepository(db: PgRpc): Repository { return new PostgresRepository(db); }
