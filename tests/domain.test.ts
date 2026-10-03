import assert from "node:assert/strict";
import test from "node:test";
import { createSeed } from "../miniprogram/domain/seed";
import { generatePlan, eligible } from "../miniprogram/domain/scheduler";
import {
  generate,
  confirm,
  skip,
  saveAvailability,
  submitRecord,
} from "../miniprogram/domain/actions";
import {
  missingMetrics,
  percent,
  ratio,
  validateMetrics,
} from "../miniprogram/domain/metrics";
import {
  addSemester,
  commitImport,
  inspectImport,
} from "../miniprogram/domain/imports";
import {
  exportTxt,
  exportXlsx,
  reportSheets,
  gradeStats,
} from "../miniprogram/domain/reports";
import { currentWeek, weekDate } from "../miniprogram/domain/calendar";
import type { AppState, Observation } from "../miniprogram/domain/types";

function state(): AppState {
  const s = createSeed();
  s.actorId = "m7";
  s.plans = [];
  s.records = [];
  s.drafts = [];
  const availability = s.availability.filter(
    (a, i, all) => all.findIndex((x) => x.memberId === a.memberId) === i,
  );
  s.availability = availability.map((a) => ({ ...a, week: 2 }));
  return s;
}
function record(s: AppState): Observation {
  generate(s, 2);
  confirm(s, 2, s.drafts[0].revision);
  const task = s.plans[0].tasks[0];
  s.actorId = task.memberId;
  return {
    id: "test-record",
    taskId: task.id,
    semesterId: s.activeSemesterId,
    week: 2,
    memberId: task.memberId,
    memberName: task.memberName,
    course: task.course,
    classLabel: task.classLabel,
    date: weekDate(s.semesters[0], 2, task.course.weekday),
    metrics: {
      expected: 40,
      actual: 39,
      late: 1,
      early: 0,
      sleep: 0,
      phone: 0,
      talk: 0,
      other: 0,
    },
    absentNames: "无",
    leaveNames: "示例同学",
    otherDescription: "",
    evaluation: "认真听讲",
    feedback: "",
    suggestion: "",
    photos: ["wxfile://test-signature.jpg"],
    createdAt: "",
  };
}
test("时间以北京时间首周周一为界，跨日周次正确", () => {
  const semester = state().semesters[0];
  assert.equal(currentWeek(semester, new Date("2026-09-13T15:59:59Z")), 1);
  assert.equal(currentWeek(semester, new Date("2026-09-13T16:00:00Z")), 2);
  assert.equal(weekDate(semester, 2, 3), "2026-09-16");
});
test("非本班、最多一次、完整连续无课时间", () => {
  const s = state(),
    p = generatePlan(s, s.activeSemesterId, 2, 1);
  assert.equal(p.tasks.length, 6);
  assert.equal(new Set(p.tasks.map((t) => t.memberId)).size, 6);
  for (const task of p.tasks)
    assert.ok(eligible(s, task.course, task.memberId, 2));
  const t = p.tasks[0];
  s.availability.find((a) => a.memberId === t.memberId)!.slots = s.availability
    .find((a) => a.memberId === t.memberId)!
    .slots.filter((x) => x !== t.course.weekday + ":" + t.course.end);
  assert.equal(eligible(s, t.course, t.memberId, 2), false);
});
test("人手不足保留未覆盖班，不增加个人次数", () => {
  const s = state();
  s.availability = s.availability.slice(0, 1);
  const p = generatePlan(s, s.activeSemesterId, 2, 2);
  assert.equal(p.tasks.length, 1);
  assert.equal(p.uncovered.length, 5);
});
test("管理员报名仅对目标周生效", () => {
  const s = state(),
    c = s.courses.find((c) => !c.classIds.includes(s.members[7].classId))!;
  assert.equal(eligible(s, c, "m7", 2), false);
  saveAvailability(s, {
    memberId: "m7",
    semesterId: s.activeSemesterId,
    week: 2,
    slots: Array.from({ length: 14 }, (_, i) => c.weekday + ":" + (i + 1)),
    note: "",
    optedIn: true,
    updatedAt: "",
  });
  assert.equal(eligible(s, c, "m7", 2), true);
  assert.equal(eligible(s, c, "m7", 3), false);
});
test("合班含本班不允许，交叉合班暂拒绝生成", () => {
  const s = state(),
    c = { ...s.courses[0], classIds: ["24-cs1", "24-se1"] };
  assert.equal(eligible(s, c, "m0", 2), false);
  s.courses[0] = c;
  assert.throws(() => generatePlan(s, s.activeSemesterId, 2, 1), /交叉合班/);
});
test("草稿不成为正式任务，重新生成必须由管理员重新确认", () => {
  const s = state();
  generate(s, 2);
  const first = s.drafts[0].revision;
  assert.equal(s.plans.length, 0);
  generate(s, 2);
  assert.throws(() => confirm(s, 2, first), /草稿已变化/);
  confirm(s, 2, s.drafts[0].revision);
  assert.equal(s.plans[0].status, "confirmed");
  assert.equal(s.drafts.length, 0);
  const old = JSON.stringify(s.plans);
  generate(s, 2);
  assert.equal(JSON.stringify(s.plans), old);
});
test("确认前重新验证无课时间", () => {
  const s = state();
  generate(s, 2);
  s.availability = [];
  assert.throws(() => confirm(s, 2, s.drafts[0].revision), /无课时间/);
  assert.equal(s.plans.length, 0);
});
test("普通成员不能管理排班，部长不能跳过", () => {
  const s = state();
  s.actorId = "m0";
  assert.throws(() => generate(s, 2), /无权/);
  s.actorId = "m6";
  assert.throws(() => generate(s, 2), /无权/);
  assert.throws(() => confirm(s, 2, 1), /无权/);
  assert.throws(() => skip(s, 2, "假期"), /无权/);
});
test("跳过周可重新生成，但必须确认才能替换跳过状态", () => {
  const s = state();
  skip(s, 2, "假期");
  generate(s, 2);
  assert.equal(s.plans[0].status, "skipped");
  confirm(s, 2, s.drafts[0].revision);
  assert.equal(s.plans[0].status, "confirmed");
});
test("签字照片必传，重复提交拦截，已有记录禁止重排", () => {
  const s = state(),
    r = record(s);
  assert.throws(() => submitRecord(s, { ...r, photos: [] }), /照片/);
  submitRecord(s, r);
  assert.throws(() => submitRecord(s, r), /重复提交/);
  s.actorId = "m7";
  assert.throws(() => generate(s, 2), /已有提交记录/);
  assert.throws(() => skip(s, 2, "假期"), /已有提交记录/);
});
test("不能冒用他人任务，不能静默取消正式安排时段", () => {
  const s = state(),
    r = record(s);
  s.actorId = s.members.find((m) => m.id !== r.memberId)!.id;
  assert.throws(() => submitRecord(s, r), /自己的/);
  s.actorId = r.memberId;
  assert.throws(
    () =>
      saveAvailability(s, {
        semesterId: s.activeSemesterId,
        memberId: s.actorId,
        week: 2,
        slots: [],
        note: "",
        optedIn: false,
        updatedAt: "",
      }),
    /正式任务/,
  );
});
test("缺失、零、除零及人数校验", () => {
  assert.equal(ratio(-1, 40), null);
  assert.equal(ratio(0, 40), 0);
  assert.equal(ratio(0, 0), null);
  assert.equal(percent(ratio(-1, 40)), "信息缺失");
  validateMetrics(missingMetrics());
  assert.throws(
    () => validateMetrics({ ...missingMetrics(), expected: 40, actual: 41 }),
    /实到/,
  );
  assert.throws(
    () => validateMetrics({ ...missingMetrics(), sleep: 1.5 }),
    /整数/,
  );
});
test("新学期独立保存，年级和专业可变化，历史记录不变", () => {
  const s = state(),
    r = record(s);
  submitRecord(s, r);
  s.actorId = "m7";
  const history = JSON.stringify(s.records);
  addSemester(s, {
    id: "next",
    name: "2027–2028 第一学期",
    startDate: "2027-09-06",
    weeks: 20,
    grades: ["25", "26", "27"],
    days: 5,
    periods: 14,
    edition: "学风督察小组",
  });
  assert.equal(JSON.stringify(s.records), history);
  assert.equal(s.activeSemesterId, "next");
  assert.equal(reportSheets(s, 1).length, 13);
});
test("课表导入仅管理员可用，成员名单不再支持导入", () => {
  const s = state();
  s.actorId = "m6";
  assert.throws(() => inspectImport(s, "courses", "{}"), /无权/);
  const text = JSON.stringify({
    members: [
      { id: "new", name: "新成员", studentNo: "new-no", classId: "24-cs1" },
    ],
  });
  s.actorId = "m7";
  assert.ok(inspectImport(s, "courses", text).errors.some(e => e.includes("成员导入已取消")));
  assert.throws(() => commitImport(s, "courses", text), /已取消/);
});
test("新课表支持新年级专业；导入无效整批不写入", () => {
  const s = state(),
    payload = {
      classes: [
        { id: "27-new", grade: "27", major: "新专业", name: "27新专业1班" },
      ],
      courses: [
        {
          id: "new-course",
          name: "新课程",
          teacher: "新教师",
          nature: "必修",
          classIds: ["27-new"],
          classroom: "101",
          weekday: 1,
          start: 3,
          end: 4,
          weeks: [1, 2],
          expected: 50,
        },
      ],
    };
  commitImport(s, "courses", JSON.stringify(payload));
  assert.equal(s.classes.at(-1)!.major, "新专业");
  const count = s.courses.length;
  assert.throws(() =>
    commitImport(
      s,
      "courses",
      JSON.stringify({
        ...payload,
        courses: [{ ...payload.courses[0], end: 100 }],
      }),
    ),
  );
  assert.equal(s.courses.length, count);
});
test("名单 TXT 保留未提交状态与请假区分", () => {
  const s = state(),
    r = record(s);
  submitRecord(s, r);
  s.actorId = "m7";
  const txt = exportTxt(s, 2);
  assert.match(txt, /旷课：无/);
  assert.match(txt, /请假：示例同学/);
  assert.match(txt, /尚未提交/);
  skip(s, 3, "假期");
  assert.match(exportTxt(s, 3), /已跳过/);
});
test("有效人数汇总，缺失课堂不被计算成零出勤", () => {
  const s = state(),
    r = record(s);
  submitRecord(s, r);
  const stat = gradeStats(s, 2).find((g) => g.count > 0)!;
  assert.equal(stat.rate, 39 / 40);
  s.records[0].metrics.actual = -1;
  assert.equal(gradeStats(s, 2).find((g) => g.count > 0)!.rate, null);
});

