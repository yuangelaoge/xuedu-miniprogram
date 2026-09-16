import { Course, Semester } from "./types";
const DAY = 86400000;
export function parseDate(date: string): Date {
  return new Date(date + "T12:00:00+08:00");
}
export function dateString(date: Date): string {
  const china = new Date(date.getTime() + 8 * 3600000);
  return china.toISOString().slice(0, 10);
}
export function currentWeek(semester: Semester, now = new Date()): number {
  const today = parseDate(dateString(now));
  return (
    Math.floor(
      (today.getTime() - parseDate(semester.startDate).getTime()) / (DAY * 7),
    ) + 1
  );
}
export function boundedWeek(semester: Semester, now = new Date()): number {
  return Math.min(semester.weeks, Math.max(1, currentWeek(semester, now)));
}
export function weekDate(
  semester: Semester,
  week: number,
  weekday = 1,
): string {
  return dateString(
    new Date(
      parseDate(semester.startDate).getTime() +
        ((week - 1) * 7 + weekday - 1) * DAY,
    ),
  );
}
export function weekRange(semester: Semester, week: number): string {
  return (
    weekDate(semester, week).slice(5).replace("-", ".") +
    " – " +
    weekDate(semester, week, 7).slice(5).replace("-", ".")
  );
}
export const WEEKDAYS = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
];
export function courseTime(course: Course): string {
  return (
    WEEKDAYS[course.weekday - 1] +
    " · 第" +
    course.start +
    "–" +
    course.end +
    "节"
  );
}
export function slotsFor(course: Course): string[] {
  return Array.from(
    { length: course.end - course.start + 1 },
    (_, i) => course.weekday + ":" + (course.start + i),
  );
}
