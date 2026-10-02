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

// 最大流保证教学班覆盖数量；最小费用依次优化班级轮换和成员轮换。
// 首版以不重叠教学班为覆盖单位，完整连续节次为一次任务。
export function generatePlan(
  state: AppState,
  semesterId: string,
  week: number,
  revision: number,
): Plan {
  const semester = state.semesters.find((s) => s.id === semesterId);
  if (!semester || week < 1 || week > semester.weeks)
    throw new Error("请选择有效周次");
  const courses = state.courses.filter(
    (c) =>
      c.semesterId === semesterId &&
      c.weeks.includes(week) &&
      c.classIds.some((id) =>
        semester.grades.includes(
          state.classes.find((k) => k.id === id)?.grade || "",
        ),
      ),
  );
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
  type Edge = {
    to: number;
    rev: number;
    cap: number;
    cost: number;
    course?: Course;
  };
  const source = 0,
    groupOffset = 1,
    memberOffset = 1 + groups.length,
    sink = memberOffset + members.length;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const add = (
    from: number,
    to: number,
    cost: number,
    course?: Course,
  ): void => {
    const forward: Edge = { to, rev: graph[to].length, cap: 1, cost, course };
    const reverse: Edge = {
      to: from,
      rev: graph[from].length,
      cap: 0,
      cost: -cost,
    };
    graph[from].push(forward);
    graph[to].push(reverse);
  };
  groups.forEach((g, gi) => {
    const repeated = g.courses[0].classIds.some((id) =>
      previousClasses.has(id),
    );
    add(source, groupOffset + gi, repeated ? members.length + 1 : 0);
    for (let j = 0; j < members.length; j++) {
      const mi = (j + revision) % members.length;
      const options = g.courses.filter((c) =>
        eligible(state, c, members[mi].id, week),
      );
      if (options.length)
        add(
          groupOffset + gi,
          memberOffset + mi,
          previousMembers.has(members[mi].id) ? 1 : 0,
          options[revision % options.length],
        );
    }
  });
  members.forEach((_, mi) => add(memberOffset + mi, sink, 0));
  while (true) {
    const distance = graph.map(() => Infinity),
      parentNode = graph.map(() => -1),
      parentEdge = graph.map(() => -1);
    distance[source] = 0;
    for (let round = 0; round < graph.length - 1; round++) {
      let changed = false;
      graph.forEach((edges, from) =>
        edges.forEach((edge, ei) => {
          if (edge.cap && distance[from] + edge.cost < distance[edge.to]) {
            distance[edge.to] = distance[from] + edge.cost;
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
