import { Cell, SheetData } from './xlsx';
const formula=(formula:string,value:string|number):Cell=>({formula,value});
export const cellValue=(cell:Cell|undefined):string|number=>cell===null || cell===undefined ? '' : typeof cell==='object'?cell.value:cell;
/** Standard Excel formulas (no dynamic-array or macro requirement), with stable tie breaking. */
export function linkedCharts(source:SheetData,grades:string[],week:number,metricColumns:string[],countsColumn:string,gradeColumn='A',labelColumn='B'):SheetData[] {
  const count=source.rows.length-3,end=source.rows.length,quoted="'"+source.name.replace(/'/g,"''")+"'";
  const get=(column:string,row:number)=>quoted+'!'+column+row;
  const index=(letters:string)=>letters.split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
  const groups=[{name:'各班级',grade:''},...grades.map(grade=>({name:grade+'级',grade}))];
  return groups.flatMap((group,gi)=>['出勤情况','违纪情况','迟到情况'].map((name,mi)=>{
    const column=mi===2&&gi===0?countsColumn:metricColumns[mi],pct=!(mi===2&&gi===0);
    const candidates=source.rows.slice(3).map((row,i)=>{
      const metric=cellValue(row[index(column)]),grade=String(cellValue(row[index(gradeColumn)]));
      return {label:String(cellValue(row[index(labelColumn)])),value:typeof metric==='number'&&metric>=0&&(!group.grade || grade===group.grade)?metric:null,index:i};
    });
    const sorted=candidates.filter(r=>r.value!==null).sort((a,b)=>b.value!-a.value! || a.index-b.index);
    const rows:Cell[][]=[[group.name+name],[`第${week}周 · 修改来源数据后自动重算；空白表示缺失或不适用`],['听课班级',pct?(mi===0?'出勤率':mi===1?'违纪率（行为人次）':'迟到率'):'迟到人数','','','','','','','','','','','来源班级','有效指标','排序序号']];
    for(let i=0;i<count;i++){
      const r=i+4,raw=source.rows[i+3];
      const metric=get(column,r),grade=group.grade?`,${get(gradeColumn,r)}="${group.grade.replace(/"/g,'""')}"`:'';
      const value=candidates[i].value;
      const rank=value===null?'':sorted.findIndex(v=>v.index===i)+1;
      rows.push([
        formula(`IFERROR(INDEX($M$4:$M$${end},MATCH(ROW()-3,$O$4:$O$${end},0)),"")`,sorted[i]?.label || ''),
        formula(`IFERROR(INDEX($N$4:$N$${end},MATCH(ROW()-3,$O$4:$O$${end},0)),"")`,sorted[i]?.value ?? ''),
        ...Array<Cell>(10).fill(null),
        formula(`IF(${get(labelColumn,r)}="","",${get(labelColumn,r)})`,String(cellValue(raw[index(labelColumn)]))),
        formula(`IF(AND(ISNUMBER(${metric}),${metric}>=0${grade}),${metric},"")`,value??''),
        formula(`IF(ISNUMBER(N${r}),COUNTIF($N$4:$N$${end},">"&N${r})+COUNTIF($N$4:N${r},N${r}),"")`,rank),
      ]);
    }
    return {name:group.name+name,chart:true,chartPercent:pct,rows};
  }));
}
