import { METRIC_FIELDS, Metrics } from "./types";
export function missingMetrics(): Metrics {
  return {
    expected: -1,
    actual: -1,
    late: -1,
    early: -1,
    sleep: -1,
    phone: -1,
    talk: -1,
    other: -1,
  };
}
export function ratio(n: number, d: number): number | null {
  return n < 0 || d <= 0 ? null : n / d;
}
export function percent(value: number | null): string {
  return value === null ? "信息缺失" : (value * 100).toFixed(1) + "%";
}
export function discipline(m: Metrics): number {
  return [m.sleep, m.phone, m.talk].some((v) => v < 0)
    ? -1
    : m.sleep + m.phone + m.talk;
}
export function validateMetrics(m: Metrics): void {
  for (const f of METRIC_FIELDS)
    if (!Number.isInteger(m[f.key]) || m[f.key] < -1 || m[f.key] > 10000)
      throw new Error(f.label + "应为非负整数，或标记信息缺失");
  if (m.actual >= 0 && m.expected >= 0 && m.actual > m.expected)
    throw new Error("实到人数不能大于应到人数，请核对");
  for (const key of ["late", "sleep", "phone", "talk", "other"] as const)
    if (m.actual >= 0 && m[key] > m.actual)
      throw new Error("单项人数不能超过实到人数");
  if (m.expected >= 0 && m.early > m.expected)
    throw new Error("早退人数不能超过应到人数");
}
