import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayV2 } from '../server/v2/gateway';
import { MemoryRepository, EMPTY_WORKSPACE } from '../server/v2/memory';
import { Entity, Resource } from '../miniprogram/domain/v2/protocol';
import { planCourseImport } from '../miniprogram/services/v2/import-batch';
import { registerCloudPage } from '../miniprogram/services/v2/page';
import { bootstrap } from '../miniprogram/services/v2/client';
import { runtime } from '../miniprogram/config/runtime';

const epoch='import-epoch', semesterId='s1';
const entity=(id:string,data:Record<string,unknown>,extra:Partial<Entity>={}):Entity=>({id,epoch,version:1,data,...extra});
function fixture() {
  const existingId='class-45a2fd86-0bbd-4e88-9b33-134bf2edda29';
  const repository=new MemoryRepository({...EMPTY_WORKSPACE,epoch,version:1,activeSemesterId:semesterId,maxExecutionMs:3000},{
    classes:[entity(existingId,{name:'25自动化3班',grade:'25',major:'自动化',active:true})],
    members:[entity('admin',{name:'合成管理员',studentNo:'test-1',classId:existingId,role:'admin',active:true},{studentNo:'test-1'})],
    bindings:[entity('binding',{}, {identityKey:'trusted-admin',memberId:'admin'})],
    semesters:[entity(semesterId,{name:'合成秋季',startDate:'2026-09-07',weeks:20,days:5,periods:14,grades:['25'],status:'active'})],
    semester_classes:[entity('link',{}, {semesterId,parentId:existingId})],
  });
  const reads:Resource[]=[];const original=repository.query.bind(repository);
  repository.query=async(r,q)=>{reads.push(r);return original(r,q);};
  let seq=0;
  const gateway=createGatewayV2({repository,appid:'app',bootstrapOpenid:'trusted-admin',maxExecutionMs:3000,uuid:()=>`new-${++seq}`,photos:{async upload(){return '';},async urls(){return [];},async list(){return [];},async delete(){}}});
  const call=(operation:string,payload:Record<string,unknown>={},requestId='req-'+(++seq))=>gateway({protocolVersion:2,operation,epoch,semesterId,requestId,payload},{OPENID:'trusted-admin',APPID:'app'});
  return {repository,reads,gateway,call,existingId};
}
function source(courseCount=154, weeks=9) {
  const classes=Array.from({length:32},(_,i)=>({id:i===0?'25-automation-3-4':`combined-${i}`,name:i===0?'25自动化3/4班':`合成合班${i}`,grade:'25',major:'自动化'}));
  const courses=Array.from({length:courseCount},(_,i)=>({id:`course-${i}`,name:`合成课程${i}`,teacher:'合成教师',nature:'必修',classIds:[classes[i%classes.length].id],classroom:'101',weekday:i%5+1,start:1,end:2,weeks:Array.from({length:weeks},(_,w)=>w+1),expected:30}));
  return JSON.stringify({classes,courses});
}

test('154 门合班课程自动分批且无遗漏；导入每批不按日期反复读取课程版本与实例',async()=>{
  const f=fixture(), text=source();let n=0;
  const inspected=await f.call('query',{kind:'importInspect',text});
  assert.equal(inspected.data.courses,154);assert.equal(inspected.data.classes,32);
  const batches=planCourseImport(text,()=>`batch-${++n}`);
  assert.ok(batches.length>1);assert.equal(batches.reduce((sum,b)=>sum+b.courses,0),154);
  assert.equal(batches.reduce((sum,b)=>sum+b.classes,0),32);
  assert.equal(batches.reduce((sum,b)=>sum+b.dates,0),154*9);
  for(const batch of batches){
    assert.ok(batch.courses<=6 && batch.dates<=60 && batch.classes<=40);
    const before=f.reads.length;
    await f.call('command',{type:'import',text:batch.text},batch.requestId);
    const reads=f.reads.slice(before);
    assert.ok(!reads.some(r=>['course_versions','occurrences','exceptions'].includes(r)),reads.join(','));
    assert.ok(reads.length<20,`unexpected ${reads.length} queries`);
  }
  assert.equal(await f.repository.count('courses',{}),154);
  assert.equal(await f.repository.count('occurrences',{}),154*9);
  assert.equal(await f.repository.count('classes',{}),33);
  assert.equal((await f.repository.get('classes',f.existingId))?.data.name,'25自动化3班');
  assert.equal((await f.repository.get('classes','25-automation-3-4'))?.data.name,'25自动化3/4班');
  const occurrence=await f.repository.get('occurrences','course-0:2026-09-07');
  assert.equal((occurrence?.data.course as any).weeks[0],1);
  assert.equal((occurrence?.data.classes as any[])[0].name,'25自动化3/4班');
});

