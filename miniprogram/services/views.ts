import { AppState, Course, Task } from "../domain/types";
import { classLabel } from "../domain/scheduler";
import { courseTime } from "../domain/calendar";
export function courseView(state: AppState, c: Course) {
  return {
    ...c,
    classLabel: classLabel(state, c.classIds),
    timeLabel: courseTime(c),
    weekLabel: c.weeks.length + "个教学周",
    grade: state.classes.find((k) => k.id === c.classIds[0])?.grade || "",
  };
}
export function taskView(state: AppState, task: Task, owner = "") {
  const record = state.records.find((r) => r.taskId === task.id);
  return {
    ...task,
    timeLabel: courseTime(task.course),
    done: !!record,
    mine: task.memberId === owner,
    recordId: record?.id || "",
  };
}
