import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runtime} from "../miniprogram/config/runtime";
import {registerCloudPage} from "../miniprogram/services/v2/page";
import {createGatewayV2} from "../server/v2/gateway";
import {MemoryRepository} from "../server/v2/memory";

const event=(dataset:any={},value:any="")=>({currentTarget:{dataset},detail:{value}});
test("云端页面完整流程：首次登记、独立建班、申请审核、排班、提交更正、版本历史与TXT/XLSX导出",async()=>{
 const g=globalThis as any, oldWx=g.wx, oldPage=g.Page, original={...runtime};
 runtime.mode="cloud";runtime.env="v2-pages-integration";
 const repository=new MemoryRepository();let who="owner",seq=0,registered:any;
 const gateway=createGatewayV2({repository,appid:"app",bootstrapOpenid:"owner",maxExecutionMs:3000,uuid:()=>"page-"+(++seq),now:()=>Date.parse("2026-09-07T04:00:00Z"),photos:{async upload(path){return "pg://xuedu-photos/"+path;},async urls(ids){return ids.map(id=>"https://example.test/"+id);},async list(){return [];},async delete(){}}});
 const storage=new Map(),errors:string[]=[],written:any[]=[],calls:any[]=[];
 g.Page=(o:any)=>registered=o;
 g.wx={env:{USER_DATA_PATH:"/test"},getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:unknown)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),showToast(){},async showModal(o:any){if(o.showCancel===false){errors.push(o.content);return {confirm:false};}return {confirm:true,content:"已经本人核对"};},async chooseMedia(){return {tempFiles:[{tempFilePath:"/photo"}]};},getFileSystemManager(){return {readFileSync(){return "aGVsbG8=";},writeFile(o:any){written.push(o);o.success?.();}};},openDocument(){},previewImage(){},cloud:{init(){},async callFunction({data}:any){calls.push(data);try{return {result:{ok:true,data:await gateway(data,{OPENID:who,APPID:"app"})}};}catch(e){return {result:{ok:false,error:(e as Error).message}};}}}};
 const page=async(view:any,q:any={})=>{registerCloudPage(view);const p={...registered,data:structuredClone(registered.data),setData(v:any){Object.assign(this.data,v);}};p.onLoad(q);await p.load();assert.equal(p.data.error,"");return p;};
 const fill=(p:any,values:any)=>{p.data.fields=p.data.fields.map((f:any)=>({...f,...(Array.isArray(values[f.key])?{selected:values[f.key]}:values[f.key]===undefined?{}:{value:String(values[f.key])})}));};
 const save=async(p:any)=>{await p.saveForm();assert.deepEqual(errors,[]);assert.equal(p.data.error,"");};
 try{
  const join=await page("join");assert.equal(join.data.canInitialize,true);await join.openForm("initialize");fill(join,{semesterName:"2026秋",startDate:"2026-09-07",className:"26自动化1班",grade:"26",major:"自动化",name:"管理员",studentNo:"001"});await save(join);
  const workspace=await repository.workspace(),semesterId=workspace.activeSemesterId;
  const manage=await page("manage");manage.data.busy=true;manage.section(event({id:"applications"}));assert.equal(manage.data.section,"members","加载时不能把旧分类数据标成新分类");manage.data.busy=false;await manage.openForm("classSave");fill(manage,{name:"26计科1班",grade:"26",major:"计算机"});await save(manage);const classes=(await repository.query("classes",{})).items;
  const ownClass=classes.find(c=>c.data.major==="自动化")!,target=classes.find(c=>c.data.major==="计算机")!;
  assert.equal((await repository.query("courses",{})).items.length,0,"无课程也能独立建班");
  const semester=(await repository.get("semesters",semesterId))!;await manage.openForm("semesterParticipants",semester);assert.deepEqual(manage.data.fields[0].selected,[ownClass.id]);fill(manage,{classIds:[ownClass.id,target.id]});await save(manage);
  who="member";const apply=await page("join");await apply.openForm("join");fill(apply,{name:"成员",studentNo:"002",classId:String(apply.data.fields.find((f:any)=>f.key==="classId").options.findIndex((o:any)=>o.value===ownClass.id))});await save(apply);
  who="owner";manage.data.section="applications";await manage.load();assert.equal(manage.data.rows.length,1);manage.selectApplication(event({id:manage.data.rows[0].id}));assert.equal(manage.data.rows[0].selected,true);await manage.reviewApplications(event({action:"approve"}));assert.deepEqual(errors,[]);assert.equal((await repository.query("members",{})).items.length,2);
  await manage.openForm("courseSave");fill(manage,{name:"高等数学",teacher:"测试教师",classIds:[target.id],classroom:"101",weeks:"1",expected:"30",effectiveDate:"2026-09-07"});await save(manage);
  const course=(await repository.query("courses",{})).items[0];await manage.openForm("courseSave",course);assert.equal(manage.data.fields.find((f:any)=>f.key==="teacher").value,"测试教师");manage.cancelForm();
  who="member";const availability=await page("availability");availability.data.selectedSlots=["1:1","1:2"];await availability.saveAvailability();assert.deepEqual(errors,[]);
  availability.toggleSlot(event({key:"1:3"}));assert.ok(availability.data.selectedSlots.includes("1:3"));availability.toggleSlot(event({key:"1:3"}));assert.ok(!availability.data.selectedSlots.includes("1:3"));
  who="owner";const schedule=await page("schedule");await schedule.generate();assert.ok(schedule.data.weekData.draft);await schedule.confirmPlan();assert.deepEqual(errors,[]);const task=(await repository.query("tasks",{})).items.find(t=>t.data.status==="confirmed")!;assert.ok(task);
  who="member";const submission=await page("submission",{taskId:task.id,semesterId});fill(submission,{expected:30,actual:29,late:0,early:0,sleep:0,phone:0,talk:0,other:0,absentNames:"无",leaveNames:"测试同学"});await submission.choosePhotos();assert.deepEqual(errors,[]);await save(submission);
  const home=await page("home");assert.equal(home.data.homeTasks.length,1);assert.equal(home.data.homeTasks[0].done,true);assert.equal(home.data.homeTasks[0].course.name,"高等数学");
  const record=(await repository.query("records",{})).items[0];assert.ok(record);const detail=await page("record",{id:record.id,semesterId});assert.equal(detail.data.canEdit,true);detail.editRecord();fill(detail,{actual:28,reason:"核对签字表"});await save(detail);assert.equal((await repository.get("records",record.id))!.version,2);
  const editCall=calls.find(c=>c.payload?.type==="recordEdit");assert.equal(editCall.payload.taskId,undefined,"纠错不能提交归属字段");await detail.history();assert.equal(detail.data.versions.length,2);await detail.history();assert.equal(detail.data.versions.length,2,"末页历史不可重复追加");
  who="owner";const reports=await page("records");await reports.showStats();assert.equal(reports.data.statsCount,1);assert.equal(reports.data.stats[0].rate,"93.3%");await reports.exportReport(event({kind:"txt"}));await reports.exportReport(event({kind:"xlsx"}));assert.deepEqual(errors,[]);assert.equal(written.length,2);assert.match(written[0].data,/最近更正/);assert.ok(written[1].data.byteLength>1000);
  const markup=["cloud.wxml","cloud-home.wxml","cloud-profile.wxml"].map(file=>readFileSync(new URL("../miniprogram/templates/"+file,import.meta.url),"utf8")).join("\n");for(const m of markup.matchAll(/(?:bind|catch):?\w+="([\w]+)"/g))assert.equal(typeof reports[m[1]],"function",`缺少${m[1]}事件`);
 }finally{g.wx=oldWx;g.Page=oldPage;Object.assign(runtime,original);}
});
