import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as gateway from "../server/v2/gateway";
import * as photos from "../server/v2/photos";
import * as review from "../server/v2/review";
import { MemoryRepository } from "../server/v2/memory";

const APPID = "wx5c7d4a458873c686";
function entry(context: { OPENID?: string; APPID?: string }, bootstrapOpenid = "", overrides: Record<string, string> = {}, sdkFailure?: string) {
  const key = "test." + Buffer.from(JSON.stringify({ role: "service_role", private: "do-not-return" })).toString("base64url") + ".signature";
  const exports: { main?: (event: unknown) => Promise<any> } = {};
  const env = { XUEDU_STORAGE: "postgresql", SCF_NAMESPACE: "xuedu-trial-d2gs2dpnla9206eb3", CLOUDBASE_APIKEY: key,
    BOOTSTRAP_OPENID: bootstrapOpenid, FUNCTION_MAX_EXECUTION_MS: "3000", PLATFORM_FUNCTION_TIMEOUT_MS: "3000", ...overrides };
  const repository = new MemoryRepository(); let sdkInitializations = 0, sequence = 0;
  const app = { storage: { from: () => ({}) }, rdb: () => ({}) };
  runInNewContext(readFileSync(new URL("../cloudfunctions/xueduTrial/index.js", import.meta.url), "utf8"), {
    exports, Buffer, process: { env },
    require(name: string) {
      if (name === "wx-server-sdk") return { init() {}, getWXContext: () => context };
      if (name === "crypto") return { randomUUID: () => "test-uuid-" + ++sequence };
      if (name === "./generated/v2/gateway.js") return gateway;
      if (name === "./generated/v2/postgres.js") return { PostgresRepository: class { constructor() { return repository; } } };
      if (name === "./generated/v2/photos.js") return photos;
      if (name === "./generated/v2/review.js") return review;
      if (name === "@cloudbase/js-sdk") return { init(options: any) {
        sdkInitializations++; assert.equal(options.accessKey, key); assert.equal(options.env, env.SCF_NAMESPACE);
        if (sdkFailure) throw new Error(sdkFailure); return app;
      } };
      throw new Error("Unexpected module " + name);
    },
  });
  return { call: exports.main!, key, repository, sdkInitializations: () => sdkInitializations };
}
const event = (operation: string, fields = {}) => ({ protocolVersion: 2, operation, ...fields });

test("V2云入口配置诊断须可信微信身份，不信任客户端OPENID或APPID", async () => {
  for (const context of [{}, { OPENID: "owner", APPID: "wrong" }]) {
    const f = entry(context);
    const result = await f.call(event("deploymentStatus", { OPENID: "owner", APPID }));
    assert.equal(result.ok, false); assert.equal(result.code, "UNAUTHENTICATED");
    assert.equal(f.sdkInitializations(), 0);
  }
});

test("V2云入口诊断只返回允许的状态，不返回密钥、身份、JWT内容或任意变量名", async () => {
  const f = entry({ OPENID: "private-wechat-identity", APPID }, "", { PRIVATE_API_KEY_SECRET: "do-not-return" });
  const result = await f.call(event("deploymentStatus"));
  assert.equal(result.ok, true); assert.equal(result.data.keyPresent, true); assert.equal(result.data.keyRole, "service_role");
  assert.equal(result.data.bootstrapConfigured, false); assert.equal(result.data.executionConfigured, true);
  assert.equal(result.data.environmentMatches, true); assert.equal(result.data.backendMatches, true);
  assert.equal(f.sdkInitializations(), 0);
  assert.doesNotMatch(JSON.stringify(result), /do-not-return|private-wechat-identity|signature|PRIVATE_API_KEY_SECRET/);
  assert.ok(!JSON.stringify(result).includes(f.key));
});

test("V2初始化诊断只比较可信微信，不接受客户端声明", async () => {
  const f = entry({ OPENID: "owner", APPID }, "owner");
  const result = await f.call(event("deploymentStatus"));
  assert.equal(result.data.bootstrapMatchesCurrentWeChat, true); assert.ok(!JSON.stringify(result).includes("owner"));
  const other = entry({ OPENID: "other", APPID }, "owner");
  const denied = await other.call(event("deploymentStatus", { OPENID: "owner" }));
  assert.equal(denied.data.bootstrapConfigured, true); assert.equal(denied.data.bootstrapMatchesCurrentWeChat, false);
});

