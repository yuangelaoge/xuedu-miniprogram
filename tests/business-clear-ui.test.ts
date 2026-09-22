import test from "node:test";
import assert from "node:assert/strict";
import { runtime } from "../miniprogram/config/runtime";
import { createGateway, freshDocument } from "../server/gateway";
import { createSeed } from "../miniprogram/domain/seed";
import { BUSINESS_CLEAR_CONFIRMATION } from "../miniprogram/domain/business-clear";

test("管理页清空：取消与错误文字不写入，成功后管理员可设置新学期、其他页面引导配置", async () => {
  // wx/Page are runtime-injected framework objects; mocks match the project's page regression harness.
  const globals = globalThis as any;
  const oldWx = globals.wx, oldPage = globals.Page, oldRuntime = { ...runtime };
  runtime.mode = "trial"; runtime.env = "ui-test-env";
  let doc = freshDocument("trial", "ui-epoch"), sequence = 0, clock = 0;
  doc.state = createSeed();
  doc.state.members.find(m => m.role === "admin")!.identityKey = "owner";
  const gateway = createGateway({ stage: "trial", appid: "test", bootstrapOpenid: "owner",
    uuid: () => "ui-id-" + ++sequence, now: () => clock,
    async transact(fn) { const next = structuredClone(doc); const result = await fn(next); doc = next; return result; },
    async upload() { throw new Error("unexpected upload"); }, async urls() { return []; }, async deleteFiles() {}, async listResetFiles() { return []; },
  });
  const operations: string[] = [], routes: string[] = [];
  let registered: any, modalAnswer = { confirm: false, content: "" }, failStep = false;
  const storage = new Map([
    ["xuedu.form.ui-test-env.trial.old.member.task", "old draft"],
    ["xuedu.form.other-env.trial.old.member.task", "other environment"],
    ["xuedu.form.ui-test-env.production.old.member.task", "production"],
  ]);
  globals.wx = {
    cloud: { init() {}, async callFunction({ data }: any) {
      operations.push(data.operation);
      try {
        if (data.operation === "businessClearStep" && failStep) throw new Error("模拟网络中断");
        const result = await gateway(data, { OPENID: "owner", APPID: "test" });
        if (data.operation === "businessClearBegin") clock += 11000;
        return { result: { ok: true, data: result } };
      } catch (e) { return { result: { ok: false, error: (e as Error).message } }; }
    } },
    async showModal() { return modalAnswer; }, showToast() {},
    getStorageInfoSync() { return { keys: [...storage.keys()] }; }, removeStorageSync(key: string) { storage.delete(key); },
    reLaunch(o: any) { routes.push(o.url); o.complete?.(); },
  };
  globals.Page = (options: any) => { registered = options; };
  try {
    const { syncCloud } = await import("../miniprogram/services/cloud");
    const { ensureMember } = await import("../miniprogram/services/member-page");
    await syncCloud();
    await import("../miniprogram/pages/manage/manage");
    const page = { ...registered, route: "pages/manage/manage", data: structuredClone(registered.data), setData(v: any) { Object.assign(this.data, v); } };
    page.refresh(); assert.equal(page.data.admin, true);
    const version = doc.version;
    await page.clearBusiness();
    assert.equal(doc.version, version); assert.equal(doc.cleaning, undefined);
    assert.equal(operations.includes("businessClearBegin"), false);
    modalAnswer = { confirm: true, content: "清空试用数据" };
    await page.clearBusiness(); assert.equal(operations.includes("businessClearBegin"), false);
    modalAnswer = { confirm: true, content: BUSINESS_CLEAR_CONFIRMATION }; failStep = true;
    await page.clearBusiness(); assert.equal(doc.cleaning, true);
    assert.equal(page.data.clearingBusiness, false); assert.match(page.data.clearProgress, /未完成/);
    const jobId = doc.businessClear!.id;
    failStep = false; await page.clearBusiness();
    assert.equal(doc.lastBusinessClearId, jobId);
    assert.equal(page.data.tab, "semester"); assert.equal(page.data.needsSemester, true);
    assert.equal(page.data.needsAdminClass, true); assert.equal(page.data.admin, true);
    assert.equal(storage.size, 2); assert.equal(page.data.clearingBusiness, false);
    assert.equal(ensureMember("pages/index/index"), false);
    assert.equal(routes.at(-1), "/pages/manage/manage?tab=semester");
    assert.equal(ensureMember("pages/manage/manage"), true);
    page.data.form = { name: "2027–2028 第一学期", startDate: "2027-09-06", weeks: "20", grades: "26,27", days: "5", periods: "14" };
    await page.createSemester();
    assert.equal(page.data.needsSemester, false);
    assert.equal(ensureMember("pages/index/index"), true);
    assert.equal(doc.state.members.filter(m => m.role === "admin").length, 1);
    assert.equal(doc.state.classes.length, 0); assert.equal(doc.state.courses.length, 0);
  } finally { globals.wx = oldWx; globals.Page = oldPage; Object.assign(runtime, oldRuntime); }
});
