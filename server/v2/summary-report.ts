import { Entity } from '../../miniprogram/domain/v2/protocol';
import { SummaryReport, SummaryRow } from '../../miniprogram/domain/v2/summary-report';
import { Metrics } from '../../miniprogram/domain/types';
import { discipline } from '../../miniprogram/domain/metrics';
export function summarizeEntities(semester:Entity,week:number,records:Entity[],skipped:boolean):SummaryReport {
  const groups=new Map<string,SummaryRow>();
  for(const record of records) {
    const classes=(record.data.classes || []) as {id:string;grade:string}[];
    // A combined teaching group is counted once, including mixed-grade groups.
    const grade=Array.from(new Set(classes.map(c=>c.grade))).sort().join('/');
    const key=classes.map(c=>c.id).sort().join('|') || String(record.data.classLabel || '未标注班级');
    const groupKey=grade+':'+key;
    const row=groups.get(groupKey) || {key:groupKey,label:String(record.data.classLabel || '未标注班级'),grade,count:0,
      attendanceValid:0,expected:0,actual:0,disciplineValid:0,discipline:0,disciplineActual:0,
      lateValid:0,late:0,lateRateValid:0,lateRate:0,lateActual:0};
    row.count++;
    const m=record.data.metrics as Metrics,d=discipline(m);
    if(m.expected>0 && m.actual>=0){row.attendanceValid++;row.expected+=m.expected;row.actual+=m.actual;}
    if(d>=0 && m.actual>0){row.disciplineValid++;row.discipline+=d;row.disciplineActual+=m.actual;}
    if(m.late>=0){row.lateValid++;row.late+=m.late;}
    if(m.late>=0 && m.actual>0){row.lateRateValid++;row.lateRate+=m.late;row.lateActual+=m.actual;}
    groups.set(groupKey,row);
  }
  return {semester:{name:String(semester.data.name || ''),edition:String(semester.data.edition || ''),
    grades:Array.from(new Set([...(semester.data.grades as string[] || []),...Array.from(groups.values()).map(r=>r.grade)])).filter(Boolean)},
    week,skipped,rows:Array.from(groups.values()).sort((a,b)=>a.key.localeCompare(b.key))};
}