test("云入口拒绝所有V1调用及V2伪装的旧清理/重置/身份接口，且不初始化SDK", async () => {
  const f = entry({ OPENID: "owner", APPID }, "owner");
  for (const operation of ["snapshot", "identity", "deploymentStatus", "command", "businessClearBegin", "resetAllBegin", "clearTrial", "bootstrapClass"]) {
    const result = await f.call({ operation });
    assert.equal(result.code, "UPGRADE_REQUIRED"); assert.equal(result.error, "请更新小程序");
  }
  for (const operation of ["snapshot", "identity", "resetAllBegin", "resetAllStep", "businessClearBegin", "bootstrapClass"]) {
    assert.equal((await f.call(event(operation))).code, "UPGRADE_REQUIRED");
  }
  assert.equal(f.sdkInitializations(), 0);
});

test("执行上限必须来自服务端两个明确一致配置，客户端传值不能绕过", async () => {
  for (const override of [
    { FUNCTION_MAX_EXECUTION_MS: "" }, { PLATFORM_FUNCTION_TIMEOUT_MS: "" },
    { FUNCTION_MAX_EXECUTION_MS: "3001" }, { FUNCTION_MAX_EXECUTION_MS: "0", PLATFORM_FUNCTION_TIMEOUT_MS: "0" },
    { FUNCTION_MAX_EXECUTION_MS: "3e3" }, { FUNCTION_MAX_EXECUTION_MS: "900001", PLATFORM_FUNCTION_TIMEOUT_MS: "900001" },
  ]) {
    const f = entry({ OPENID: "owner", APPID }, "owner", override);
    const diagnostic = await f.call(event("deploymentStatus"));
    assert.equal(diagnostic.data.executionConfigured, false);
    const denied = await f.call(event("bootstrap", { maxExecutionMs: 3000, PLATFORM_FUNCTION_TIMEOUT_MS: "3000" }));
    assert.equal(denied.code, "CONFIGURATION"); assert.equal(f.sdkInitializations(), 0);
  }
});

test("入口固定现有环境和PG，拒绝缺服务端Key及旧文档数据库配置", async () => {
  for (const override of [{ SCF_NAMESPACE: "other-environment" }, { CLOUDBASE_APIKEY: "" }, { XUEDU_STORAGE: "document" }]) {
    const f = entry({ OPENID: "owner", APPID }, "owner", override);
    const result = await f.call(event("bootstrap"));
    assert.equal(result.code, "CONFIGURATION"); assert.equal(f.sdkInitializations(), 0);
  }
});

test("入口运行V2真实网关初始化、受信任角色和资源查询，不调用旧snapshot", async () => {
  const f = entry({ OPENID: "owner", APPID }, "owner");
  const start = await f.call(event("bootstrap"));
  assert.equal(start.ok, true); assert.equal(start.data.data.status, "needsAdministrator");
  assert.equal(start.data.data.canInitialize, true);
  const result = await f.call(event("initialize", { epoch: start.data.epoch, requestId: "initialize", payload: {
    name: "合成管理员", studentNo: "synthetic-001", schoolClass: { name: "合成班", major: "合成专业", grade: "26" },
    semester: { name: "合成学期", startDate: "2026-09-07", weeks: 18, grades: ["26"], days: 7, periods: 14 },
  } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const workspace = await f.repository.workspace(); assert.equal(workspace.maxExecutionMs, 3000);
  const members = await f.repository.query("members", {}); assert.equal(members.items.length, 1);
  assert.equal(members.items[0].data.role, "admin"); assert.equal(f.sdkInitializations(), 1);
  assert.equal((await f.call(event("bootstrap"))).data.data.status, "ready");
});

test("未知SDK错误只返回固定错误，已知数据库冲突返回安全刷新提示", async () => {
  for (const [error, code] of [["sql private-wechat-identity token-password", "INTERNAL_ERROR"], ["VERSION_CONFLICT", "VERSION_CONFLICT"]]) {
    const f = entry({ OPENID: "owner", APPID }, "owner", {}, error);
    const result = await f.call(event("bootstrap"));
    assert.equal(result.code, code); assert.doesNotMatch(JSON.stringify(result), /private-wechat|password|sql/);
  }
});
