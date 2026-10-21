// Historical function name is retained. Only protocol 2 and PostgreSQL are served.
const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const { createGatewayV2, BusinessError } = require("./generated/v2/gateway.js");
const { PostgresRepository } = require("./generated/v2/postgres.js");
const { createPhotos } = require("./generated/v2/photos.js");
const { createReviewGateway, PostgresReviewStore, BusinessError: ReviewBusinessError } = require("./generated/v2/review.js");
const APPID = "wx5c7d4a458873c686";
const ENVIRONMENT = "xuedu-trial-d2gs2dpnla9206eb3";
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
let gateway, reviewGateway;

function configuration() {
  // PLATFORM_FUNCTION_TIMEOUT_MS is a deployment check value, NOT a platform-injected variable.
  // Deployment maintainers must verify it against the actual function timeout before setting both.
  const expected = process.env.FUNCTION_MAX_EXECUTION_MS || "";
  const checked = process.env.PLATFORM_FUNCTION_TIMEOUT_MS || "";
  const maxExecutionMs = Number(expected);
  const executionConfigured = /^\d+$/.test(expected) && /^\d+$/.test(checked) &&
    Number.isSafeInteger(maxExecutionMs) && maxExecutionMs >= 1000 && maxExecutionMs <= 900000 && maxExecutionMs === Number(checked);
  const key = process.env.CLOUDBASE_API_KEY || process.env.CLOUDBASE_APIKEY;
  const environmentMatches = (process.env.SCF_NAMESPACE || process.env.TCB_ENV) === ENVIRONMENT;
  const backendMatches = !process.env.XUEDU_STORAGE || process.env.XUEDU_STORAGE === "postgresql";
  return { maxExecutionMs, executionConfigured, key, environmentMatches, backendMatches,
    reviewEnabled: process.env.REVIEW_ENABLED === "true", reviewPasswordHash: process.env.REVIEW_PASSWORD_HASH || "",
    reviewSessionKey: process.env.REVIEW_SESSION_KEY || "", reviewAccessUntil: process.env.REVIEW_ACCESS_UNTIL || "" };
}
const knownErrors = {
  SCHEDULING_LIMIT: "本周排班资料超过处理上限，请联系维护人员",
  AUTO_APPROVAL_EXPIRED: "自动通过已到期，请重新提交转入人工审核",
  VERSION_CONFLICT: "数据已被修改，请刷新后重试", EPOCH_CHANGED: "业务数据已变化，请刷新",
  MAINTENANCE: "业务数据正在维护，请稍后再试", MAINTENANCE_CHANGED: "维护任务已变化，请刷新",
  IDENTITY_CHANGED: "成员身份已变化，请重新进入", LAST_ADMIN: "必须保留至少一名有效管理员",
  ALREADY_INITIALIZED: "管理员已建立，请刷新", UNIQUE_CONFLICT: "身份、学号或任务记录已存在，请刷新核对",
  FORBIDDEN: "没有操作权限", INVALID_QUERY: "查询参数无效", INVALID_COMMIT: "提交参数无效",
  INVALID_CHANGE: "修改内容无效", INVALID_ENTITY: "业务资料无效", INVALID_EPOCH: "业务轮次无效，请刷新",
  INVALID_BINDING: "微信绑定无效", INVALID_ADMIN_CLASS: "管理员班级资料缺失，请联系维护人员",
  UPDATE_REQUIRED: "请更新小程序", LEGACY_MAINTENANCE_PENDING: "请先完成旧版本维护任务",
  CUTOVER_REQUIRED: "正在准备数据切换，请稍后再试", DATABASE_UNAVAILABLE: "数据库暂时不可用，请稍后重试",
  REVIEW_STORE_UNAVAILABLE: "审核体验暂时不可用，请稍后再试", REVIEW_VERSION_CONFLICT: "审核样例已变化，请刷新后重试",
};

