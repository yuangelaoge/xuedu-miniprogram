import { createHmac, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { ApiRequest, ApiResponse, Commit } from "../../miniprogram/domain/v2/protocol";
import { BusinessError, createGatewayV2 } from "./gateway";
import { MemoryRepository } from "./memory";
import { Repository } from "./repository";
import { makeReviewSeed, ReviewRole, ReviewSnapshot, REVIEW_ROLES, reviewIdentity } from "./review-seed";

// The independently bundled review gateway has its own trusted error constructor.
export { BusinessError };

export interface ReviewSession { snapshot: ReviewSnapshot; version: number; role: ReviewRole; expiresAt: string; }
export interface ReviewStore {
  login(digest: string, valid: boolean, seed: ReviewSnapshot, expiresAt: string): Promise<boolean>;
  read(digest: string): Promise<ReviewSession | null>;
  save(digest: string, expectedVersion: number, snapshot: ReviewSnapshot): Promise<number>;
  role(digest: string, expectedVersion: number, role: ReviewRole): Promise<number>;
  logout(digest: string): Promise<void>;
}
export interface ReviewDependencies {
  appid: string; passwordHash: string; sessionKey: string; enabled: boolean; accessUntil: string;
  store: ReviewStore; maxExecutionMs: number; now?(): number; uuid?(): string;
}
export interface ReviewRequest extends ApiRequest { review?: boolean; }
const fail = (code: string, message: string): never => { throw new BusinessError(code, message); };
const text = (v: unknown) => typeof v === "string" ? v : "";

/** The only account credential is a scrypt digest supplied by the function configuration. */
export function verifyReviewPassword(password: unknown, encoded: string): boolean {
  const parts = encoded.split("$");
  if (typeof password !== "string" || password.length < 1 || password.length > 128 || parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n,r,p] = parts.slice(1,4).map(Number);
  if (n !== 16384 || r !== 8 || p !== 1 || !/^[A-Za-z0-9_-]{22}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[5])) return false;
  const salt = Buffer.from(parts[4], "base64url"), expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== 16 || expected.length !== 32) return false;
  const actual = scryptSync(password, salt, 32, { N:n, r, p, maxmem:32*1024*1024 });
  return timingSafeEqual(actual, expected);
}
function response(session: ReviewSession, data: Record<string, unknown>): ApiResponse {
  return { protocolVersion: 2, epoch: session.snapshot.workspace.epoch, resourceVersions: {workspace:session.snapshot.workspace.version}, data };
}

