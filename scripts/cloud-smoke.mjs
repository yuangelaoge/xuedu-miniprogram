// Official WeChat simulator probe. Does not switch runtime mode or submit user data.
// A first snapshot may initialize the empty trial workspace with sample courses.
import automator from "miniprogram-automator";
import assert from "node:assert/strict";

const env = "xuedu-trial-d2gs2dpnla9206eb3";
const mini = process.argv.includes("--connect") ? await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" }) : await automator.launch({
  cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
  projectPath: process.cwd(),
  timeout: 30000,
});
try {
  const status = await mini.evaluate(function (environment) {
    wx.cloud.init({ env: environment, traceUser: false });
    return wx.cloud.callFunction({ name: "xueduTrial", config: { env: environment }, data: { operation: "deploymentStatus" } })
      .then(function (response) { return response.result; });
  }, env);
  console.log("Deployment status:", JSON.stringify(status));
  const result = await mini.evaluate(function (environment) {
    wx.cloud.init({ env: environment, traceUser: false });
    const timings = [];
    function call(operation) {
      const start = Date.now();
      return wx.cloud.callFunction({
        name: "xueduTrial", config: { env: environment }, data: { operation },
      }).then(function (response) {
        timings.push({ operation, milliseconds: Date.now() - start });
        if (!response.result?.ok) throw new Error(response.result?.error || "云函数返回异常");
        return response.result.data;
      });
    }
    return call("identity").then(function (identity) {
      return call("snapshot").then(function (snapshot) {
        // Never return OpenID, personal records, or credentials in probe output.
        return {
          identityVerified: typeof identity.openid === "string" && identity.openid.length > 0,
          stage: snapshot.stage,
          version: snapshot.version,
          epochPresent: typeof snapshot.epoch === "string" && snapshot.epoch.length > 0,
          statePresent: !!snapshot.state && Array.isArray(snapshot.state.members),
          timings,
        };
      }).catch(function (error) {
        throw new Error("微信身份已验证；数据库快照失败：" + error.message);
      });
    });
  }, env);
  assert.equal(result.identityVerified, true);
  assert.equal(result.stage, "trial");
  assert.equal(result.epochPresent, true);
  assert.equal(result.statePresent, true);
  console.log(JSON.stringify(result, null, 2));
  console.log("PASS 微信身份与试用数据库快照；不代表照片、管理员或多机验收完成。");
} catch (error) {
  console.error("Cloud probe failed:", error.message);
  process.exitCode = 1;
} finally {
  mini.disconnect();
}
