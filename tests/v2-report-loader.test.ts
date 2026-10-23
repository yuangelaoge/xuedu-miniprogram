import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from '../miniprogram/config/runtime';
import {AppState, Observation, SchoolClass} from '../miniprogram/domain/types';
import {ApiRequest} from '../miniprogram/domain/v2/protocol';
import {leaveReviewLocally} from '../miniprogram/services/v2/client';
import {loadReportState} from '../miniprogram/services/v2/report-loader';

const klass=(name:string,grade='25'):SchoolClass=>({id:'c',name,grade,major:'合成专业'});
function state():AppState {
  return {schema:1,activeSemesterId:'semester',actorId:'officer',generation:0,
    semesters:[{id:'semester',name:'合成学期',startDate:'2026-08-31',weeks:18,grades:['25'],days:7,periods:14,edition:'测试'}],
    classes:[klass('当前班级')],members:[],applications:[],courses:[],availability:[],plans:[],drafts:[],records:[],audit:[]};
}
function record(id:string):Observation {
  return {id,semesterId:'semester',week:8,taskId:'t-'+id,memberId:'member-'+id,memberName:'合成成员',
    course:{id:'course',semesterId:'semester',name:'合成课程',teacher:'合成教师',nature:'专业必修',classIds:['c'],
      classroom:'合成教室',weekday:1,start:1,end:2,weeks:[8],expected:50},classLabel:'合成班级',date:'2026-10-19',
    metrics:{expected:50,actual:48,late:1,early:0,sleep:0,phone:0,talk:0,other:0},
    absentNames:'',leaveNames:'',otherDescription:'',evaluation:'',feedback:'',suggestion:'',photos:[],createdAt:'2026-10-19T02:00:00Z'};
}
interface Part {data:Record<string,unknown>;cursor?:unknown;epoch?:string;workspaceVersion?:number;error?:Error;}
const page=(records:Observation[],metadata?:AppState,cursor?:string):Part=>({data:{reportPage:true,records,version:7,...(metadata?{metadata}:{})},cursor});
const globals=globalThis as unknown as {wx:unknown};
let sequence=0;
function setup(parts:Part[]) {
  const originalWx=globals.wx,originalRuntime={...runtime},calls:ApiRequest[]=[];
  runtime.mode='cloud';runtime.env='report-loader-'+(++sequence);
  globals.wx={getStorageSync(){},removeStorageSync(){},cloud:{init(){},async callFunction({data}:{data:ApiRequest}){
    calls.push(data);const part=parts[calls.length-1];assert.ok(part,'unexpected extra network call');
    if(part.error) throw part.error;
    return {result:{ok:true,data:{protocolVersion:2,epoch:part.epoch || 'epoch',resourceVersions:{workspace:part.workspaceVersion ?? 7},data:part.data,cursor:part.cursor}}};
  }}};
  return {calls,restore(){leaveReviewLocally();globals.wx=originalWx;Object.assign(runtime,originalRuntime);}};
}

test('报表分包：35份记录完整合并，后续包固定版本，历史班级快照覆盖当前名称并重算年级',async()=>{
  const records=Array.from({length:35},(_,i)=>record('record-'+String(i).padStart(3,'0')));
  records[0].classes=[klass('第一次观测快照','24')];records[34].classes=[klass('最后一次观测快照','26')];
  const metadata=state(),h=setup([page(records.slice(0,12),metadata,'p12'),page(records.slice(12,24),undefined,'p24'),page(records.slice(24))]);
  try {
    const result=await loadReportState('excelReport','semester',8);
    assert.equal(h.calls.length,3);assert.equal(result.data.version,7);assert.equal(result.cursor,'');
    assert.deepEqual(result.data.state.records,records);assert.deepEqual(result.data.state.classes,[klass('最后一次观测快照','26')]);
    assert.deepEqual(result.data.state.semesters[0].grades,['26']);
    assert.equal(metadata.records.length,0);assert.equal(metadata.classes[0].name,'当前班级','do not mutate the received metadata object');
    assert.deepEqual(h.calls.map(call=>call.payload),[
      {kind:'excelReport',week:8,paged:true},
      {kind:'excelReport',week:8,paged:true,reportVersion:7},
      {kind:'excelReport',week:8,paged:true,reportVersion:7},
    ]);
    assert.deepEqual(h.calls.map(call=>call.cursor),[undefined,'p12','p24']);
  } finally {h.restore();}
});

