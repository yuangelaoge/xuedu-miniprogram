/** Timetable count, never an observation or a per-administrative-class roster count. */
export function courseHeadcount(value: unknown): number | '未填写' {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : '未填写';
}
export function courseHeadcountText(value: unknown): string {
  const count = courseHeadcount(value);
  return typeof count === 'number' ? count + ' 人' : count;
}
