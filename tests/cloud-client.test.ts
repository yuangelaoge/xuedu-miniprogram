import test from "node:test";
import assert from "node:assert/strict";
import { runtime } from "../miniprogram/config/runtime";
import { bootstrap, currentBoot, query, viewSemester, selectSemester, draftKey } from "../miniprogram/services/v2/client";

test("V2客户端：协议拒绝、启动去重、本机学期账号隔离、版本和轮次迟到响应不能回退", async () => {
  const g = globalThis as any, oldWx = g.wx, original = { ...runtime };
  runtime.mode = "cloud"; runtime.env = "v2-client-tests";
  let calls = 0, epoch = "e1", version = 1, actor = "a", protocolVersion = 2, release: (() => void) | undefined;
  let delay = false;
  const storage = new Map();
  g.wx = { getStorageSync: (k: string) => storage.get(k), removeStorageSync: (k: string) => storage.delete(k), setStorageSync: (k: string, v: unknown) => storage.set(k, v), cloud: {
    init() {}, async callFunction({ data }: any) {
      calls++; assert.equal(data.protocolVersion, 2);
      const snapshot = { protocolVersion, epoch, resourceVersions: {workspace: version}, data: data.operation === "bootstrap" ? {workspace: {epoch, version, activeSemesterId: "active"},member: {id: actor},status: "ready",...(data.payload?.includeHome ? {home:{semester:null,week:1,weekData:null}} : {})} : {items: []}};
      if (delay && data.operation === "query") { delay = false; await new Promise<void>(r => { release = r; }); }
      return {result: {ok: true, data: snapshot}};
    }
  }};
  try {
    await Promise.all([bootstrap(), bootstrap()]); assert.equal(calls, 1);
    let before = calls;
    const [, home] = await Promise.all([bootstrap(), bootstrap(true)]);
    assert.ok(home.home); assert.equal(calls - before, 2, "普通启动不能冒充首页合并响应");
    before = calls;
    const [first, second] = await Promise.all([bootstrap(true), bootstrap()]);
    assert.ok(first.home); assert.equal(second.home, undefined); assert.equal(calls - before, 2, "首页和普通启动各自读取，避免首页失败连带普通启动");
    assert.equal(viewSemester(), "active"); selectSemester("history"); assert.equal(viewSemester(), "history");
    actor = "b"; await bootstrap(); assert.equal(viewSemester(), "active"); actor = "a"; await bootstrap(); assert.equal(viewSemester(), "history");
    const oldDraft = draftKey("task");
    delay = true; const late = query("records", "s"); await new Promise(r => setImmediate(r));
    epoch = "e2"; version = 2; await bootstrap(); release!(); await assert.rejects(late, /轮次/);
    assert.notEqual(draftKey("task"), oldDraft); assert.equal(currentBoot().workspace.epoch, "e2");
    version = 1; await assert.rejects(bootstrap(), /版本/); version = 3; protocolVersion = 1; await assert.rejects(bootstrap(), /请更新/);
    const { syncCloud } = await import("../miniprogram/services/cloud"); await assert.rejects(syncCloud(), /旧版云端接口已停用/);
    const { transact, changeDemoActor } = await import("../miniprogram/services/store");
    assert.throws(() => transact(() => {}), /不允许本地修改/); assert.throws(() => changeDemoActor("m7"), /不允许本地修改/);
  } finally { g.wx = oldWx; Object.assign(runtime, original); }
});
