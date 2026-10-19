/** Display/selection key only; stored class data is never rewritten. */
export function classGrade(value: { grade?: unknown; name?: unknown }): string {
  const grade = String(value.grade ?? '').trim();
  return grade ? (/^20\d{2}$/.test(grade) ? grade.slice(2) : grade) : String(value.name ?? '').match(/^\d{2}/)?.[0] || '';
}
/** The first configured teaching period is the early class; no clock time assumed. */
export function isEarlyCourse(course: { start: number }): boolean { return course.start === 1; }
export function sameClasses(a: string[], b: string[]): boolean {
  return a.length === b.length && a.slice().sort().every((id, i) => id === b.slice().sort()[i]);
}
