import test from 'node:test';
import assert from 'node:assert/strict';
import { chartBand,chartClassLabel,cellValue } from '../miniprogram/domain/report-charts';
import { exportXlsx,reportSheets } from '../miniprogram/domain/reports';
import { weeklyChartFixture } from './helpers/weekly-charts';

function entries(buffer:ArrayBuffer) {
  const b=Buffer.from(buffer),files=new Map<string,string>();let at=0;
  while(b.readUInt32LE(at)===0x04034b50) {
    const size=b.readUInt32LE(at+18),nameSize=b.readUInt16LE(at+26),extra=b.readUInt16LE(at+28),start=at+30+nameSize+extra;
    files.set(b.subarray(at+30,at+30+nameSize).toString(),b.subarray(start,start+size).toString());at=start+size;
  }
  return files;
}
test('图表区间准确覆盖临界点，缺失不着色，行为人次超过100%仍标红',()=>{
  assert.deepEqual([0,.8499,.85,.9499,.95,1].map(v=>chartBand(v,true)),['red','red','orange','orange','blue','blue']);
  assert.deepEqual([0,.05,.0501,.15,.1501,1,1.2].map(v=>chartBand(v,false)),['blue','blue','orange','orange','red','red','red']);
  for(const v of [null,-1,NaN])assert.equal(chartBand(v,false),'missing');
});
test('同专业合班简写，跨专业不误合并，年级动态处理',()=>{
  assert.equal(cellValue(chartClassLabel('B4','24软工中外3班 / 24软工中外4班','24')),'软工中外3/4');
  assert.equal(cellValue(chartClassLabel('B4','27自动化1班 / 27自动化2班')),'27自动化1/2');
  assert.equal(cellValue(chartClassLabel('B4','27自动化1班 / 28计科2班')),'27自动化1/28计科2');
  assert.equal(cellValue(chartClassLabel('B4','2028自动化1班 / 2028自动化2班','2028')),'自动化1/2');
});
test('所有图使用比例并保持每条观测，颜色源跟随排序公式，零值仅一根柱',()=>{
  const sheets=reportSheets(weeklyChartFixture(),8);
  const attendance=sheets.find(s=>s.name==='24级出勤情况')!;
  assert.equal(cellValue(attendance.rows[3][1]),1);
  assert.equal(cellValue(attendance.rows[11][0]),'软工中外3/4');
  assert.equal(cellValue(attendance.rows[11][1]),46/58);
  const boundary=sheets.find(s=>s.name==='25级出勤情况')!;
  assert.equal(boundary.rows.filter(r=>cellValue(r[0])==='边界乙1').length,2);
  for(const sheet of sheets.filter(s=>s.chart)) {
    assert.equal(sheet.chartPercent,true);
    for(const row of sheet.rows.slice(3)) {
      const values=row.slice(15,18).map(cellValue),active=values.filter(v=>typeof v==='number');
      assert.deepEqual(active,typeof cellValue(row[1])==='number'?[cellValue(row[1])]:[]);
      assert.ok(row.slice(15,18).every(c=>typeof c==='object'&&c!==null&&c.formula.includes('ISNUMBER(B')));
    }
  }
  const allLate=sheets.find(s=>s.name==='各班级迟到情况')!;
  assert.equal(allLate.rows[2][1],'迟到率');
  assert.equal(cellValue(allLate.rows[3][1]),8/46,'按比例排序，不按人数1501排序');
  const late26=sheets.find(s=>s.name==='26级迟到情况')!;
  assert.equal(late26.rows.filter(r=>typeof cellValue(r[1])==='number').length,1,'零分母不画作0%');
});
test('实际导出含三色原生系列和透明标签系列、双无填充无线条与动态范围',()=>{
  const files=entries(exportXlsx(weeklyChartFixture(),8));
  const charts=[...files].filter(([name])=>name.startsWith('xl/charts/'));
  assert.equal(charts.length,12);
  for(const [,xml] of charts) {
    assert.equal((xml.match(/<c:ser>/g)||[]).length,4);
    assert.equal((xml.match(/<c:showVal val="1"/g)||[]).length,1,'只有完整有效值系列显示标签，WPS不显示辅助系列的#N/A');
    for(const color of ['C00000','ED7D31','2E75B6'])assert.match(xml,new RegExp(`srgbClr val="${color}"`));
    assert.match(xml,/<c:dLblPos val="outEnd"/);assert.match(xml,/<c:showVal val="1"/);
    assert.match(xml,/formatCode="0.00%"/);assert.doesNotMatch(xml,/次观测|模拟课程/);
    assert.match(xml,/<c:spPr><a:noFill\/><a:ln><a:noFill\/><\/a:ln><\/c:spPr><\/c:plotArea>/);
    assert.match(xml,/<c:spPr><a:noFill\/><a:ln><a:noFill\/><\/a:ln><\/c:spPr><\/c:chartSpace>/);
    assert.match(xml,/<c:overlap val="100"/);assert.match(xml,/<c:plotVisOnly val="0"/);
  }
  assert.match(files.get('xl/workbook.xml')!,/OFFSET\(/);
  assert.match(files.get('xl/worksheets/sheet2.xml')!,/t="e"><f>[^<]*NA\(\)/);
  assert.match(files.get('xl/drawings/drawing2.xml')!,/<xdr:oneCellAnchor>/);
});
