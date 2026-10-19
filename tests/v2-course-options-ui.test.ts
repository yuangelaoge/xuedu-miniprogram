import test from 'node:test';
import assert from 'node:assert/strict';
import {optionFixture,generateOptions} from './helpers/course-options';
import { registerCloudPage } from '../miniprogram/services/v2/page';
import { runtime } from '../miniprogram/config/runtime';
import {readFileSync} from 'node:fs';
const event=(value:string,key='')=>({currentTarget:{dataset:{key}},detail:{value}});
let serial=0;
async function ui(work:(f:any)=>Promise<void>) {
 const f=optionFixture(),{plan,task}=await generateOptions(f);
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 const g=globalThis as any,oldWx=g.wx,oldPage=g.Page,oldRuntime={...runtime};runtime.mode='cloud';runtime.env='options-ui-'+ ++serial;
 let definition:any,who:'admin'|'member'|'officer'='member';const storage=new Map(),calls:any[]=[],errors:string[]=[],files:any[]=[];
 g.Page=(p:any)=>definition=p;
 g.wx={getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:unknown)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),showToast(){},
  async showModal(p:any){if(p.showCancel===false)errors.push(p.content);return {confirm:true};},async chooseMedia(){return {tempFiles:[{tempFilePath:'/synthetic-photo'}]};},
  env:{USER_DATA_PATH:'/synthetic-export'},getFileSystemManager(){return {readFileSync(){return 'aGVsbG8=';},writeFile(p:any){files.push(p);p.success();p.complete();}};},cloud:{init(){},async callFunction({data}:any){calls.push(data);try{return {result:{ok:true,data:await f.call(data.operation,data.payload,{...data,who})}};}catch(e){return {result:{ok:false,error:(e as Error).message}};}}}};
 const page=async(view:any,q:any={})=>{registerCloudPage(view);const p={...definition,data:structuredClone(definition.data),setData(v:any,callback?:()=>void){Object.assign(this.data,v);callback?.();}};p.onLoad({semesterId:'review-semester',week:'2',...q});await p.load();assert.equal(p.data.error,'');return p;};
 try {await work({...f,task,page,storage,calls,errors,files,who:(v:typeof who)=>who=v});}
 finally {g.wx=oldWx;g.Page=oldPage;Object.assign(runtime,oldRuntime);}
}
test('选择实际课程同步性质/教师/教室/时间，保留已填文字和照片，草稿只恢复仍分配的选项',async()=>ui(async f=>{
 const p=await f.page('submission',{taskId:f.task.id});assert.equal(p.data.recordOptions.length,3);
 p.input(event('32','expected'));p.input(event('30','actual'));p.input(event('合成观察','evaluation'));p.zeroRemaining();await p.choosePhotos();const photos=[...p.data.photoIds];
 const index=p.data.recordOptions.findIndex((o:any)=>o.course.id==='early');p.chooseRecordCourse(event(String(index)));
 assert.equal(p.data.recordContext.data.course.nature,'学科必修课');assert.equal(p.data.recordContext.data.course.teacher,'合成教师-early');assert.equal(p.data.recordContext.data.course.classroom,'合成教室-early');assert.equal(p.data.recordContext.data.course.start,1);
 assert.equal(p.data.fields.find((v:any)=>v.key==='evaluation').value,'合成观察');assert.deepEqual(p.data.photoIds,photos);
 const selected=p.data.formExtra.occurrenceId;p.setData({busy:true});p.chooseRecordCourse(event('0'));assert.equal(p.data.formExtra.occurrenceId,selected);p.setData({busy:false});
 p.saveDraft();const reopened=await f.page('submission',{taskId:f.task.id});assert.equal(reopened.data.formExtra.occurrenceId,selected);
 await p.saveForm();assert.deepEqual(f.errors,[]);const request=f.calls.find((c:any)=>c.payload?.type==='recordSubmitChoice');assert.equal(request.payload.occurrenceId,selected);
 const record=(await f.repo.query('records',{eq:{taskId:f.task.id}})).items[0];assert.equal(record.data.course.nature,'学科必修课');
 const detail=await f.page('record',{id:record.id});detail.editRecord();assert.equal(detail.data.recordOptions.length,0);assert.equal(detail.data.recordContext.data.course.nature,'学科必修课');detail.chooseRecordCourse(event('0'));assert.equal(detail.data.formExtra.occurrenceId,undefined);
 const key=[...f.storage.keys()].find((k:any)=>k.includes(f.task.id));if(key)f.storage.delete(key);
}));
test('动态年级选项含缺失grade回退，默认不优先；选择只发往当前周草稿且切周复位',async()=>ui(async f=>{
 f.who('officer');const p=await f.page('schedule');assert.deepEqual(p.data.gradeOptions,['不特别优先','24','25']);assert.equal(p.data.priorityGrade,'');
 p.choosePriorityGrade(event('2'));await p.generate();assert.deepEqual(f.errors,[]);
 const request=f.calls.find((c:any)=>c.payload?.type==='planGenerate');assert.equal(request.payload.priorityGrade,'25');assert.equal(request.payload.week,2);
 assert.equal(p.data.weekData.draft.data.priorityGrade,'25');
 p.setData({week:3,weekInitialized:true});await p.load();assert.equal(p.data.priorityGrade,'');assert.equal(p.data.priorityGradeIndex,0);
}));
test('提交页提供课程下拉且课程性质只读、不增加自由课程/性质分类入口',()=>{
 const xml=readFileSync('miniprogram/templates/cloud-record-form.wxml','utf8');assert.match(xml,/bindchange="chooseRecordCourse"/);assert.match(xml,/recordContext.data.course.nature/);assert.doesNotMatch(xml,/data-key="nature"/);
});
test('安排表从当前周导出真实XLSX并前后复核；普通成员无导出入口能力',async()=>ui(async f=>{
 const memberPage=await f.page('schedule');await memberPage.exportSchedule();assert.equal(f.files.length,0);
 f.who('officer');const p=await f.page('schedule');await p.exportSchedule();
 assert.deepEqual(f.errors,[]);assert.equal(f.files.length,1);assert.ok(f.files[0].data instanceof ArrayBuffer);
 assert.match(p.data.filename,/第2周-听课安排表/);assert.equal(p.data.filePath,f.files[0].filePath);
 const checks=f.calls.filter((c:any)=>c.payload?.kind==='reportCheck' && c.payload.format==='schedule');assert.equal(checks.length,2);
 assert.ok(checks.every((c:any)=>c.payload.week===2 && c.semesterId==='review-semester'));
}));
