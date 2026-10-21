import { classGrade, isEarlyCourse } from "./course-preferences";
import { participatesByDefault } from "./capabilities";
import { AppState, Course, Plan, Task } from "./types";
import { slotsFor } from "./calendar";

export function classLabel(state: AppState, ids: string[]): string {
  return ids
    .map((id) => state.classes.find((c) => c.id === id)?.name || id)
    .join(" / ");
}
export function eligible(
  state: AppState,
  course: Course,
  memberId: string,
  week: number,
): boolean {
  const member = state.members.find((m) => m.id === memberId && m.active);
  const av = state.availability.find(
    (a) =>
      a.memberId === memberId &&
      a.semesterId === course.semesterId &&
      a.week === week,
  );
  return (
    !!member &&
    !!member.classId &&
    !!av &&
    !course.classIds.includes(member.classId) &&
    (participatesByDefault(member.role) || av.optedIn) &&
    slotsFor(course).every((slot) => av.slots.includes(slot))
  );
}

// Additive lexicographic costs: no scalar weights, so lower-priority totals
// cannot outweigh even one unit of a higher-priority objective.
// Administrative coverage, grade, class/member rotation, early class,
// then people with >=2 options, then total distinct options (both maximized).
type Cost = [number, number, number, number, number, number, number];
const zeroCost = (): Cost => [0, 0, 0, 0, 0, 0, 0];
function plusCost(a: Cost, b: Cost): Cost {
  return a.map((value, i) => {
    const sum = value + b[i];
    if (!Number.isSafeInteger(sum)) throw new Error("排班规模超出安全计算范围");
    return sum;
  }) as Cost;
}
function lessCost(a: Cost, b: Cost): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
// Within the selected week, duplicate IDs or identical class/teacher/lesson/
// place/time entries represent one choice. Counts/labels do not create options.
function uniqueWeeklyCourses(courses: Course[]): Course[] {
  const ids = new Map<string, string>(), lessons = new Set<string>();
  return courses.filter(c => {
    const key = JSON.stringify([c.semesterId, c.classIds.slice().sort(), c.name,
      c.teacher, c.classroom, c.weekday, c.start, c.end]);
    if (ids.has(c.id) && ids.get(c.id) !== key) throw new Error("同一课程标识对应不同课程，请核对课表");
    ids.set(c.id, key);
    if (lessons.has(key)) return false;
    lessons.add(key);
    return true;
  });
}

