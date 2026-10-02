/** This DTO contains class-level totals only: no observations, people, notes or photos. */
export interface SummaryRow {
  key: string; label: string; grade: string; count: number;
  attendanceValid: number; expected: number; actual: number;
  disciplineValid: number; discipline: number; disciplineActual: number;
  lateValid: number; late: number; lateRateValid: number; lateRate: number; lateActual: number;
}
export interface SummaryReport {
  semester: {name:string;edition:string;grades:string[]}; week:number; skipped:boolean; rows:SummaryRow[];
}
