import { AppState, Availability, Observation, Semester } from "./types";
import { actor, audit, confirm, generate, requireRole, saveAvailability, skip, submitRecord } from "./actions";
import { addSemester, commitImport } from "./imports";
import { applyForMembership, JoinForm, removeMember, reviewApplications, setMemberRole } from "./membership";

export type Command =
  | { type: "join"; form: JoinForm }
  | { type: "availability"; value: Availability }
  | { type: "generate"; week: number }
  | { type: "confirm"; week: number; revision: number }
  | { type: "skip"; week: number; reason: string }
  | { type: "review"; ids: string[]; decision: "approved" | "rejected"; reason: string }
  | { type: "removeMember"; id: string }
  | { type: "role"; id: string; role: "leader" | "member" }
  | { type: "import"; text: string }
  | { type: "restoreAdminClass"; classId: string }
  | { type: "renameUnusedClass"; id: string; name: string }
  | { type: "semester"; id: string }
  | { type: "createSemester"; value: Semester }
  | { type: "submit"; record: Observation };

// 调用者身份在服务端确定后才调用；绝不接受客户端整份 state 覆盖云端。
export function executeCommand(state: AppState, command: Command, identity: string): void {
  switch (command.type) {
    case "join": applyForMembership(state, identity, command.form); return;
    case "availability": saveAvailability(state, command.value); return;
    case "generate": generate(state, command.week); return;
    case "confirm": confirm(state, command.week, command.revision); return;
    case "skip": skip(state, command.week, command.reason); return;
    case "review": reviewApplications(state, command.ids, command.decision, command.reason); return;
    case "removeMember": removeMember(state, command.id); return;
    case "role": setMemberRole(state, command.id, command.role); return;
    case "import": commitImport(state, "courses", command.text); return;
    case "restoreAdminClass": {
      requireRole(state, ["admin"]);
      const user = actor(state);
      if (user.classId) throw new Error("本人班级已设置，不能通过换届入口修改");
      const schoolClass = state.classes.find(c => c.id === command.classId);
      if (!schoolClass) throw new Error("请选择已导入的本人真实班级");
      user.classId = schoolClass.id;
      audit(state, "设置管理员本人班级", schoolClass.name);
      return;
    }
    case "renameUnusedClass": {
      requireRole(state, ["admin"]);
      const c = state.classes.find(c => c.id === command.id);
      if (!c || typeof command.name !== "string" || !command.name.trim() || command.name.length > 60) throw new Error("班级名称无效");
      // Only correct newly initialized classes; do not rewrite historical course/record labels.
      if (state.courses.some(x => x.classIds.includes(c.id)) ||
        state.plans.concat(state.drafts).some(p => p.tasks.concat(p.cancelledTasks || []).some(t => t.course.classIds.includes(c.id))) ||
        state.records.some(r => r.course.classIds.includes(c.id))) throw new Error("班级已有课程或历史记录，需使用带历史保护的变更流程");
      const name = command.name.trim();
      if (state.classes.some(x => x.id !== c.id && x.grade === c.grade && x.name === name)) throw new Error("班级名称重复");
      if (c.name === name) return;
      audit(state, "修正初始化班级名称", c.name + " → " + name);
      c.name = name;
      return;
    }
    case "createSemester": addSemester(state, command.value); return;
    case "semester":
      requireRole(state, ["admin"]);
      if (!state.semesters.some(s => s.id === command.id)) throw new Error("学期不存在");
      state.activeSemesterId = command.id; return;
    case "submit": submitRecord(state, command.record); return;
    default: throw new Error("不支持此操作");
  }
}