export function createReviewGateway(deps: ReviewDependencies) {
  return async (input: ReviewRequest, context: { OPENID?: string; APPID?: string }): Promise<ApiResponse> => {
    if (!context.OPENID || context.APPID !== deps.appid) throw new BusinessError("UNAUTHENTICATED", "微信身份无效");
    if (!input || input.protocolVersion !== 2) fail("UPGRADE_REQUIRED", "请更新小程序");
    if (!deps.enabled || !/^([a-f0-9]{64})$/i.test(deps.sessionKey) || !Number.isFinite(Date.parse(deps.accessUntil)) || !/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(deps.passwordHash)) fail("CONFIGURATION", "审核体验尚未启用");
    const now = deps.now?.() ?? Date.now(), until = Date.parse(deps.accessUntil);
    if (now >= until) fail("REVIEW_EXPIRED", "审核体验已到期");
    if (JSON.stringify(input).length > 1200000) fail("INVALID_REQUEST", "请求过大");
    const digest = createHmac("sha256", Buffer.from(deps.sessionKey, "hex")).update(context.OPENID).digest("hex");
    if (input.operation === "reviewLogin") {
      const valid = input.payload?.username === "审核老师辛苦了" && verifyReviewPassword(input.payload?.password, deps.passwordHash);
      const seed = makeReviewSeed(digest, deps.uuid?.() || randomUUID(), now, deps.maxExecutionMs);
      const expiresAt = new Date(Math.min(until, now + 60 * 60000)).toISOString();
      if (!await deps.store.login(digest, valid, seed, expiresAt)) fail("REVIEW_LOGIN_FAILED", "账号或密码无效，或暂时无法登录");
      return response({snapshot:seed,version:1,role:"admin",expiresAt}, {role:"admin",expiresAt});
    }
    const session = await deps.store.read(digest);
    if (!session || Date.parse(session.expiresAt) <= now || session.snapshot.workspace.id !== "review" || !session.snapshot.workspace.epoch.startsWith("review-")) throw new BusinessError("REVIEW_EXPIRED", "审核体验已到期，请重新登录");
    if (input.operation === "reviewStatus") return response(session, {role:session.role,expiresAt:session.expiresAt});
    if (input.operation === "reviewLogout") { await deps.store.logout(digest); return response(session, {ended:true}); }
    if (input.operation === "reviewRole") {
      const role = input.payload?.role;
      if (!REVIEW_ROLES.includes(role as ReviewRole)) fail("INVALID_REQUEST", "体验角色无效");
      await deps.store.role(digest, session.version, role as ReviewRole);
      return response(session, {role,expiresAt:session.expiresAt});
    }
    if (input.review !== true || !["bootstrap","query","command","photo","photoUrls"].includes(input.operation)) fail("FORBIDDEN", "审核会话无权执行此操作");
    const memory = new MemoryRepository(session.snapshot.workspace, session.snapshot.rows, deps.now);
    let stateVersion = session.version;
    const repository: Repository = {
      workspace: () => memory.workspace(), get: (r,id) => memory.get(r,id), query: (r,q) => memory.query(r,q), count: (r,q) => memory.count(r,q),
      commit: async (command: Commit) => {
        const result = await memory.commit(command);
        stateVersion = await deps.store.save(digest, stateVersion, memory.snapshot());
        return result;
      },
    };
    const gateway = createGatewayV2({ repository, appid:deps.appid, bootstrapOpenid:"", maxExecutionMs:deps.maxExecutionMs,
      uuid: deps.uuid || randomUUID, now:deps.now,
      // Selected photos are replaced by a built-in review illustration. Original bytes never leave this handler.
      photos: { async upload(path) { return `review:${path}`; }, async urls(ids) { return ids.map(() => "/assets/review-signature.png"); }, async list() { return []; }, async delete() {} },
    });
    const routed = { ...input, payload: input.operation === "photo" ? { ...input.payload, base64: text(input.payload?.base64) } : input.payload };
    return gateway(routed, {OPENID:reviewIdentity(digest, session.role),APPID:deps.appid});
  };
}

/** Existing CloudBase PG RPC adapter, with no access to production V2 resource RPCs. */
export class PostgresReviewStore implements ReviewStore {
  constructor(private readonly db: {rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:unknown}>}) {}
  private async rpc<T>(name:string,args:Record<string,unknown>):Promise<T> {
    const result = await this.db.rpc(name,args);
    if (result.error) {
      const message = String((result.error as {message?:string}).message || "");
      throw new Error(message.includes("REVIEW_VERSION_CONFLICT") ? "REVIEW_VERSION_CONFLICT" : "REVIEW_STORE_UNAVAILABLE");
    }
    return result.data as T;
  }
  login(digest:string,valid:boolean,seed:ReviewSnapshot,expiresAt:string) { return this.rpc<boolean>("xuedu_review_login",{p_digest:digest,p_valid:valid,p_snapshot:seed,p_expires_at:expiresAt}); }
  read(digest:string) { return this.rpc<ReviewSession|null>("xuedu_review_read",{p_digest:digest}); }
  save(digest:string,expectedVersion:number,snapshot:ReviewSnapshot) { return this.rpc<number>("xuedu_review_save",{p_digest:digest,p_expected_version:expectedVersion,p_snapshot:snapshot}); }
  role(digest:string,expectedVersion:number,role:ReviewRole) { return this.rpc<number>("xuedu_review_role",{p_digest:digest,p_expected_version:expectedVersion,p_role:role}); }
  logout(digest:string) { return this.rpc<void>("xuedu_review_logout",{p_digest:digest}); }
}
