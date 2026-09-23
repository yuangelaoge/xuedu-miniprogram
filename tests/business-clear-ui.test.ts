import test from "node:test";
import assert from "node:assert/strict";
import { runtime } from "../miniprogram/config/runtime";
import { createGatewayV2 } from "../server/v2/gateway";
import { MemoryRepository } from "../server/v2/memory";
import { CLEAR_CONFIRMATION } from "../miniprogram/domain/v2/protocol";
import { registerCloudPage } from "../miniprogram/services/v2/page";

test("V2页面清空：取消和旧文字不执行、断线续跑同一任务、保留管理员班级直接建草稿", async () => {
  const g = globalThis as any, oldWx = g.wx, oldPage = g.Page, original = {...runtime};
  runtime.mode = "cloud"; runtime.env = "v2-clear-ui";
  const repository = new MemoryRepository(); let n = 0, now = 0;
  const gateway = createGatewayV2({ repository, appid: "app", bootstrapOpenid: "owner", maxExecutionMs: 3000, uuid: () => "ui-" + ++n, now: () => now, photos: {async upload() {throw new Error("unused");},async urls() {return [];},async list() {return [];},async delete() {}}});
  const ctx = {OPENID:"owner",APPID:"app"};
  await gateway({protocolVersion:2,operation:"initialize",epoch:"initial",requestId:"init",payload:{member:{name:"管理员",studentNo:"1"},schoolClass:{name:"26自动化",grade:"26",major:"自动化"},semester:{name:"本学期",startDate:"2026-09-07",weeks:20}}},ctx);
  let registered: any, modal = {confirm:false,content:""}, failStep = false;
  const operations: string[] = [], storage = new Map([["xuedu.form.v2-clear-ui.cloud.old.a.t",1],["xuedu.form.other.cloud.old.a.t",2]]);
  g.Page = (o:any) => {registered=o;};
  g.wx = { getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:unknown)=>storage.set(k,v), getStorageInfoSync:()=>({keys:[...storage.keys()]}),removeStorageSync:(k:string)=>storage.delete(k),showToast(){}, async showModal(){return modal;}, cloud:{init(){},async callFunction({data}:any){ operations.push(data.operation); try{ if(data.operation==="clearStep"&&failStep) throw new Error("模拟断线"); const out=await gateway(data,ctx); if(data.operation==="clearBegin") now+=5000; return {result:{ok:true,data:out}};}catch(e){return {result:{ok:false,error:(e as Error).message}};} }}};
  try {
    registerCloudPage("manage"); const page = {...registered,data:structuredClone(registered.data),setData(v:any){Object.assign(this.data,v);}};
    await page.load(); assert.equal(page.data.admin,true);
    const before=await repository.workspace(); await page.clearBusiness(); assert.equal((await repository.workspace()).version,before.version);
    modal={confirm:true,content:"清空业务数据，保留管理员"}; await page.clearBusiness(); assert.equal(operations.includes("clearBegin"),false);
    modal={confirm:true,content:CLEAR_CONFIRMATION};failStep=true;await page.clearBusiness(); const job=(await repository.workspace()).maintenance; assert.ok(job);assert.equal(page.data.busy,false);
    failStep=false;await page.clearBusiness();assert.equal((await repository.workspace()).maintenance,"");assert.equal(operations.filter(x=>x==="clearBegin").length,1);assert.equal(page.data.section,"semesters");
    const members=(await repository.query("members", {})).items,classes=(await repository.query("classes", {})).items;
    assert.equal(members.length,1);assert.equal(classes.length,1);assert.equal(members[0].data.classId,classes[0].id);assert.equal(storage.size,1);
    await page.openForm("semesterCreate");const values:any={name:"下学期",startDate:"2027-02-22"};page.data.fields=page.data.fields.map((f:any)=>({...f,value:values[f.key]||f.value}));await page.saveForm();
    assert.equal((await repository.query("semesters", {})).items.length,1);assert.equal((await repository.workspace()).activeSemesterId,"","新建草稿不能自动启用");
  } finally {g.wx=oldWx;g.Page=oldPage;Object.assign(runtime,original);}
});