function entries(buffer: ArrayBuffer): Map<string, string> {
  const b = Buffer.from(buffer),
    files = new Map<string, string>();
  let at = 0;
  while (b.readUInt32LE(at) === 0x04034b50) {
    const len = b.readUInt32LE(at + 18),
      nameLen = b.readUInt16LE(at + 26),
      extra = b.readUInt16LE(at + 28),
      start = at + 30 + nameLen + extra;
    files.set(
      b.subarray(at + 30, at + 30 + nameLen).toString(),
      b.subarray(start, start + len).toString(),
    );
    at = start + len;
  }
  return files;
}
test("XLSX 包含动态工作表、公式、中文和真实图表关系", () => {
  const s = state(),
    r = record(s);
  submitRecord(s, r);
  s.actorId = "m7";
  const files = entries(exportXlsx(s, 2));
  assert.ok(files.has("[Content_Types].xml"));
  for (const [name, content] of files) {
    if (name === "xl/workbook.xml" || name === "xl/styles.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      assert.match(content, /xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/);
    }
  }
  assert.match(files.get("xl/workbook.xml")!, /26级出勤情况/);
  assert.equal(
    (files.get("xl/workbook.xml")!.match(/<sheet /g) || []).length,
    13,
  );
  assert.match(files.get("xl/worksheets/sheet1.xml")!, /<f>IF\(OR\(COUNT\(E/);
  assert.match(files.get("xl/worksheets/sheet1.xml")!, /未提交/);
  assert.ok([...files.keys()].some((k) => k.startsWith("xl/charts/")));
  // Keep business columns visible and hide only the chart calculation helpers.
  assert.doesNotMatch(files.get("xl/worksheets/sheet1.xml")!, /<col [^>]*hidden="1"/);
  for (let id = 2; id <= 13; id++) {
    const sheet = files.get(`xl/worksheets/sheet${id}.xml`)!;
    const hidden = [...sheet.matchAll(/<col min="(\d+)"[^>]*hidden="1"/g)].map(m => Number(m[1]));
    assert.deepEqual(hidden, [13, 14, 15]);
    assert.match(sheet, /INDEX\(\$M\$4:/);
    assert.match(sheet, /INDEX\(\$N\$4:/);
    assert.match(sheet, /<drawing r:id="drawing"/);
  }
});
test("XLSX 字符串以 inlineStr 输出，名单中的公式文本不执行", () => {
  const s = state(),
    r = record(s);
  r.evaluation = '=HYPERLINK("bad") & <test>';
  submitRecord(s, r);
  s.actorId = "m7";
  const raw = entries(exportXlsx(s, 2)).get("xl/worksheets/sheet1.xml")!;
  assert.match(raw, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.match(raw, /&amp; &lt;test&gt;/);
});

test("最大覆盖和两级轮换与小规模穷举结果一致（80种稀疏情况）", () => {
  let random = 712367;
  const rnd = () => {
    random = (random * 1664525 + 1013904223) >>> 0;
    return random / 4294967296;
  };
  for (let iteration = 0; iteration < 80; iteration++) {
    const s = state();
    s.courses = s.courses.slice(0, 4);
    s.members = s.members
      .slice(0, 4)
      .map((m) => ({ ...m, classId: "outside" }));
    const edges = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => rnd() < 0.55),
    );
    s.availability = s.members.map((m, mi) => ({
      memberId: m.id,
      semesterId: s.activeSemesterId,
      week: 2,
      slots: s.courses.flatMap((c, ci) =>
        edges[ci][mi]
          ? [c.weekday + ":" + c.start, c.weekday + ":" + c.end]
          : [],
      ),
      note: "",
      optedIn: false,
      updatedAt: "",
    }));
    const oldClasses = new Set(
        s.courses.filter(() => rnd() < 0.5).map((c) => c.classIds[0]),
      ),
      oldMembers = new Set(
        s.members.filter(() => rnd() < 0.5).map((m) => m.id),
      );
    s.records = [...oldClasses].map(
      (id, i) =>
        ({
          semesterId: s.activeSemesterId,
          week: 1,
          memberId: [...oldMembers][i] || "outside",
          course: { classIds: [id] },
        }) as Observation,
    );
    for (const memberId of oldMembers)
      if (!s.records.some((r) => r.memberId === memberId))
        s.records.push({
          semesterId: s.activeSemesterId,
          week: 1,
          memberId,
          course: { classIds: [] },
        } as unknown as Observation);
    const scores: number[][] = [];
    const walk = (ci: number, used: Set<number>, score: number[]) => {
      if (ci === 4) {
        scores.push(score);
        return;
      }
      walk(ci + 1, used, score);
      for (let mi = 0; mi < 4; mi++)
        if (edges[ci][mi] && !used.has(mi)) {
          const next = new Set(used);
          next.add(mi);
          walk(ci + 1, next, [
            score[0] + 1,
            score[1] + Number(oldClasses.has(s.courses[ci].classIds[0])),
            score[2] + Number(oldMembers.has(s.members[mi].id)),
          ]);
        }
    };
    walk(0, new Set(), [0, 0, 0]);
    scores.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
    const p = generatePlan(s, s.activeSemesterId, 2, iteration);
    assert.deepEqual(
      [
        p.tasks.length,
        p.tasks.filter((t) =>
          t.course.classIds.some((id) => oldClasses.has(id)),
        ).length,
        p.tasks.filter((t) => oldMembers.has(t.memberId)).length,
      ],
      scores[0],
    );
  }
});
