import { AppState, Course, SchoolClass, Semester } from "./types";
import { audit, requireRole } from "./actions";

export type ImportKind = "courses";
export interface ImportPreview {
  classes: SchoolClass[];
  courses: Course[];
  errors: string[];
}
// 明确 JSON 交换格式，真实教务 Excel 的列映射需在拿到样表后适配。
export function inspectImport(
  state: AppState,
  kind: ImportKind,
  text: string,
): ImportPreview {
  requireRole(state, ["admin"]);
  if (kind !== "courses") throw new Error("成员导入已取消，请通过入组申请审核添加成员");
  let source: { classes?: unknown; members?: unknown; courses?: unknown };
  try {
    source = JSON.parse(text);
  } catch {
    throw new Error("JSON 格式不正确，请参考项目中的导入示例");
  }
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new Error("文件应是包含 classes 和 courses 的 JSON 对象");
  const errors: string[] = [];
  const classes = Array.isArray(source.classes)
    ? (source.classes as SchoolClass[])
    : [];
  const courses = Array.isArray(source.courses)
    ? (source.courses as Course[])
    : [];
  if (source.members !== undefined) errors.push("成员导入已取消，课表文件不能包含 members");
  if (!courses.length) errors.push("没有找到要导入的课程");
  if (classes.length + courses.length > 1000)
    errors.push("单批最多 1000 条数据");
  const validString = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0 && v.length < 200;
  const knownClasses = state.classes.map((c) => c.id);
  classes.forEach((c, i) => {
    if (!c || ![c.id, c.grade, c.major, c.name].every(validString)) {
      errors.push("班级第" + (i + 1) + "行字段不完整");
      return;
    }
    if (
      knownClasses.includes(c.id) ||
      classes.slice(0, i).some((x) => x?.id === c.id)
    )
      errors.push("班级 ID 重复：" + c.id);
  });
  const classIds = knownClasses.concat(
    classes.filter(Boolean).map((c) => c.id),
  );
  const semester = state.semesters.find(
    (s) => s.id === state.activeSemesterId,
  )!;
  courses.forEach((c, i) => {
    if (
      !c ||
      ![c.id, c.name, c.teacher, c.nature, c.classroom].every(validString)
    ) {
      errors.push("课程第" + (i + 1) + "行字段不完整");
      return;
    }
    if (
      state.courses.some((x) => x.id === c.id) ||
      courses.slice(0, i).some((x) => x?.id === c.id)
    )
      errors.push(c.name + "：课程 ID 重复");
    if (
      !Array.isArray(c.classIds) ||
      !c.classIds.length ||
      new Set(c.classIds).size !== c.classIds.length ||
      c.classIds.some((id) => !classIds.includes(id))
    )
      errors.push(c.name + "：班级引用无效或重复");
    if (
      ![c.weekday, c.start, c.end, c.expected].every(Number.isInteger) ||
      c.weekday < 1 ||
      c.weekday > semester.days ||
      c.start < 1 ||
      c.end < c.start ||
      c.end > semester.periods ||
      c.expected < 0
    )
      errors.push(c.name + "：节次、星期或人数无效");
    if (
      !Array.isArray(c.weeks) ||
      !c.weeks.length ||
      c.weeks.some((w) => !Number.isInteger(w) || w < 1 || w > semester.weeks)
    )
      errors.push(c.name + "：有效周次无效");
    if (c.semesterId && c.semesterId !== semester.id)
      errors.push(c.name + "：学期不符");
  });
  return { classes, courses, errors };
}
export function commitImport(
  state: AppState,
  kind: ImportKind,
  text: string,
): void {
  const result = inspectImport(state, kind, text);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  state.classes.push(
    ...result.classes.map((c) => ({
      id: c.id,
      grade: c.grade,
      major: c.major,
      name: c.name,
    })),
  );
  state.courses.push(
      ...result.courses.map((c) => ({
        ...c,
        semesterId: state.activeSemesterId,
      })),
    );
  // 基础数据变化后旧草稿需重新计算；正式任务保留课程快照。
  state.drafts = state.drafts.filter(
    (d) => d.semesterId !== state.activeSemesterId,
  );
  audit(
    state,
    "确认导入",
    result.courses.length + "个时段" +
      "；新增" +
      result.classes.length +
      "个班级",
  );
}
export function addSemester(state: AppState, value: Semester): void {
  requireRole(state, ["admin"]);
  if (!value.name.trim() || state.semesters.some((s) => s.id === value.id))
    throw new Error("学期名称为空或 ID 重复");
  const date = new Date(value.startDate + "T12:00:00+08:00");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value.startDate) ||
    Number.isNaN(date.getTime()) ||
    date.getUTCDay() !== 1 ||
    date.toISOString().slice(0, 10) !== value.startDate
  )
    throw new Error("首周日期需为有效的周一日期");
  if (
    !Number.isInteger(value.weeks) ||
    value.weeks < 1 ||
    value.weeks > 30 ||
    !value.grades.length ||
    value.grades.some((g) => !/^\d{2}$/.test(g))
  )
    throw new Error("请设置 1–30 周及两位数字年级");
  if (
    !Number.isInteger(value.days) ||
    value.days < 5 ||
    value.days > 7 ||
    !Number.isInteger(value.periods) ||
    value.periods < 1 ||
    value.periods > 16
  )
    throw new Error("上课日为 5–7 天，每天为 1–16 节");
  state.semesters.push(value);
  state.activeSemesterId = value.id;
  audit(state, "新建学期", value.name);
}
