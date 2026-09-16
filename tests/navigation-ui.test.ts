import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createSeed } from "../miniprogram/domain/seed";

const source = (path: string) => readFileSync(new URL("../miniprogram/" + path, import.meta.url), "utf8");
const config = JSON.parse(source("app.json"));

test("精简导航：四个底部入口，课程为二级页，重复入口已移除", () => {
  assert.deepEqual(config.tabBar.list.map((t: any) => t.text), ["首页", "听课安排", "听课记录", "我的"]);
  assert.ok(config.pages.includes("pages/courses/courses"));
  assert.ok(!config.tabBar.list.some((t: any) => t.pagePath === "pages/courses/courses"));
  for (const page of config.pages) {
    for (const ext of ["ts", "json", "wxml"]) {
      assert.ok(existsSync(new URL("../miniprogram/" + page + "." + ext, import.meta.url)), page + "." + ext);
    }
  }
  const home = source("pages/index/index.wxml"), profile = source("pages/profile/profile.wxml");
  assert.equal([...home.matchAll(/bindtap="submit"/g)].length, 1);
  assert.equal([...profile.matchAll(/bindtap="manage"/g)].length, 1);
  assert.doesNotMatch(profile, /bindtap="reports"|bindchange="switchActor"|bindtap="joinDemo"/);
  assert.doesNotMatch(home, /切换身份|bindtap="profile"/);
  assert.match(home, /<block wx:if="\{\{manager\}\}">[\s\S]*本周进度[\s\S]*<\/block>/);
});

test("精简后页面跳转、事件绑定、默认记录视角与统一开发体验可用", async () => {
  const runtime = globalThis as any;
  const oldWx = runtime.wx, oldPage = runtime.Page;
  const storage = new Map<string, any>([["xuedu.demo.v1", createSeed()]]);
  const clone = (v: any) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  let registered: any, route = "";
  const tabs = new Set(config.tabBar.list.map((t: any) => "/" + t.pagePath));
  const navigate = (o: any, method: string) => {
    const path = o.url.split("?")[0];
    assert.ok(config.pages.includes(path.slice(1)), "跳转目标必须注册：" + path);
    if (method === "navigateTo") assert.ok(!tabs.has(path), "二级页不能是 tab");
    if (method === "switchTab") assert.ok(tabs.has(path), "switchTab 只能打开 tab");
    route = o.url;
    o.complete?.();
  };
  runtime.wx = {
    getStorageSync: (k: string) => clone(storage.get(k)),
    setStorageSync: (k: string, v: any) => storage.set(k, clone(v)),
    navigateTo: (o: any) => navigate(o, "navigateTo"),
    switchTab: (o: any) => navigate(o, "switchTab"),
    reLaunch: (o: any) => navigate(o, "reLaunch"),
    showToast() {},
  };
  runtime.Page = (options: any) => { registered = options; };
  const pages: Record<string, any> = {};
  const event = (dataset: any = {}, value = "") => ({ currentTarget: { dataset }, detail: { value } });
  try {
    const { readState, changeDemoActor, transact } = await import("../miniprogram/services/store");
    const { applyForMembership } = await import("../miniprogram/domain/membership");
    for (const page of config.pages) {
      await import("../miniprogram/" + page + ".ts");
      const options = registered;
      const markup = source(page + ".wxml");
      for (const match of markup.matchAll(/(?:bind|catch):?\w+="([\w]+)"/g)) {
        assert.equal(typeof options[match[1]], "function", page + " 缺少处理函数 " + match[1]);
      }
      pages[page.split("/")[1]] = {
        ...options, data: clone(options.data),
        setData(value: any) { Object.assign(this.data, clone(value)); },
      };
    }
    const { index: home, profile, schedule, reports, demo, courses } = pages;
    home.onShow(); assert.equal(home.data.manager, false);
    home.availability(); assert.equal(route, "/pages/availability/availability");
    home.schedule(); assert.equal(route, "/pages/schedule/schedule");
    schedule.onShow(); schedule.courses();
    assert.equal(route, "/pages/courses/courses");
    courses.onShow(); assert.ok(courses.data.courses.length > 0);
    reports.onShow(); assert.equal(reports.data.tab, "mine");
    reports.tab(event({ tab: "all" })); reports.onShow();
    assert.equal(reports.data.tab, "all", "同一身份保留主动选择");
    changeDemoActor("m1"); reports.onShow(); assert.equal(reports.data.tab, "mine");
    profile.onShow(); assert.equal(profile.data.manager, false);
    assert.equal(profile.data.pendingCount, 0);
    profile.openDemo(); assert.equal(route, "/pages/demo/demo");
    demo.onShow();
    demo.switchActor(event({}, String(demo.data.members.findIndex((m: any) => m.id === "m6"))));
    assert.equal(route, "/pages/manage/manage?tab=members");
    assert.equal(readState().actorId, "m6");
    transact(s => { applyForMembership(s, "navigation-test", { name: "导航测试", studentNo: "20269999", classId: s.classes[0].id }); });
    profile.onShow(); assert.equal(profile.data.pendingCount, 1);
    profile.manage(); assert.equal(route, "/pages/manage/manage?tab=members");
    home.onShow(); assert.equal(home.data.manager, true);
    reports.onShow(); assert.equal(reports.data.tab, "all");
    reports.tab(event({ tab: "stats" })); reports.onShow(); assert.equal(reports.data.tab, "stats");
    reports.setData({ filename: "admin.xlsx", filePath: "/admin.xlsx" });
    changeDemoActor("m0"); reports.onShow();
    assert.equal(reports.data.tab, "mine");
    assert.equal(reports.data.filePath, "");
    profile.onShow(); assert.equal(profile.data.pendingCount, 0);
    demo.onShow(); demo.switchActor(event({}, "999")); assert.equal(readState().actorId, "m0");
    demo.joinDemo(); assert.equal(route, "/pages/join/join");
    pages.join.openDemo(); assert.equal(route, "/pages/demo/demo");
    demo.onShow(); assert.equal(demo.data.actorIndex, -1);
    demo.switchActor(event({}, String(demo.data.members.findIndex((m: any) => m.id === "m0"))));
    assert.equal(route, "/pages/index/index");
  } finally {
    runtime.wx = oldWx;
    runtime.Page = oldPage;
  }
});
