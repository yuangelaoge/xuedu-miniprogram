import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../miniprogram/domain/seed';
import {runtime} from '../miniprogram/config/runtime';

test('demo 报表 handler 对组部长禁用 TXT/复制/Excel，管理员保留',async()=>{
 const g=globalThis as any,old={wx:g.wx,Page:g.Page,mode:runtime.mode};const state=createSeed();state.actorId='m6';runtime.mode='demo';
 let definition:any;const copied:string[]=[],files:string[]=[],errors:string[]=[];
 g.Page=(p:any)=>definition=p;
 g.wx={env:{USER_DATA_PATH:'/synthetic'},getStorageSync:()=>structuredClone(state),setStorageSync(){},showToast(){},showModal(o:any){errors.push(o.content);},setClipboardData(o:any){copied.push(o.data);},getFileSystemManager(){return {writeFile(o:any){files.push(o.filePath);o.success();o.complete?.();}};}};
 try{
  await import('../miniprogram/pages/reports/reports');
  const page={...definition,data:structuredClone(definition.data),setData(v:any){Object.assign(this.data,v);}};
  page.onShow();assert.equal(page.data.manager,true);assert.equal(page.data.canExportNames,false);
  page.copy();for(const kind of ['txt','xlsx'])page.export({currentTarget:{dataset:{kind}}});assert.equal(copied.length,0);assert.equal(files.length,0);
  state.actorId='m7';page.onShow();assert.equal(page.data.canExportNames,true);
  page.copy();for(const kind of ['txt','xlsx'])page.export({currentTarget:{dataset:{kind}}});assert.equal(copied.length,1);assert.equal(files.length,2);assert.deepEqual(errors,[]);
  state.members.find(m=>m.id==='m6')!.role='officer';state.actorId='m6';page.onShow();assert.equal(page.data.manager,false);assert.equal(page.data.tab,'all');assert.equal(page.data.canExportExcel,true);assert.equal(page.data.canExportNames,false);
  const before=files.length;page.copy();page.export({currentTarget:{dataset:{kind:'txt'}}});assert.equal(files.length,before);assert.equal(copied.length,1);page.export({currentTarget:{dataset:{kind:'xlsx'}}});assert.equal(files.length,before+1);
 }finally{g.wx=old.wx;g.Page=old.Page;runtime.mode=old.mode;}
});