// Maximum cardinality matching still comes first; disjoint class groups
// preserve administrative coverage via the first cost component.
export function generatePlan(
  state: AppState,
  semesterId: string,
  week: number,
  revision: number,
  priorityGrade = "",
): Plan {
  const semester = state.semesters.find((s) => s.id === semesterId);
  if (!semester || week < 1 || week > semester.weeks)
    throw new Error("请选择有效周次");
  const courses = uniqueWeeklyCourses(state.courses.filter(
    (c) =>
      c.semesterId === semesterId &&
      c.weeks.includes(week) &&
      c.classIds.some((id) =>
        semester.grades.map(grade => classGrade({grade})).includes(
          classGrade(state.classes.find((k) => k.id === id) || {}),
        ),
      ),
  ));
  const groups: { key: string; courses: Course[] }[] = [];
  courses.forEach((c) => {
    const key = c.classIds.slice().sort().join("|");
    const existing = groups.find((g) => g.key === key);
    if (existing) existing.courses.push(c);
    else groups.push({ key, courses: [c] });
  });
  const overlapping = groups.some((g, i) =>
    groups
      .slice(i + 1)
      .some((h) =>
        g.courses[0].classIds.some((id) => h.courses[0].classIds.includes(id)),
      ),
  );
  if (overlapping)
    throw new Error("同一行政班存在交叉合班，请先统一教学班覆盖口径后生成");
  const members = state.members.filter((m) => m.active);
  // 仅已完成听课用于轮换，不将草稿当作已听课。
  const previous = state.records.filter(
    (r) => r.semesterId === semesterId && r.week === week - 1,
  );
  const previousClasses = new Set(previous.flatMap((r) => r.course.classIds));
  const previousMembers = new Set(previous.map((r) => r.memberId));
  const largestGroup = Math.max(1, ...groups.map(g => g.courses[0].classIds.length));
  // A simple residual path uses at most |V|-1 edges; each component is an
  // integer bounded by max(group size, options). Check sums again on relaxation.
  if (!Number.isSafeInteger((groups.length + members.length + 1) * Math.max(largestGroup, courses.length, 1)))
    throw new Error("排班规模超出安全计算范围");
  type Edge = {
    to: number;
    rev: number;
    cap: number;
    cost: Cost;
    course?: Course;
    options?: Course[];
  };
  const source = 0,
    groupOffset = 1,
    memberOffset = 1 + groups.length,
    sink = memberOffset + members.length;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const add = (
    from: number,
    to: number,
    cost: Cost,
    course?: Course,
    options?: Course[],
  ): void => {
    const forward: Edge = { to, rev: graph[to].length, cap: 1, cost, course, options };
    const reverse: Edge = {
      to: from,
      rev: graph[from].length,
      cap: 0,
      cost: cost.map(value => -value) as Cost,
    };
    graph[from].push(forward);
    graph[to].push(reverse);
  };
  groups.forEach((g, gi) => {
    const repeated = g.courses[0].classIds.some((id) =>
      previousClasses.has(id),
    );
    const preferred = !priorityGrade || g.courses[0].classIds.some(id => classGrade(state.classes.find(c => c.id === id) || {}) === priorityGrade);
    add(source, groupOffset + gi, [largestGroup - g.courses[0].classIds.length, preferred ? 0 : 1, repeated ? 1 : 0, 0, 0, 0, 0]);
    for (let j = 0; j < members.length; j++) {
      const mi = (j + revision) % members.length;
      const options = g.courses.filter((c) =>
        eligible(state, c, members[mi].id, week),
      );
      options.sort((a,b) => Number(isEarlyCourse(a)) - Number(isEarlyCourse(b)) || a.weekday-b.weekday || a.start-b.start || a.id.localeCompare(b.id));
      const best = options.filter(c => isEarlyCourse(c) === isEarlyCourse(options[0] || {start:0}));
      const recommended = best[revision % best.length];
      if (options.length)
        add(
          groupOffset + gi,
          memberOffset + mi,
          [0, 0, 0, previousMembers.has(members[mi].id) ? 1 : 0, Number(isEarlyCourse(recommended)), options.length >= 2 ? -1 : 0, -options.length],
          recommended, options,
        );
    }
  });
  members.forEach((_, mi) => add(memberOffset + mi, sink, zeroCost()));
  while (true) {
    const distance: (Cost | null)[] = graph.map(() => null);
    const parentNode = graph.map(() => -1), parentEdge = graph.map(() => -1);
    distance[source] = zeroCost();
    for (let round = 0; round < graph.length - 1; round++) {
      let changed = false;
      graph.forEach((edges, from) =>
        edges.forEach((edge, ei) => {
          const previous = distance[from];
          if (!edge.cap || !previous) return;
          const candidate = plusCost(previous, edge.cost), current = distance[edge.to];
          if (!current || lessCost(candidate, current)) {
            distance[edge.to] = candidate;
            parentNode[edge.to] = from;
            parentEdge[edge.to] = ei;
            changed = true;
          }
        }),
      );
      if (!changed) break;
    }
    if (parentNode[sink] < 0) break;
    for (let at = sink; at !== source; at = parentNode[at]) {
      const edge = graph[parentNode[at]][parentEdge[at]];
      edge.cap = 0;
      graph[at][edge.rev].cap = 1;
    }
  }
  const tasks: Task[] = [],
    uncovered: Plan["uncovered"] = [];
  groups.forEach((g, gi) => {
    const edge = graph[groupOffset + gi].find((e) => e.course && e.cap === 0);
    if (edge?.course) {
      const member = members[edge.to - memberOffset];
      tasks.push({
        id: semesterId + "-w" + week + "-v" + revision + "-" + gi,
        memberId: member.id,
        memberName: member.name,
        course: JSON.parse(JSON.stringify(edge.course)),
        candidateCourses: JSON.parse(JSON.stringify(edge.options)),
        classLabel: classLabel(state, edge.course.classIds),
      });
    } else
      uncovered.push({
        label: classLabel(state, g.courses[0].classIds),
        reason: graph[groupOffset + gi].some((e) => e.course)
          ? "可用成员已分配，每人每周最多一次"
          : "没有满足非本班、完整无课时段的成员",
      });
  });
  return {
    semesterId,
    week,
    revision,
    status: "draft",
    tasks,
    uncovered,
    createdAt: new Date().toISOString(),
  };
}
