import test from "node:test";
import assert from "node:assert/strict";
import { createSeed } from "../miniprogram/domain/seed";

test("页面流程：申请→驳回→重申→批量通过→进入→删除→门禁；旧数据迁移", async () => {
  const runtime = globalThis as any;
  const originalWx = runtime.wx, originalPage = runtime.Page;
  const storage = new Map<string, any>();
  const seed = createSeed();
  delete (seed as any).applications;
  storage.set("xuedu.demo.v1", seed);
  let registered: any, route = "", modal = { confirm: true, content: "请核对资料" };
  const clone = (v: any) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  runtime.Page = (options: any) => { registered = options; };
  runtime.wx = {
    getStorageSync: (key: string) => clone(storage.get(key)),
    setStorageSync: (key: string, value: any) => storage.set(key, clone(value)),
    showToast() {},
    reLaunch: (o: any) => { route = o.url; o.complete?.(); },
    navigateTo: (o: any) => { route = o.url; },
    showModal: (o: any) => o.success?.(modal),
    showActionSheet: (o: any) => o.success?.({ tapIndex: 0 }),
  };
  const instance = (options: any) => ({ ...options, data: clone(options.data),
    setData(value: any) { for (const [key, v] of Object.entries(value)) {
      const parts = key.split("."); let at = this.data;
      for (const p of parts.slice(0, -1)) at = at[p]; at[parts.at(-1)!] = clone(v);
    } },
  });
  const event = (dataset: any = {}, value = "") => ({ currentTarget: { dataset }, detail: { value } });
  try {
    const { readState, changeDemoActor, transact } = await import("../miniprogram/services/store");
    const { startJoinDemo } = await import("../miniprogram/services/join");
    assert.deepEqual(readState().applications, []);
    await import("../miniprogram/pages/join/join");
    const joinOptions = registered;
    await import("../miniprogram/pages/manage/manage");
    const manageOptions = registered;
    await import("../miniprogram/pages/courses/courses");
    const coursesOptions = registered;
    await import("../miniprogram/pages/demo/demo");
    const demo = instance(registered);
    const switchToManager = () => {
      join.openDemo(); assert.equal(route, "/pages/demo/demo");
      demo.onShow();
      const index = demo.data.members.findIndex((m: any) => m.id === "m6");
      demo.switchActor(event({}, String(index)));
      assert.equal(route, "/pages/manage/manage?tab=members");
    };
    startJoinDemo(); assert.equal(route, "/pages/join/join");
    const join = instance(joinOptions); join.onLoad(); join.onShow();
    join.input(event({ key: "name" }, "本地申请者"));
    join.input(event({ key: "studentNo" }, "20265555"));
    join.chooseClass(event({}, "0")); join.submit();
    assert.equal(join.data.status, "pending");
    assert.equal(readState().members.length, 8);
    const coursePage = instance(coursesOptions); route = ""; coursePage.onLoad({}); coursePage.onShow();
    assert.equal(route, "/pages/join/join"); assert.equal(coursePage.data.courses.length, 0);
    switchToManager();
    const manage = instance(manageOptions); manage.onLoad({ tab: "members" }); manage.onShow();
    assert.equal(manage.data.pendingCount, 1);
    manage.review(event({ id: manage.data.pending[0].id, decision: "rejected" }));
    assert.equal(readState().applications[0].status, "rejected");
    startJoinDemo(); join.refresh(); assert.equal(join.data.reason, "请核对资料");
    join.submit(); assert.equal(join.data.status, "pending");
    switchToManager(); manage.refresh(); manage.selectAll();
    manage.review(event({ decision: "approved" }));
    assert.equal(manage.data.pendingCount, 0);
    const member = readState().members.find(m => m.name === "本地申请者")!;
    assert.equal(member.role, "member");
    startJoinDemo(); join.refresh(); assert.equal(route, "/pages/index/index");
    assert.equal(readState().actorId, member.id);
    // 普通成员即使直接打开管理页也拿不到申请、成员及审计列表。
    const denied = instance(manageOptions); denied.onLoad({}); denied.onShow();
    assert.equal(denied.data.manager, false); assert.equal(denied.data.members.length, 0);
    changeDemoActor("m6"); manage.refresh();
    modal = { confirm: false, content: "" }; manage.removeMember(event({ id: member.id }));
    assert.equal(readState().members.find(m => m.id === member.id)!.active, true);
    modal = { confirm: true, content: "" }; manage.removeMember(event({ id: member.id }));
    assert.equal(readState().members.find(m => m.id === member.id)!.active, false);
    assert.ok(!manage.data.members.some((m: any) => m.id === member.id));
    startJoinDemo(); join.refresh(); assert.equal(join.data.status, "removed");
    // 已打开的业务页面再次显示时也检查资格，不只在 onLoad 检查。
    transact(s => { s.actorId = member.id; }); route = ""; coursePage.onShow();
    assert.equal(route, "/pages/join/join");
  } finally { runtime.wx = originalWx; runtime.Page = originalPage; }
});
