/** Deterministic, bounded chunks for the validated JSON course interchange format. */
export interface ImportBatch { text: string; requestId: string; courses: number; classes: number; dates: number; }
export interface ImportPlan { sourceText: string; semesterId: string; epoch: string; memberId: string; permissionsVersion: number; next: number; batches: ImportBatch[]; }
const MAX_COURSES = 6;
const MAX_DATES = 60;
const MAX_CLASSES = 40;

export function planCourseImport(sourceText: string, nextRequestId: () => string): ImportBatch[] {
  const source = JSON.parse(sourceText) as { classes?: {id?:string}[]; courses?: {classIds?:string[];weeks?:number[]}[] };
  if (!source || !Array.isArray(source.courses) || !source.courses.length || source.classes !== undefined && !Array.isArray(source.classes)) throw new Error("JSON课表格式无效");
  const unassigned = new Map((source.classes || []).map(row => [row.id, row]));
  const drafts: {classes: {id?:string}[];courses: typeof source.courses;dates:number}[] = [];
  let current = { classes: [] as {id?:string}[], courses: [] as typeof source.courses, dates: 0 };
  const flush = () => { if (current.courses.length) { drafts.push(current); current = { classes: [], courses: [], dates: 0 }; } };
  for (const course of source.courses) {
    const dates = Array.isArray(course.weeks) ? new Set(course.weeks).size : 0;
    if (!dates || dates > MAX_DATES) throw new Error("单门课程日期数量无效或超过单批上限");
    const needed = () => [...new Set(course.classIds || [])].filter(id => unassigned.has(id)).map(id => unassigned.get(id)!);
    if (current.courses.length && (current.courses.length >= MAX_COURSES || current.dates + dates > MAX_DATES || current.classes.length + needed().length > MAX_CLASSES)) flush();
    const classes = needed();
    if (classes.length > MAX_CLASSES) throw new Error("单门课程关联的新增班级超过单批上限");
    current.classes.push(...classes);
    for (const row of classes) unassigned.delete(row.id);
    current.courses.push(course); current.dates += dates;
  }
  flush();
  // A declared but unused class must still be created; never silently omit it.
  for (const row of unassigned.values()) {
    const target = drafts.find(batch => batch.classes.length < MAX_CLASSES);
    if (!target) throw new Error("未被课程引用的班级过多，请先单独建立班级");
    target.classes.push(row);
  }
  const batches = drafts.map(batch => ({text:JSON.stringify({classes:batch.classes,courses:batch.courses}),requestId:nextRequestId(),courses:batch.courses.length,classes:batch.classes.length,dates:batch.dates}));
  if (batches.some(batch => !batch.requestId || batch.requestId.length > 200) || new Set(batches.map(batch => batch.requestId)).size !== batches.length)
    throw new Error("导入批次请求号无效，请重新预览后再试");
  return batches;
}
