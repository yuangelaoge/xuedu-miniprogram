import test from 'node:test';
import assert from 'node:assert/strict';
import {optionFixture,optionSeed,generateOptions} from './helpers/course-options';
import { registerCloudPage } from '../miniprogram/services/v2/page';
import { runtime } from '../miniprogram/config/runtime';
import {readFileSync} from 'node:fs';
const event=(value:string,key='')=>({currentTarget:{dataset:{key}},detail:{value}});
let serial=0;
async function ui(work:(f:any)=>Promise<void>,seed=optionSeed(),confirmNext=true) {
 const f=optionFixture(seed),{plan,task}=await generateOptions(f);
 if(confirmNext)await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 const g=globalThis as any,oldWx=g.wx,oldPage=g.Page,oldRuntime={...runtime};runtime.mode='cloud';runtime.env='options-ui-'+ ++serial;
 let definition:any,who:'admin'|'member'|'officer'='member';const storage=new Map(),calls:any[]=[],errors:string[]=[],files:any[]=[];
 g.Page=(p:any)=>definition=p;
 g.wx={getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:unknown)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),showToast(){},
  async showModal(p:any){if(p.showCancel===false)errors.push(p.content);return {confirm:true};},async chooseMedia(){return {tempFiles:[{tempFilePath:'/synthetic-photo'}]};},
  env:{USER_DATA_PATH:'/synthetic-export'},getFileSystemManager(){return {readFileSync(){return 'aGVsbG8=';},writeFile(p:any){files.push(p);p.success();p.complete();}};},cloud:{init(){},CDN(){return 'http://vweixinf.tc.qq.com/301/synthetic';},async callFunction({data}:any){calls.push(data);try{return {result:{ok:true,data:await f.call(data.operation,data.payload,{...data,who})}};}catch(e){return {result:{ok:false,error:(e as Error).message}};}}}};
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
test('普通干事首页/正式任务逐门显示课表人数，合班合计、零与缺失不混淆',async()=>{
 const seed=optionSeed(),task=seed.rows.tasks!.find(t=>t.id==='review-task-open')!,course=task.data.course as Record<string,unknown>;
 task.data.courseOptions=[64,0,undefined].map((expected,i)=>({occurrenceId:'display-'+i,date:task.data.date,classLabel:'甲班 / 乙班',classes:[],course:{...course,id:'display-'+i,name:'不同课程'+i,classIds:['class-a','class-b'],expected}}));
 await ui(async f=>{
   const home=await f.page('home');assert.equal(home.data.homeTasks.length,1);
   const counts=home.data.homeTasks[0].courseCounts;
   assert.deepEqual(counts.map((c:any)=>c.count),['64 人','0 人','未填写']);assert.ok(counts.every((c:any)=>c.combined));
   assert.equal(new Set(counts.map((c:any)=>c.label)).size,3);
   for (const [i,c] of counts.entries()) {
     assert.equal(c.name,'不同课程'+i);assert.equal(c.teacher,course.teacher);assert.equal(c.classroom,course.classroom);
     assert.match(c.timeLabel,/第\d+–\d+节/);
   }
   const schedule=await f.page('schedule',{week:'1'});assert.equal(schedule.data.visibleTasks.length,1);
   assert.deepEqual(schedule.data.visibleTasks[0].courseCounts,counts);
   schedule.setData({searchText:'不同课程2'});schedule.filterRows();assert.equal(schedule.data.visibleTasks.length,1,'第二节课程也可搜索');
   // The week-2 task is newly generated; course count never fills observation metrics.
   const submit=await f.page('submission',{taskId:f.task.id});assert.equal(submit.data.fields.find((v:any)=>v.key==='expected').value,'');
   submit.data.recordOptions[1].course.expected=51;
   submit.chooseRecordCourse(event('1'));
   assert.equal(submit.data.recordContext.courseHeadcount,'51 人');
   assert.equal(submit.data.recordContext.data.course.id,submit.data.recordOptions[1].course.id);
   assert.equal(submit.data.fields.find((v:any)=>v.key==='expected').value,'','课表人数只作参考，不填充观察人数');
   assert.deepEqual(f.errors,[]);
 },seed);
 for (const file of ['cloud.wxml','cloud-home.wxml']) {
   const template=readFileSync('miniprogram/templates/'+file,'utf8');
   assert.match(template,/courseCounts/);assert.match(template,/课表人数/);assert.match(template,/合班合计/);
 }
});
test('旧单课程任务即使备选数组为空，首页和安排页仍显示完整快照',async()=>{
 const seed=optionSeed(),task=seed.rows.tasks!.find(t=>t.id==='review-task-open')!;
 task.data.courseOptions=[];
 await ui(async f=>{
   const home=await f.page('home'),schedule=await f.page('schedule',{week:'1'});
   const choices=home.data.homeTasks[0].courseCounts;
   assert.equal(choices.length,1);assert.equal(choices[0].name,(task.data.course as any).name);
   assert.equal(choices[0].classroom,(task.data.course as any).classroom);
   assert.deepEqual(schedule.data.visibleTasks[0].courseCounts,choices);
 },seed);
});
test('首页本周/下周任务分开，下周只显示本人已生效任务，学期末不再请求',async()=>ui(async f=>{
 const home=await f.page('home');assert.equal(home.data.week,1);assert.equal(home.data.nextWeek,2);
 assert.deepEqual(home.data.homeTasks.map((t:any)=>t.id),['review-task-open']);
 assert.deepEqual(home.data.homeNextTasks.map((t:any)=>t.id),[f.task.id]);assert.equal(home.data.homeNextTasks[0].courseCounts.length,3);
 assert.equal(home.data.nextWeekError,'');assert.equal(home.data.nextWeekLoading,false);
 const reads=f.calls.filter((c:any)=>c.operation==='bootstrap' && c.payload.page?.view==='schedule');
 assert.equal(reads.length,1);assert.equal(reads[0].payload.fastPage,true);assert.equal(reads[0].payload.page.week,2);
 home.setData({maxWeek:1});const count=f.calls.length;await home.loadNextWeek();assert.equal(f.calls.length,count);
 assert.deepEqual(home.data.homeNextTasks,[]);assert.equal(home.data.nextWeekMessage,'本学期没有下周');
 f.who('admin');const admin=await f.page('home');assert.deepEqual(admin.data.homeNextTasks,[],'管理员首页也只显示本人任务');
}));
test('下周读取失败不清空本周卡片，独立重试可恢复',async()=>ui(async f=>{
 const g=globalThis as any,original=g.wx.cloud.callFunction;
 g.wx.cloud.callFunction=async(args:any)=>args.data.payload?.page?.view==='schedule' ? {result:{ok:false,error:'网络暂不可用'}} : original(args);
 const home=await f.page('home');assert.equal(home.data.error,'');assert.equal(home.data.loadingInitial,false);assert.equal(home.data.homeTasks.length,1);
 assert.equal(home.data.nextWeekError,'网络暂不可用');assert.deepEqual(home.data.homeNextTasks,[]);
 g.wx.cloud.callFunction=original;await home.loadNextWeek();assert.equal(home.data.homeNextTasks.length,1);assert.equal(home.data.nextWeekError,'');
}));