exports.main = async event => {
  try {
    const context = cloud.getWXContext();
    if (!context.OPENID || context.APPID !== APPID) return { ok: false, code: "UNAUTHENTICATED", error: "微信身份无效" };
    if (!event || event.protocolVersion !== 2) return { ok: false, code: "UPGRADE_REQUIRED", error: "请更新小程序" };
    const config = configuration();
    if (event.operation === "deploymentStatus") {
      let keyRole = "unknown";
      try {
        const role = JSON.parse(Buffer.from((config.key || "").split(".")[1], "base64url").toString()).role;
        if (["service_role", "authenticated", "anon"].includes(role)) keyRole = role;
      } catch (_) { /* Never return key material or token claims. */ }
      return { ok: true, data: { protocolVersion: 2, backend: "postgresql", keyPresent: !!config.key, keyRole,
        bootstrapConfigured: !!process.env.BOOTSTRAP_OPENID,
        bootstrapMatchesCurrentWeChat: !!process.env.BOOTSTRAP_OPENID && process.env.BOOTSTRAP_OPENID === context.OPENID,
        executionConfigured: config.executionConfigured, environmentMatches: config.environmentMatches,
        backendMatches: config.backendMatches,
        keyVariableNames: ["CLOUDBASE_API_KEY", "CLOUDBASE_APIKEY"].filter(name => !!process.env[name]),
      } };
    }
    const reviewOperation = ["reviewLogin", "reviewStatus", "reviewRole", "reviewLogout"].includes(event.operation);
    const allowed = ["bootstrap", "initialize", "query", "command", "photo", "photoFile", "photoUrls", "clearPreview", "clearBegin", "clearStep"];
    if (!allowed.includes(event.operation) && !reviewOperation) return { ok: false, code: "UPGRADE_REQUIRED", error: "请更新小程序" };
    if (!config.executionConfigured || !config.environmentMatches || !config.backendMatches || !config.key)
      return { ok: false, code: "CONFIGURATION", error: "云端配置尚未完成，请联系维护人员核对环境、服务端密钥和实际函数执行上限" };
    if (reviewOperation || event.review === true) {
      if (!reviewGateway) {
        const reviewApp = require("@cloudbase/js-sdk").init({ env: ENVIRONMENT, accessKey: config.key });
        reviewGateway = createReviewGateway({ appid: APPID, enabled: config.reviewEnabled, passwordHash: config.reviewPasswordHash,
          sessionKey: config.reviewSessionKey, accessUntil: config.reviewAccessUntil, maxExecutionMs: config.maxExecutionMs,
          uuid: () => crypto.randomUUID(), store: new PostgresReviewStore(reviewApp.rdb()) });
      }
      return { ok: true, data: await reviewGateway(event, context) };
    }
    if (!gateway) {
      const pgApp = require("@cloudbase/js-sdk").init({ env: ENVIRONMENT, accessKey: config.key });
      gateway = createGatewayV2({
        appid: APPID, bootstrapOpenid: process.env.BOOTSTRAP_OPENID || "",
        uuid: () => crypto.randomUUID(), maxExecutionMs: config.maxExecutionMs,
        repository: new PostgresRepository(pgApp.rdb()),
        photos: createPhotos(pgApp.storage.from("xuedu-photos"), base64 => Buffer.from(base64, "base64")),
      });
    }
    return { ok: true, data: await gateway(event, context) };
  } catch (error) {
    if (error instanceof BusinessError || error instanceof ReviewBusinessError) return { ok: false, code: error.code, error: error.message };
    const message = error && typeof error.message === "string" ? error.message : "";
    if (Object.prototype.hasOwnProperty.call(knownErrors, message)) return { ok: false, code: message, error: knownErrors[message] };
    // SDK, SQL, token and input fragments must never escape through raw Error.message.
    return { ok: false, code: "INTERNAL_ERROR", error: "云端操作失败，请稍后重试" };
  }
};
