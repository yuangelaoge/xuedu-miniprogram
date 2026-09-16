import automator from "miniprogram-automator";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createSeed } from "../miniprogram/domain/seed.ts";
const root = process.cwd(),
  output = path.join(root, "artifacts", "simulator");
await fs.mkdir(output, { recursive: true });
const mini = await automator.launch({
  cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
  projectPath: root,
  timeout: 60000,
});
const errors = [];
mini.on("exception", (error) => {
  errors.push(error);
  console.error("RUNTIME", JSON.stringify(error));
});
const original = await mini.callWxMethod("getStorageSync", "xuedu.demo.v1");
const seed = createSeed();
const event = (dataset = {}, value = "") => ({
  currentTarget: { dataset },
  detail: { value },
});
const shot = async (name) => {
  await mini.callWxMethod("hideToast");
  await mini.screenshot({ path: path.join(output, name + ".png") });
  console.log("PASS " + name);
};
const switchDemoActor = async (id) => {
  const demo = await mini.navigateTo("/pages/demo/demo");
  await demo.waitFor("picker");
  const index = (await demo.data("members")).findIndex(m => m.id === id);
  assert.ok(index >= 0);
  await demo.callMethod("switchActor", event({}, String(index)));
  await demo.waitFor(300);
  const next = await mini.currentPage();
  assert.ok(["pages/index/index", "pages/manage/manage"].includes(next.path));
};
let tempPhoto, draftKey, originalDraft;
try {
  await mini.callWxMethod("setStorageSync", "xuedu.demo.v1", seed);
  await mini.mockWxMethod("showModal", {
    confirm: true,
    cancel: false,
    content: "假期测试",
  });
  let page = await mini.reLaunch("/pages/index/index");
  if (!process.argv.includes("--submission-only")) {
    await page.waitFor(".semester-hero");
    assert.equal((await page.data("tasks")).length, 1);
    await shot("01-home");

    page = await mini.switchTab("/pages/schedule/schedule");
    await page.callMethod("courses");
    await page.waitFor(300);
    page = await mini.currentPage();
    assert.equal(page.path, "pages/courses/courses");
    await page.waitFor(".course-title");
    await shot("02-courses");
    await page.callMethod("search", event({}, "不存在的课程"));
    assert.equal((await page.data("courses")).length, 0);
    await page.callMethod("search", event({}, "数据"));
    assert.ok((await page.data("courses")).length > 0);

    page = await mini.navigateTo("/pages/availability/availability");
    await page.waitFor(".time-cell");
    const before = (await page.data("slots")).length;
    await page.callMethod("toggle", event({ key: "1:1" }));
    assert.equal((await page.data("slots")).length, before + 1);
    await page.callMethod("save");
    assert.equal(await page.data("dirty"), false);
    await shot("03-availability");

    await switchDemoActor("m6");
    page = await mini.switchTab("/pages/profile/profile");
    await page.waitFor(".profile-name");
    assert.equal(await page.data("role"), "组部长");
    await shot("04-profile-leader");
    page = await mini.switchTab("/pages/schedule/schedule");
    await page.waitFor(".week-switch");
    await page.callMethod("generate");
    assert.equal(await page.data("draft"), true);
    await shot("05-schedule-draft");
    const revision = await page.data("revision");
    await page.callMethod("generate");
    assert.ok((await page.data("revision")) > revision);
    await page.callMethod("confirm");
    await page.waitFor(250);
    assert.equal(await page.data("draft"), false);
    assert.equal(await page.data("status"), "confirmed");
    await shot("06-schedule-confirmed");

    await switchDemoActor("m7");
    page = await mini.navigateTo("/pages/availability/availability");
    await page.waitFor(".time-cell");
    assert.equal(await page.data("volunteer"), true);
    await page.callMethod("volunteer");
    await page.callMethod("day", event({ day: "1" }));
    await page.callMethod("save");
    assert.equal(await page.data("optedIn"), true);
    await shot("07-admin-volunteer");

    page = await mini.switchTab("/pages/schedule/schedule");
    await page.callMethod("skip");
    await page.waitFor(250);
    assert.equal(await page.data("status"), "skipped");
    await shot("08-skipped-week");

    page = await mini.navigateTo("/pages/manage/manage?tab=courses");
    await page.waitFor(".import-text");
    await page.callMethod("example");
    await page.callMethod("preview");
    assert.equal((await page.data("errors")).length, 0);
    await shot("09-import-preview");
    await page.callMethod("commit");
    await page.waitFor(250);
    assert.ok((await mini.callWxMethod("getStorageSync", "xuedu.demo.v1")).courses.some(c => c.name === "程序设计基础"));
    await page.callMethod("tab", event({ tab: "semester" }));
    await shot("10-semester");
  }

  // 使用明确的本地测试图片验证凭证路径、草稿和提交；结束时恢复原体验数据。
  await switchDemoActor("m0");
  page = await mini.switchTab("/pages/index/index");
  const task = (await page.data("tasks"))[0];
  draftKey = "xuedu.form.m0." + task.id;
  originalDraft = await mini.callWxMethod("getStorageSync", draftKey);
  await mini.callWxMethod("removeStorageSync", draftKey);
  page = await mini.navigateTo("/pages/submission/submission?task=" + task.id);
  await page.waitFor(".metric-input");
  await page.callMethod("metric", event({ key: "actual" }, "37"));
  await page.callMethod("zero");
  await page.callMethod("noNames", event({ key: "absentNames" }));
  await page.callMethod("noNames", event({ key: "leaveNames" }));
  tempPhoto = await mini.evaluate(
    (base64) => {
      const p = wx.env.USER_DATA_PATH + "/xuedu-simulator-test-image.png";
      wx.getFileSystemManager().writeFileSync(p, base64, "base64");
      return p;
    },
    (
      await fs.readFile(path.join(root, "miniprogram/assets/book.png"))
    ).toString("base64"),
  );
  await page.setData({
    photos: [tempPhoto],
    evaluation: "本地模拟器测试记录，非真实听课",
  });
  await page.callMethod("draft");
  await shot("11-submission");
  await page.callMethod("submit");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  page = await mini.currentPage();
  assert.equal(page.path, "pages/record/record");
  assert.equal(await page.data("canView"), true);
  await shot("12-record");

  await switchDemoActor("m7");
  page = await mini.switchTab("/pages/reports/reports");
  await page.waitFor(".tabs");
  assert.equal(await page.data("submitted"), 1);
  await shot("13-reports");
  await page.callMethod("tab", event({ tab: "stats" }));
  await shot("14-statistics");
  await page.callMethod("export", event({ kind: "xlsx" }));
  await page.waitFor(500);
  const xlsxPath = await page.data("filePath");
  assert.ok(xlsxPath.endsWith(".xlsx"));
  const xlsx = await mini.evaluate(
    (p) => wx.getFileSystemManager().readFileSync(p, "base64"),
    xlsxPath,
  );
  await fs.writeFile(
    path.join(output, "verified-export.xlsx"),
    Buffer.from(xlsx, "base64"),
  );
  await page.callMethod("export", event({ kind: "txt" }));
  await page.waitFor(350);
  assert.ok((await page.data("filePath")).endsWith(".txt"));
  console.log("PASS genuine XLSX and TXT export through WeChat filesystem");
  await fs.writeFile(
    path.join(output, "errors.json"),
    JSON.stringify(errors, null, 2),
  );
  assert.equal(errors.length, 0);
} finally {
  await mini.restoreWxMethod("showModal");
  await mini.callWxMethod("setStorageSync", "xuedu.demo.v1", original || seed);
  if (draftKey) {
    if (originalDraft && originalDraft.evaluation !== "本地模拟器测试记录，非真实听课")
      await mini.callWxMethod("setStorageSync", draftKey, originalDraft);
    else await mini.callWxMethod("removeStorageSync", draftKey);
  }
  if (tempPhoto)
    await mini.evaluate((p) => {
      try {
        wx.getFileSystemManager().unlinkSync(p);
      } catch {}
    }, tempPhoto);
  await mini.reLaunch("/pages/index/index");
  mini.disconnect();
}
