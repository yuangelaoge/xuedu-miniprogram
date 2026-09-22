import test from "node:test";
import assert from "node:assert/strict";
import { runtime } from "../miniprogram/config/runtime";
import { initialState } from "../server/policy";

test("客户端：环境不匹配阻断、拉取去重、版本及清理轮次防回退，云端禁用本地改身份", async () => {
  const global = globalThis as any;
  const oldWx = global.wx;
  const originalRuntime = { ...runtime };
  let calls = 0;
  const data = { stage: "trial" as const, epoch: "epoch-1", version: 0, identity: "self", state: initialState("trial") };
  runtime.mode = "trial"; runtime.env = "trial-env";
  global.wx = { cloud: { init() {}, async callFunction() { calls++; return { result: { ok: true, data: structuredClone(data) } }; } } };
  try {
    const { acceptSnapshot, syncCloud, currentSnapshot } = await import("../miniprogram/services/cloud");
    const { readState, transact, changeDemoActor, draftPrefix } = await import("../miniprogram/services/store");
    await Promise.all([syncCloud(), syncCloud()]);
    assert.equal(calls, 1);
    assert.equal(readState().members.length, 0, "云端不回退本地假成员");
    assert.throws(() => transact(() => {}), /不允许本地修改/);
    assert.throws(() => changeDemoActor("m7"), /不允许本地修改/);
    acceptSnapshot({ ...data, version: 9 });
    acceptSnapshot({ ...data, version: 2 });
    assert.equal(currentSnapshot().version, 9);
    const before = draftPrefix();
    acceptSnapshot({ ...data, epoch: "epoch-2", version: 10 });
    assert.notEqual(draftPrefix(), before);
    acceptSnapshot({ ...data, version: 15 });
    assert.equal(currentSnapshot().epoch, "epoch-2", "旧轮次的迟到响应不能复活试用数据");
    assert.throws(() => acceptSnapshot({ ...data, stage: "production" }), /环境与版本不符/);
    assert.equal(currentSnapshot().stage, "trial");
  } finally { Object.assign(runtime, originalRuntime); global.wx = oldWx; }
});
