import { AppState, Metrics, Observation } from "./types";
import { classLabel } from "./scheduler";
import { discipline, missingMetrics, ratio } from "./metrics";
import { Cell, createXlsx, SheetData } from "./xlsx";
import { requireRole } from "./actions";
export function weekRecords(state: AppState, week: number): Observation[] {
  return state.records.filter(
    (r) => r.semesterId === state.activeSemesterId && r.week === week,
  );
}
export function exportTxt(state: AppState, week: number): string {
  requireRole(state, ["admin", "leader"]);
  const semester = state.semesters.find(
      (s) => s.id === state.activeSemesterId,
    )!,
    plan = state.plans.find(
      (p) => p.semesterId === semester.id && p.week === week,
    );
  const lines = [
    semester.name + " 第" + week + "周请假旷课学生名单",
    semester.edition,
    "",
  ];
  if (plan?.status === "skipped")
    return lines.concat("本周已跳过听课：" + plan.reason).join("\n");
  const records = weekRecords(state, week);
  if (!records.length)
    lines.push("本周尚无提交记录；未填写不能视为无人请假或旷课。");
  records
    .slice()
    .sort((a, b) => a.classLabel.localeCompare(b.classLabel))
    .forEach((r) =>
      lines.push(
        r.classLabel + " · " + r.course.name + " · " + r.date,
        "旷课：" + r.absentNames,
        "请假：" + r.leaveNames,
        ...(r.correctedAt ? ["最近更正：" + r.correctedAt] : []),
        "",
      ),
    );
  const missing = (plan?.tasks || []).filter(
    (t) => !records.some((r) => r.taskId === t.id),
  );
  if (missing.length)
    lines.push("尚未提交：" + missing.map((t) => t.classLabel).join("、"));
  return lines.join("\n");
}
export function gradeStats(state: AppState, week: number) {
  const semester = state.semesters.find(
    (s) => s.id === state.activeSemesterId,
  )!;
  return semester.grades.map((grade) => {
    const records = weekRecords(state, week).filter((r) =>
      r.course.classIds.some(
        (id) => (r.classes || state.classes).find((c) => c.id === id)?.grade === grade,
      ),
    );
    const valid = records.filter(
      (r) => r.metrics.expected > 0 && r.metrics.actual >= 0,
    );
    const expected = valid.reduce((n, r) => n + r.metrics.expected, 0),
      actual = valid.reduce((n, r) => n + r.metrics.actual, 0);
    return {
      grade,
      count: records.length,
      valid: valid.length,
      expected,
      actual,
      rate: ratio(actual, expected),
    };
  });
}
function f(formula: string, value: string | number): Cell {
  return { formula, value };
}
export function reportSheets(state: AppState, week: number): SheetData[] {
  requireRole(state, ["admin", "leader"]);
  const semester = state.semesters.find(
      (s) => s.id === state.activeSemesterId,
    )!,
    plan = state.plans.find(
      (p) => p.semesterId === semester.id && p.week === week,
    );
  const records = weekRecords(state, week);
  const headers = [
    "年级",
    "听课班级",
    "课程名称",
    "课程性质",
    "应到",
    "实到",
    "未到",
    "出勤率",
    "迟到",
    "比例",
    "早退",
    "比例",
    "睡觉",
    "比例",
    "玩手机",
    "比例",
    "说话",
    "比例",
    "违纪情况",
    "比例",
    "其他情况",
    "人数",
    "比例",
    "听课组员对班风评价",
    "异常情况及反馈",
    "任课教师意见及建议",
    "提交状态",
    "最近更正时间",
  ];
  const raw: Cell[][] = [
    [semester.name + " 第" + week + "周入班听课汇总表"],
    ["-1 表示信息缺失；违纪暂按行为人次；缺失指标不进入图表；统计仅代表实际听课观测"],
    headers,
  ];
  if (plan?.status === "skipped") raw.push(["本周已跳过", plan.reason || ""]);
  else {
    const courseGroups = state.courses
      .filter(
        (c) =>
          c.semesterId === semester.id &&
          c.weeks.includes(week) &&
          c.classIds.some((id) =>
            semester.grades.includes(
              state.classes.find((k) => k.id === id)?.grade || "",
            ),
          ),
      )
      .filter(
        (c, i, all) =>
          all.findIndex(
            (x) =>
              x.classIds.slice().sort().join("|") ===
              c.classIds.slice().sort().join("|"),
          ) === i,
      );
    const entries: {
      label: string;
      name: string;
      nature: string;
      grade: string;
      metrics: Metrics;
      record?: Observation;
    }[] = records.map((r) => ({
      label: r.classLabel,
      name: r.course.name,
      nature: r.course.nature,
      grade: Array.from(
        new Set(
          r.course.classIds.map(
            (id) => (r.classes || state.classes).find((c) => c.id === id)?.grade || "",
          ),
        ),
      ).join("/"),
      metrics: r.metrics,
      record: r,
    }));
    courseGroups
      .filter(
        (c) =>
          !records.some(
            (r) =>
              r.course.classIds.slice().sort().join("|") ===
              c.classIds.slice().sort().join("|"),
          ),
      )
      .forEach((c) =>
        entries.push({
          label: classLabel(state, c.classIds),
          name: "",
          nature: "",
          grade: state.classes.find((k) => k.id === c.classIds[0])?.grade || "",
          metrics: missingMetrics(),
        }),
      );
    entries
      .sort(
        (a, b) =>
          a.grade.localeCompare(b.grade) || a.label.localeCompare(b.label),
      )
      .forEach((e) => {
        const m = e.metrics,
          r = raw.length + 1,
          d = discipline(m),
          calc = (n: number, den: number, a: string, b: string): Cell =>
            f(
              "IF(OR(" +
                a +
                r +
                "<0," +
                b +
                r +
                '<=0),"信息缺失",' +
                a +
                r +
                "/" +
                b +
                r +
                ")",
              ratio(n, den) ?? "信息缺失",
            );
        raw.push([
          e.grade,
          e.label,
          e.name,
          e.nature,
          m.expected,
          m.actual,
          f(
            "IF(OR(E" + r + "<0,F" + r + "<0),-1,E" + r + "-F" + r + ")",
            m.expected < 0 || m.actual < 0 ? -1 : m.expected - m.actual,
          ),
          calc(m.actual, m.expected, "F", "E"),
          m.late,
          calc(m.late, m.actual, "I", "F"),
          m.early,
          calc(m.early, m.expected, "K", "E"),
          m.sleep,
          calc(m.sleep, m.actual, "M", "F"),
          m.phone,
          calc(m.phone, m.actual, "O", "F"),
          m.talk,
          calc(m.talk, m.actual, "Q", "F"),
          f(
            "IF(OR(M" +
              r +
              "<0,O" +
              r +
              "<0,Q" +
              r +
              "<0),-1,SUM(M" +
              r +
              ",O" +
              r +
              ",Q" +
              r +
              "))",
            d,
          ),
          calc(d, m.actual, "S", "F"),
          e.record?.otherDescription || "",
          m.other,
          calc(m.other, m.actual, "V", "F"),
          e.record?.evaluation || "",
          e.record?.feedback || "",
          e.record?.suggestion || "",
          e.record ? "已提交" : "未提交 / 未安排",
          e.record?.correctedAt || "",
        ]);
      });
  }
  const sheets: SheetData[] = [{ name: "原始数据", rows: raw, raw: true }];
  const groups = [
    { name: "各班级", records },
    ...semester.grades.map((g) => ({
      name: g + "级",
      records: records.filter((r) =>
        r.course.classIds.some(
          (id) => state.classes.find((c) => c.id === id)?.grade === g,
        ),
      ),
    })),
  ];
  groups.forEach((g, gi) => {
    const specs = [
      {
        name: "出勤情况",
        label: "出勤率",
        value: (r: Observation) => ratio(r.metrics.actual, r.metrics.expected),
      },
      {
        name: "违纪情况",
        label: "违纪率（行为人次）",
        value: (r: Observation) =>
          ratio(discipline(r.metrics), r.metrics.actual),
      },
      {
        name: gi === 0 ? "迟到人数" : "迟到情况",
        label: gi === 0 ? "迟到人数" : "迟到率",
        value: (r: Observation) =>
          gi === 0
            ? r.metrics.late < 0
              ? null
              : r.metrics.late
            : ratio(r.metrics.late, r.metrics.actual),
      },
    ];
    specs.forEach((spec) => {
      const rows = g.records
        .map((r) => ({
          label: r.classLabel + " · " + r.course.name,
          value: spec.value(r),
        }))
        .filter((x) => x.value !== null)
        .sort(
          (a, b) =>
            (b.value as number) - (a.value as number) ||
            a.label.localeCompare(b.label),
        );
      sheets.push({
        name: g.name + spec.name,
        chart: true,
        rows: [
          [g.name + spec.name],
          [
            "第" +
              week +
              "周 · 有效记录 " +
              rows.length +
              " / " +
              g.records.length +
              "；此页为导出时快照",
          ],
          ["听课班级 / 课程", spec.label],
          ...rows.map((r) => [r.label, r.value] as Cell[]),
        ],
      });
    });
  });
  return sheets;
}
export function exportXlsx(state: AppState, week: number): ArrayBuffer {
  return createXlsx(reportSheets(state, week));
}
