import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as gateway from "../server/gateway";

function entry(context: { OPENID?: string; APPID?: string }, bootstrapOpenid = "") {
  const key = "test." + Buffer.from(JSON.stringify({ role: "service_role", private: "do-not-return" })).toString("base64url") + ".signature";
  const exports: { main?: (event: unknown) => Promise<any> } = {};
  const env = { XUEDU_STORAGE: "postgresql", SCF_NAMESPACE: "test-env", CLOUDBASE_APIKEY: key, BOOTSTRAP_OPENID: bootstrapOpenid };
  const app = { storage: { from: () => ({}) }, rdb: () => ({}) };
  runInNewContext(readFileSync(new URL("../cloudfunctions/xueduTrial/index.js", import.meta.url), "utf8"), {
    exports, Buffer, process: { env },
    require(name: string) {
      if (name === "wx-server-sdk") return { init() {}, getWXContext: () => context };
      if (name === "crypto") return { randomUUID: () => "test-uuid" };
      if (name === "./generated/gateway.js") return gateway;
      if (name === "./generated/postgres.js") return {
        postgresTransaction: () => async () => { throw new Error("diagnostics must not read private database"); },
        postgresPhotos: () => ({}),
      };
      if (name === "@cloudbase/js-sdk") return { init: () => app };
      throw new Error("Unexpected module " + name);
    },
  });
  return { call: exports.main!, key };
}

test("云入口配置诊断须可信微信身份，不信任客户端 OPENID", async () => {
  const f = entry({});
  const result = await f.call({ operation: "deploymentStatus", OPENID: "owner", APPID: "wx5c7d4a458873c686" });
  assert.equal(result.ok, false);
  assert.match(result.error, /微信身份/);
});

test("云入口诊断仅返回配置状态，不返回密钥、JWT 内容或 OpenID", async () => {
  const f = entry({ OPENID: "private-wechat-identity", APPID: "wx5c7d4a458873c686" });
  const result = await f.call({ operation: "deploymentStatus" });
  assert.equal(result.ok, true);
  assert.equal(result.data.keyPresent, true);
  assert.equal(result.data.keyRole, "service_role");
  assert.equal(result.data.bootstrapConfigured, false);
  assert.equal(result.data.bootstrapMatchesCurrentWeChat, false);
  const output = JSON.stringify(result);
  assert.ok(!output.includes(f.key));
  assert.doesNotMatch(output, /do-not-return|private-wechat-identity|signature/);
});

test("初始化配置诊断仅比较可信微信，不回传允许名单或接受客户端身份", async () => {
  const f = entry({ OPENID: "owner", APPID: "wx5c7d4a458873c686" }, "owner");
  const result = await f.call({ operation: "deploymentStatus" });
  assert.equal(result.data.bootstrapMatchesCurrentWeChat, true);
  assert.ok(!JSON.stringify(result).includes("owner"));
  const other = entry({ OPENID: "other", APPID: "wx5c7d4a458873c686" }, "owner");
  const denied = await other.call({ operation: "deploymentStatus", OPENID: "owner" });
  assert.equal(denied.data.bootstrapConfigured, true);
  assert.equal(denied.data.bootstrapMatchesCurrentWeChat, false);
});
