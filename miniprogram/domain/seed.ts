import { AppState, Course, Semester } from "./types";
import { boundedWeek } from "./calendar";
import { generatePlan } from "./scheduler";

export function createSeed(): AppState {
  const semester: Semester = {
    id: "2026-fall",
    name: "2026–2027 第一学期",
    startDate: "2026-09-07",
    weeks: 20,
    grades: ["24", "25", "26"],
    days: 5,
    periods: 14,
    edition: "学风督察小组",
  };
  const classes = [
    { id: "24-cs1", grade: "24", major: "计算机科学与技术", name: "24计科1班" },
    { id: "24-se1", grade: "24", major: "软件工程", name: "24软工1班" },
    { id: "25-cs1", grade: "25", major: "计算机科学与技术", name: "25计科1班" },
    { id: "25-te1", grade: "25", major: "计算机师范", name: "25计师1班" },
    { id: "26-ai1", grade: "26", major: "人工智能", name: "26人工智能1班" },
    { id: "26-au1", grade: "26", major: "自动化", name: "26自动化1班" },
  ];
  const names = [
    "林知夏",
    "陈屿",
    "许星禾",
    "周景行",
    "苏予安",
    "江书宁",
    "顾南乔",
    "陆言",
  ];
  const members = names.map((name, i) => ({
    id: "m" + i,
    name,
    studentNo: "DEMO" + String(i + 1).padStart(4, "0"),
    classId: classes[i % classes.length].id,
    role: (i === 6 ? "leader" : i === 7 ? "admin" : "member") as
      | "leader"
      | "admin"
      | "member",
    active: true,
  }));
  const titles = [
    "数据库系统",
    "软件工程",
    "数据结构",
    "离散数学",
    "人工智能导论",
    "高等数学 A",
  ];
  const courses: Course[] = classes.map((c, i) => ({
    id: "c" + i,
    semesterId: semester.id,
    name: titles[i],
    teacher: ["张老师", "李老师", "王老师"][i % 3],
    nature: i === 4 ? "专业选修" : "专业必修",
    classIds: [c.id],
    classroom: ["第25教学楼 301", "第26教学楼 402", "第25教学楼 205"][i % 3],
    weekday: (i % 5) + 1,
    start: i % 2 ? 5 : 3,
    end: i % 2 ? 6 : 4,
    weeks: Array.from({ length: 20 }, (_, j) => j + 1),
    expected: 35 + i * 3,
  }));
  const week = boundedWeek(semester);
  const state: AppState = {
    schema: 1,
    activeSemesterId: semester.id,
    actorId: "m0",
    semesters: [semester],
    classes,
    members,
    applications: [],
    courses,
    availability: [],
    plans: [],
    drafts: [],
    records: [],
    audit: [],
    generation: 0,
  };
  members
    .filter((m) => m.role === "member")
    .forEach((m, i) => {
      [week, Math.min(20, week + 1)]
        .filter((w, j, all) => all.indexOf(w) === j)
        .forEach((w) => {
          const slots: string[] = [];
          for (let day = 1; day <= 5; day++)
            for (let p = 1; p <= 14; p++)
              if (p >= 3 && p <= 8 && !(day === ((i + 2) % 5) + 1 && p > 6))
                slots.push(day + ":" + p);
          state.availability.push({
            memberId: m.id,
            semesterId: semester.id,
            week: w,
            slots,
            note: "",
            optedIn: false,
            updatedAt: new Date().toISOString(),
          });
        });
    });
  const plan = generatePlan(state, semester.id, week, 1);
  plan.status = "confirmed";
  plan.confirmedBy = "m6";
  plan.confirmedAt = new Date().toISOString();
  state.plans = [plan];
  state.generation = 1;
  return state;
}