test('响应丢失后页面用原请求号续传，不重复首批也不重做全文预检',async()=>{
  const f=fixture(), originalRuntime={...runtime}, global=globalThis as any;
  const oldWx=global.wx,oldPage=global.Page, storage=new Map<string,unknown>();
  let registered:any, failed=false, inspected=0, firstBatchId='';const errors:string[]=[];
  runtime.mode='cloud';runtime.env='v2-import-batch-page';
  global.Page=(options:any)=>{registered=options;};
  global.wx={getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,structuredClone(value)),removeStorageSync:(key:string)=>storage.delete(key),
    async showModal(options:any){if(options.showCancel===false)errors.push(options.content);return {confirm:true};},showToast(){},
    cloud:{init(){},async callFunction({data}:any){
      if(data.operation==='query' && data.payload?.kind==='importInspect')inspected++;
      try {const result=await f.gateway(data,{OPENID:'trusted-admin',APPID:'app'});
        if(data.operation==='command' && data.payload?.type==='import' && !failed){failed=true;firstBatchId=data.requestId;throw new Error('Invoking task timed out after 3 seconds');}
        return {result:{ok:true,data:result}};
      }catch(error){if((error as Error).message.includes('timed out'))throw error;return {result:{ok:false,error:(error as Error).message}};}
    }}};
  try {
    await bootstrap();registerCloudPage('manage');
    const page={...registered,data:structuredClone(registered.data),setData(update:any){Object.assign(this.data,update);},async load(){}};
    page.data.semesterId=semesterId;page.data.admin=true;page.data.memberId='admin';
    await page.openForm('import');page.data.fields=page.data.fields.map((field:any)=>field.key==='text'?{...field,value:source(18,5)}:field);
    page.previewImport();await page.saveForm();
    assert.equal(await f.repository.count('courses',{}),6);
    assert.equal(inspected,1);assert.ok([...storage.keys()].some(key=>key.startsWith('xuedu.import.v2.')));
    assert.match(page.data.importProgress,/已完成 0\/3 批/);
    page.data.fields=page.data.fields.map((field:any)=>field.key==='text'?{...field,value:'{"courses":[]}'}:field);
    page.data.importPreview=['过期预览'];
    page.restoreImport();
    assert.match(page.data.fields.find((field:any)=>field.key==='text').value,/合成课程0/);
    assert.match(page.data.importPreview[0],/合成课程0/);
    await page.saveForm();
    assert.equal(await f.repository.count('courses',{}),18);
    assert.equal(inspected,1,'续传不能用已部分导入的全文重新预检');
    assert.equal([...storage.keys()].filter(key=>key.startsWith('xuedu.import.v2.')).length,0);
    assert.ok(firstBatchId);assert.equal(errors.length,1,'只出现第一次网络超时提示');
  } finally {global.wx=oldWx;global.Page=oldPage;Object.assign(runtime,originalRuntime);}
});
test('完整预检仅管理员可调用，重复课程标识在首批写入前被拒绝',async()=>{
  const f=fixture();
  const text=source(2,2);
  await assert.rejects(f.gateway({protocolVersion:2,operation:'query',epoch,semesterId,payload:{kind:'importInspect',text}},{OPENID:'visitor',APPID:'app'}),/审核|申请|权限|管理员/);
  const malformed=JSON.parse(text);malformed.courses[1].id=malformed.courses[0].id;
  await assert.rejects(f.call('query',{kind:'importInspect',text:JSON.stringify(malformed)}),/重复/);
  assert.equal(await f.repository.count('courses',{}),0);
  assert.equal(await f.repository.count('occurrences',{}),0);
});
