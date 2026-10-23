import { Cell, SheetData } from './xlsx';
const formula=(formula:string,value:string|number):Cell=>({formula,value});
export const cellValue=(cell:Cell|undefined):string|number=>cell===null || cell===undefined ? '' : typeof cell==='object'?cell.value:cell;
export const CHART_COLORS={blue:'2E75B6',orange:'ED7D31',red:'C00000'};
/** Keep one observation per bar. Only abbreviate repeated grade/major prefixes. */
export function chartClassLabel(reference:string,label:string,grade=''):Cell {
  let expression=reference,value=label;
  const replace=(from:string,to:string)=>{
    expression=`SUBSTITUTE(${expression},"${from.replace(/"/g,'""')}","${to.replace(/"/g,'""')}")`;
    value=value.split(from).join(to);
  };
  replace(' ','');replace('／','/');replace('班','');
  const parts=value.split('/'),matches=parts.map(part=>part.match(/^(\d{4}|\d{2})([^\d]+)(\d+)$/));
  if(matches.length>1 && matches.every(m=>m && m[1]===matches[0]?.[1] && m[2]===matches[0]?.[2]))
    replace('/'+matches[0]![1]+matches[0]![2],'/');
  if(grade) {
    const escaped=grade.replace(/"/g,'""');
    expression=`IF(LEFT(${expression},${grade.length})="${escaped}",MID(${expression},${grade.length+1},32767),${expression})`;
    if(value.startsWith(grade))value=value.slice(grade.length);
  }
  return formula(`IF(${reference}="","",${expression})`,value);
}
export function chartBand(rate:number|null,attendance:boolean):'blue'|'orange'|'red'|'missing' {
  if(rate===null || !Number.isFinite(rate) || rate<0)return 'missing';
  return attendance ? rate>=.95?'blue':rate>=.85?'orange':'red' : rate<=.05?'blue':rate<=.15?'orange':'red';
}
/** Standard Excel formulas (no dynamic-array or macro requirement), with stable tie breaking. */
export function linkedCharts(source:SheetData,grades:string[],week:number,metricColumns:string[],gradeColumn='A',labelColumn='B'):SheetData[] {
  const count=source.rows.length-3,end=source.rows.length,quoted="'"+source.name.replace(/'/g,"''")+"'";
  const get=(column:string,row:number)=>quoted+'!'+column+row;
  const index=(letters:string)=>letters.split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
  const groups=[{name:'各班级',grade:''},...grades.map(grade=>({name:grade+'级',grade}))];
  return groups.flatMap(group=>['出勤情况','违纪情况','迟到情况'].map((name,mi)=>{
    const column=metricColumns[mi];
    const candidates=source.rows.slice(3).map((row,i)=>{
      const metric=cellValue(row[index(column)]),grade=String(cellValue(row[index(gradeColumn)]));
      return {label:String(cellValue(chartClassLabel(get(labelColumn,i+4),String(cellValue(row[index(labelColumn)])),group.grade))),value:typeof metric==='number'&&metric>=0&&(!group.grade || grade===group.grade)?metric:null,index:i};
    });
    const sorted=candidates.filter(r=>r.value!==null).sort((a,b)=>b.value!-a.value! || a.index-b.index);
    const rows:Cell[][]=[[group.name+name],[`第${week}周 · 修改原始数据后图表自动更新；缺失不记零`],['听课班级',mi===0?'出勤率':mi===1?'违纪率（行为人次）':'迟到率','','','','','','','','','','','来源班级','有效指标','排序序号','蓝色','橙色','红色']];
    for(let i=0;i<count;i++){
      const r=i+4,raw=source.rows[i+3];
      const metric=get(column,r),grade=group.grade?`,${get(gradeColumn,r)}="${group.grade.replace(/"/g,'""')}"`:'';
      const value=candidates[i].value;
      const rank=value===null?'':sorted.findIndex(v=>v.index===i)+1;
      rows.push([
        formula(`IFERROR(INDEX($M$4:$M$${end},MATCH(ROW()-3,$O$4:$O$${end},0)),"")`,sorted[i]?.label || ''),
        formula(`IFERROR(INDEX($N$4:$N$${end},MATCH(ROW()-3,$O$4:$O$${end},0)),"")`,sorted[i]?.value ?? ''),
        ...Array<Cell>(10).fill(null),
        chartClassLabel(get(labelColumn,r),String(cellValue(raw[index(labelColumn)])),group.grade),
        formula(`IF(AND(ISNUMBER(${metric}),${metric}>=0${grade}),${metric},"")`,value??''),
        formula(`IF(ISNUMBER(N${r}),COUNTIF($N$4:$N$${end},">"&N${r})+COUNTIF($N$4:N${r},N${r}),"")`,rank),
        ...(['blue','orange','red'] as const).map(band=>{
          const q=`B${r}`,condition=mi===0 ? band==='blue'?`${q}>=0.95`:band==='orange'?`AND(${q}>=0.85,${q}<0.95)`:`${q}<0.85` : band==='blue'?`${q}<=0.05`:band==='orange'?`AND(${q}>0.05,${q}<=0.15)`:`${q}>0.15`;
          const active=sorted[i] && chartBand(sorted[i].value,mi===0)===band;
          // #N/A deliberately omits inactive series points, including their labels.
          return {formula:`IF(AND(ISNUMBER(B${r}),${condition}),B${r},NA())`,value:active?sorted[i].value!:'#N/A',error:!active};
        }),
      ]);
    }
    return {name:group.name+name,chart:true,chartPercent:true,hiddenColumns:[12,13,14,15,16,17],percentColumns:[1,13,15,16,17],chartSeries:[...(['blue','orange','red'] as const).map((band,i)=>({name:group.name+name,column:15+i,color:CHART_COLORS[band],labels:false})),{name:group.name+name,column:1,color:'',labels:true}],rows};
  }));
}
