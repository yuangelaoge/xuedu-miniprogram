import { SummaryReport } from './v2/summary-report';
import { Cell, createXlsx, SheetData } from './xlsx';
import { linkedCharts } from './report-charts';
export function summaryGradeStats(report:SummaryReport){
 return report.semester.grades.map(grade=>{
  const rows=report.rows.filter(r=>r.grade===grade),count=rows.reduce((n,r)=>n+r.count,0),valid=rows.reduce((n,r)=>n+r.attendanceValid,0);
  const expected=rows.reduce((n,r)=>n+r.expected,0),actual=rows.reduce((n,r)=>n+r.actual,0);
  return {grade,count,valid,expected,actual,rate:valid&&expected>0?actual/expected:null};
 });
}
export function summarySheets(report:SummaryReport):SheetData[]{
 const rows:Cell[][]=[
  [`${report.semester.edition} ${report.semester.name} 第${report.week}周听课汇总（仅统计）`],
  [report.skipped?'本周已跳过；不计漏交或零出勤':'仅含教学班汇总；合班只计一次，跨年级合班单列；无个人原始明细'],
  ['年级','听课班级','观测次数','有效出勤次数','有效应到人次','有效实到人次','有效违纪次数','违纪行为人次','违纪有效实到','有效迟到人数次数','迟到人数','有效迟到率次数','迟到率有效人数','迟到率有效实到','出勤率','违纪率','迟到率'],
 ];
 for(const g of report.rows){
  const r=rows.length+1;
  const ratio=(valid:string,n:string,d:string,count:number,numerator:number,den:number):Cell=>({formula:`IF(AND(${valid}${r}>0,COUNT(${n}${r},${d}${r})=2,${n}${r}>=0,${d}${r}>0),${n}${r}/${d}${r},"")`,value:count>0&&den>0?numerator/den:''});
  rows.push([g.grade,g.label,g.count,g.attendanceValid,g.expected,g.actual,g.disciplineValid,g.discipline,g.disciplineActual,g.lateValid,g.lateValid?g.late:-1,g.lateRateValid,g.lateRate,g.lateActual,
   ratio('D','F','E',g.attendanceValid,g.actual,g.expected),ratio('G','H','I',g.disciplineValid,g.discipline,g.disciplineActual),ratio('L','M','N',g.lateRateValid,g.lateRate,g.lateActual)]);
 }
 const source:SheetData={name:'汇总基础数据',rows,percentColumns:[14,15,16]};
 return [source,...linkedCharts(source,report.semester.grades,report.week,['O','P','Q'],'K')];
}
export function exportSummaryXlsx(report:SummaryReport):ArrayBuffer {return createXlsx(summarySheets(report));}
