import { linkedCharts } from "./report-charts";
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
  requireRole(state, ["admin", "officer"]);
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
    const records = weekRecords(state, week).filter((r) => Array.from(new Set(r.course.classIds.map(id=>(r.classes || state.classes).find(c=>c.id===id)?.grade || ""))).sort().join("/") === grade);
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
  requireRole(state, ["admin", "officer"]);
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
    [semester.edition + " " + semester.name + " 第" + week + "周入班听课汇总表"],
    ["基本信息",null,null,null,"考勤信息",null,null,null,null,null,null,null,"上课状态",null,null,null,null,null,null,null,"其他"],
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
              "IF(OR(COUNT("+a+r+","+b+r+")<2," +
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
            "IF(OR(COUNT(E"+r+",F"+r+")<2,E" + r + "<0,F" + r + "<0),-1,E" + r + "-F" + r + ")",
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
            "IF(OR(COUNT(M"+r+",O"+r+",Q"+r+")<3,M" +
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
  // Spare editable rows allow local additions without fixed template class counts.
  // Duplicate records remain separate observations; combined classes remain one row.
  const sourceEnd=raw.length;
  for(let i=0;i<20;i++) {
    const r=raw.length+1;
    raw.push(['','','','',-1,-1,f(`IF(OR(COUNT(E${r},F${r})<2,E${r}<0,F${r}<0),-1,E${r}-F${r})`,-1),
      f(`IF(AND(COUNT(E${r},F${r})=2,E${r}>0,F${r}>=0),F${r}/E${r},"信息缺失")`,'信息缺失'),-1,
      f(`IF(AND(COUNT(I${r},F${r})=2,I${r}>=0,F${r}>0),I${r}/F${r},"信息缺失")`,'信息缺失'),-1,
      f(`IF(AND(COUNT(K${r},E${r})=2,K${r}>=0,E${r}>0),K${r}/E${r},"信息缺失")`,'信息缺失'),-1,
      f(`IF(AND(COUNT(M${r},F${r})=2,M${r}>=0,F${r}>0),M${r}/F${r},"信息缺失")`,'信息缺失'),-1,
      f(`IF(AND(COUNT(O${r},F${r})=2,O${r}>=0,F${r}>0),O${r}/F${r},"信息缺失")`,'信息缺失'),-1,
      f(`IF(AND(COUNT(Q${r},F${r})=2,Q${r}>=0,F${r}>0),Q${r}/F${r},"信息缺失")`,'信息缺失'),
      f(`IF(OR(COUNT(M${r},O${r},Q${r})<3,MIN(M${r},O${r},Q${r})<0),-1,SUM(M${r},O${r},Q${r}))`,-1),
      f(`IF(AND(S${r}>=0,F${r}>0),S${r}/F${r},"信息缺失")`,'信息缺失'),'',-1,
      f(`IF(AND(COUNT(V${r},F${r})=2,V${r}>=0,F${r}>0),V${r}/F${r},"信息缺失")`,'信息缺失'),'','','','未提交','']);
  }
  // Late count is also gated by submission, so an unsubmitted row cannot become a zero observation.
  raw[2].push('统计标签','统计迟到人数');
  raw.slice(3).forEach((row,i)=>{
    const r=i+4,submitted=row[26]==='已提交';
    for(const ci of [7,9,11,13,15,17,19,22]) {
      const cell=row[ci]; if(cell && typeof cell==='object') row[ci]=f(`IF(AA${r}="已提交",${cell.formula},"信息缺失")`,submitted?cell.value:'信息缺失');
    }
    row[28]=f(`IF(B${r}="","",B${r}&" · "&C${r}&" · 第"&(ROW()-3)&"次观测")`,row[1]?String(row[1])+' · '+String(row[2]||'')+' · 第'+(i+1)+'次观测':'');
    row[29]=f(`IF(AND(AA${r}="已提交",ISNUMBER(I${r}),I${r}>=0),I${r},"")`,submitted?Number(row[8])>=0?Number(row[8]):'':'');
  });
  const source:SheetData={name:'原始数据',rows:raw,raw:true,groupHeaders:true};
  const grades=Array.from(new Set([...semester.grades,...raw.slice(3,sourceEnd).map(r=>String(r[0]||''))])).filter(Boolean);
  const sheets=[source,...linkedCharts(source,grades,week,['H','T','J'],'AD','A','AC')];

  return sheets;
}
export function exportXlsx(state: AppState, week: number): ArrayBuffer {
  return createXlsx(reportSheets(state, week));
}