test('报表分包：空周是完整空报表，单包及旧后端完整state都只读一次',async()=>{
  for(const kind of ['report','excelReport','namesReport'] as const) for(const legacy of [false,true]) {
    const metadata=state(),h=setup([legacy?{data:{state:metadata,version:7}}:page([],metadata)]);
    try {const result=await loadReportState(kind,'semester',8);assert.equal(result.data.state.records.length,0);assert.equal(h.calls.length,1);}
    finally {h.restore();}
  }
});

test('报表分包：中途网络失败不返回半份数据，重试从首包重新获取',async()=>{
  const rows=[record('one'),record('two')],h=setup([
    page([rows[0]],state(),'next'),{data:{},error:new Error('网络断开')},
    page([rows[0]],state(),'retry-next'),page([rows[1]]),
  ]);
  try {
    await assert.rejects(loadReportState('namesReport','semester',8),/网络断开/);
    const result=await loadReportState('namesReport','semester',8);assert.deepEqual(result.data.state.records,rows);
    assert.equal(h.calls[2].cursor,undefined);assert.equal(h.calls[2].payload?.reportVersion,undefined);
  } finally {h.restore();}
});

test('报表分包：数据版本或业务轮次改变立即中止，不拼接两个版本',async()=>{
  for(const changed of [
    {...page([record('two')]),data:{reportPage:true,records:[record('two')],version:8},workspaceVersion:8},
    {...page([record('two')]),data:{reportPage:true,records:[record('two')],version:6},workspaceVersion:6},
    {...page([record('two')]),epoch:'different-epoch'},
  ]) {
    const h=setup([page([record('one')],state(),'next'),changed]);
    try {await assert.rejects(loadReportState('report','semester',8),/变化|版本|轮次/);assert.equal(h.calls.length,2);}
    finally {h.restore();}
  }
});

test('报表分包：重复游标、无进展游标和循环游标都停止，不能无限下载',async()=>{
  const cases=[
    [page([record('one')],state(),'same'),page([record('two')],undefined,'same')],
    [page([record('one')],state(),'one'),page([],undefined,'two')],
    [page([record('one')],state(),'one'),page([record('two')],undefined,'two'),page([record('three')],undefined,'one')],
  ];
  for(const parts of cases) {const h=setup(parts);try {await assert.rejects(loadReportState('report','semester',8),/不完整/);assert.equal(h.calls.length,parts.length);}finally{h.restore();}}
});

test('报表分包：重复记录ID、其他学期或其他周的记录不得进入文件',async()=>{
  for(const bad of [record('one'),{...record('two'),week:9},{...record('two'),semesterId:'history'}]) {
    const h=setup([page([record('one')],state(),'next'),page([bad])]);
    try {await assert.rejects(loadReportState('excelReport','semester',8),/不完整/);}finally{h.restore();}
  }
});

test('报表分包：缺少首包元数据、重复元数据、元数据夹带记录和中途切旧协议均拒绝',async()=>{
  const withRecords=state();withRecords.records=[record('embedded')];
  const cases=[
    [page([record('one')])],
    [page([record('one')],state(),'next'),page([record('two')],state())],
    [page([record('one')],withRecords)],
    [page([record('one')],state(),'next'),{data:{state:state(),version:7}}],
    [{data:{reportPage:true,metadata:state(),version:7}}],
    [{...page([],state()),cursor:123}],
    [{data:{reportPage:true,metadata:state(),records:[],version:6},workspaceVersion:7}],
  ];
  for(const parts of cases) {const h=setup(parts);try {await assert.rejects(loadReportState('namesReport','semester',8),/不完整/);}finally{h.restore();}}
});