for (const role of ['member','officer']) for (const [hasCurrent,hasNext] of [[true,true],[false,true],[true,false],[false,false]]) {
 test(`首页周次隔离：${role} 本周${hasCurrent?'有':'无'}任务、下周${hasNext?'有':'无'}任务，安排页切周/学期不影响首页`,async()=>{
   const seed=optionSeed();
   seed.rows.members!.find(m=>m.id==='review-member')!.data.role=role;
   if(!hasCurrent)seed.rows.tasks=seed.rows.tasks!.filter(t=>!(t.memberId==='review-member' && t.week===1));
   const active=seed.rows.semesters![0];
   seed.rows.semesters!.push({...structuredClone(active),id:'historical-semester',data:{...active.data,name:'合成历史学期',startDate:'2025-09-01'}});
   await ui(async f=>{
     const home=await f.page('home');
     const expected=()=>{
       assert.equal(home.data.week,1);assert.equal(home.data.nextWeek,2);
       assert.equal(home.data.semesterId,'review-semester');
       assert.deepEqual(home.data.homeTasks.map((t:any)=>t.id),hasCurrent?['review-task-open']:[]);
       assert.deepEqual(home.data.homeNextTasks.map((t:any)=>t.id),hasNext?[f.task.id]:[]);
       for(const t of [...home.data.homeTasks,...home.data.homeNextTasks]){
         assert.ok(t.classLabel);assert.ok(t.course.name);assert.ok(t.course.teacher);assert.ok(t.course.classroom);
         assert.match(t.timeLabel,/2026-10-\d+ · 第\d+–\d+节/);assert.ok(t.courseCounts.length>0);
         assert.equal(t.status,'confirmed');
       }
     };
     expected();
     const schedule=await f.page('schedule',{week:'2'});
     for(const delta of ['1','1','-3','1']) {
       await schedule.moveWeek({currentTarget:{dataset:{delta}},detail:{value:''}});
       await home.onShow();expected();
       await home.load();expected();
       assert.ok(schedule.data.visibleTasks.every((t:any)=>t.week===schedule.data.week));
     }
     const i=schedule.data.semesters.findIndex((s:any)=>s.id==='historical-semester');assert.ok(i>=0);
     schedule.chooseSemester({currentTarget:{dataset:{}},detail:{value:String(i)}});
     while(schedule.data.busy)await new Promise(resolve=>setImmediate(resolve));
     assert.equal(schedule.data.semesterId,'historical-semester');
     await home.onShow();expected();
     assert.deepEqual(f.errors,[]);
   },seed,hasNext);
 });
}
