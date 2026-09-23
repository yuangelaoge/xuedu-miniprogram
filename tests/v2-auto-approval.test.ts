import test from 'node:test';
import assert from 'node:assert/strict';
import {createGatewayV2} from '../server/v2/gateway';
import {MemoryRepository, EMPTY_WORKSPACE} from '../server/v2/memory';
import {ApiRequest, Entity, Commit, CLEAR_CONFIRMATION} from '../miniprogram/domain/v2/protocol';
const start=Date.parse('2026-09-23T00:00:00Z');
function setup(){
 let now=start,seq=0;
 const row=(id:string,data:Record<string,unknown>,extra:Partial<Entity>={}):Entity=>({id,epoch:'e1',version:1,data,...extra});
 const repo=new MemoryRepository({...EMPTY_WORKSPACE,epoch:'e1',version:1,activeSemesterId:'s1',maxExecutionMs:1000},{members:[row('a',{name:'管理员',studentNo:'001',classId:'c',role:'admin',active:true},{studentNo:'001'}),row('l',{name:'部长',studentNo:'002',classId:'c',role:'leader',active:true},{studentNo:'002'})],bindings:[row('ba',{},{identityKey:'owner',memberId:'a'}),row('bl',{},{identityKey:'leader',memberId:'l'})],classes:[row('c',{name:'26自动化',major:'自动化',grade:'26',active:true})],semesters:[row('s1',{name:'秋季',startDate:'2026-09-07',days:5,periods:14,weeks:20})]},()=>now);
 const api=createGatewayV2({repository:repo,appid:'app',bootstrapOpenid:'owner',uuid:()=>`aa-${++seq}`,now:()=>now,maxExecutionMs:1000,photos:{async upload(){throw Error('unused');},async list(){return [];},async delete(){},async urls(){return [];}}});
 const call=async(operation:string,payload:Record<string,unknown>={},who='owner',options:Partial<ApiRequest>={})=>{const w=await repo.workspace();return api({protocolVersion:2,operation,epoch:w.epoch,requestId:`req-${++seq}`,payload,...options},{OPENID:who,APPID:'app'});};
 const config=async(enabled=true,expiresAt=new Date(start+60000).toISOString())=>call('command',{type:'autoApprovalSet',enabled,expiresAt},'owner',{expectedVersion:(await repo.workspace()).version});
 const join=(who='new',studentNo='003',options:Partial<ApiRequest>={})=>call('command',{type:'join',name:'新成员',studentNo,classId:'c',role:'admin',active:true,now:start-999999},who,options);
 return {repo,api,call,config,join,setTime:(n:number)=>now=n};
}
test('自动审核设置仅管理员修改，必须未来截止时间；开关、人员和操作时间留痕',async()=>{
 const f=setup();const w=await f.repo.workspace();
 for(const who of ['leader','new'])await assert.rejects(f.call('command',{type:'autoApprovalSet',enabled:true,expiresAt:new Date(start+60000).toISOString()},who,{expectedVersion:w.version}),/管理员|审核/);
 for(const expiresAt of ['',new Date(start).toISOString(),'明天','2027-02-30T00:00:00Z'])await assert.rejects(f.config(true,expiresAt),/截止时间|未来|日期无效/);
 await f.config();const setting=(await f.repo.workspace()).autoApproval!;assert.equal(setting.updatedBy,'a');assert.equal(setting.updatedAt,new Date(start).toISOString());
 assert.equal((await f.call('query',{kind:'autoApproval'})).data.active,true);
 await assert.rejects(f.call('query',{kind:'autoApproval'},'leader'),/管理员/);
 f.setTime(start+1000);await f.config(false);assert.equal((await f.repo.workspace()).autoApproval!.enabled,false);
 const logs=(await f.repo.query('audit',{})).items;assert.deepEqual(logs.map(l=>l.data.action).sort(),['autoApprovalDisabled','autoApprovalEnabled']);
 assert.equal(logs.find(l=>l.data.action==='autoApprovalDisabled')!.data.at,new Date(start+1000).toISOString());
});
test('截止前1毫秒自动创建普通成员，恰好截止恢复待审核；忽略客户端时间和角色',async()=>{
 const f=setup();await f.config();f.setTime(start+59999);const r=await f.join();assert.equal(r.data.automaticallyApproved,true);
 const m=(await f.repo.query('members',{eq:{studentNo:'003'}})).items[0];assert.equal(m.data.role,'member');assert.equal(m.data.active,true);
 assert.equal(((await f.call('bootstrap',{},'new')).data.member as Entity).id,m.id);
 f.setTime(start+60000);assert.equal((await f.call('query',{kind:'autoApproval'})).data.active,false);assert.equal((await f.call('query',{kind:'autoApproval'})).data.expired,true);
 const p=await f.join('after','004');assert.equal(p.data.automaticallyApproved,false);assert.equal((await f.repo.query('members',{eq:{studentNo:'004'}})).items.length,0);assert.equal((await f.repo.query('applications',{eq:{identityKey:'after'}})).items[0].data.status,'pending');
 await f.config(false);assert.equal((await f.repo.get('members',m.id))!.data.active,true);
 const pub=(await f.call('bootstrap',{},'after')).data.workspace as {autoApproval?:unknown};assert.equal(pub.autoApproval,undefined);
});
test('重复微信、占用学号、已有待审核申请与移除身份不得绕过；同请求幂等',async()=>{
 const f=setup();await f.join('pending','004');await f.config();const pending=(await f.repo.query('applications',{eq:{identityKey:'pending'}})).items[0];
 await assert.rejects(f.join('pending','004',{expectedVersion:pending.version}),/重复提交/);
 await assert.rejects(f.join('duplicate','001'),/学号已登记/);
 const first=await f.join('new','003',{requestId:'fixed'});const retry=await f.join('new','003',{requestId:'fixed'});assert.deepEqual(retry.data,first.data);
 await assert.rejects(f.join(),/已有成员身份/);await assert.rejects(f.join('other','003'),/学号已登记/);
 const m=(await f.repo.query('members',{eq:{studentNo:'003'}})).items[0];await f.call('command',{type:'memberRemove',id:m.id,reason:'核查移除'},'owner',{expectedVersion:m.version});
 await assert.rejects(f.join(),/资格已取消/);assert.equal((await f.repo.query('applications',{eq:{identityKey:'new'}})).items.length,1);
});
test('事务再次核对截止时间，网关判断后到期不能创建成员',async()=>{
 const f=setup();await f.config();const commit=f.repo.commit.bind(f.repo);f.repo.commit=async c=>{if(c.autoJoin)f.setTime(start+60000);return commit(c);};
 await assert.rejects(f.join(),/已到期/);assert.equal((await f.repo.query('applications',{})).items.length,0);assert.equal((await f.repo.query('members',{})).items.length,2);
});
test('并发关闭和同学号竞争均不覆盖；数据库拒绝自动加入提权',async()=>{
 const f=setup();await f.config();const commit=f.repo.commit.bind(f.repo);let captured:Commit|undefined;
 f.repo.commit=async c=>{if(c.autoJoin){captured=structuredClone(c);await f.config(false);}return commit(c);};
 await assert.rejects(f.join(),/VERSION_CONFLICT/);assert.equal((await f.repo.query('members',{})).items.length,2);
 f.repo.commit=commit;await f.config();
 const current=await f.repo.workspace(),tampered={...captured!,workspaceVersion:current.version,permissionsVersion:current.permissionsVersion};tampered.changes.find(c=>c.resource==='members')!.value!.data.role='admin';await assert.rejects(commit(tampered),/FORBIDDEN/);
 const results=await Promise.allSettled([f.join('one','008'),f.join('two','008')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.repo.query('members',{eq:{studentNo:'008'}})).items.length,1);
});
test('自动通过人员分页可核查，只有管理员读取，清空后开关不沿用',async()=>{
 const f=setup();await f.config();for(let i=0;i<51;i++)await f.join(`u${i}`,`student${i}`);
 const first=await f.call('query',{kind:'autoApproved'});assert.equal((first.data.items as Entity[]).length,50);assert.ok(first.cursor);const second=await f.call('query',{kind:'autoApproved'},'owner',{cursor:first.cursor});assert.equal((second.data.items as Entity[]).length,1);
 const app=(first.data.items as Entity[])[0];assert.equal(app.data.approvalMode,'automatic');assert.equal(app.data.classLabel,'26自动化');assert.ok(app.data.reviewedAt);assert.equal(app.identityKey,undefined);
 await assert.rejects(f.call('query',{kind:'autoApproved'},'leader'),/管理员/);
 const p=await f.call('clearPreview');const begin=await f.call('clearBegin',{confirmation:CLEAR_CONFIRMATION},'owner',{expectedVersion:p.data.version as number});f.setTime(start+3000);
 for(let i=0;i<30;i++){if((await f.call('clearStep',{jobId:begin.data.jobId})).data.done)break;}
 assert.equal((await f.repo.workspace()).maintenance,'');assert.equal((await f.repo.workspace()).autoApproval,null);
});

test('管理员页面：未设截止不启用，日期时间按北京时间保存，自动通过列表和提前关闭',async()=>{
 const {runtime}=await import('../miniprogram/config/runtime');const {registerCloudPage}=await import('../miniprogram/services/v2/page');
 const g=globalThis as any,oldWx=g.wx,oldPage=g.Page,oldRuntime={...runtime};const f=setup();let registered:any;const errors:string[]=[];const storage=new Map();let page:any,joinPage:any,who='owner',destination='';
 runtime.mode='cloud';runtime.env='auto-approval-ui';g.Page=(o:any)=>registered=o;
 g.wx={getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:unknown)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),showToast(){},switchTab({url}:any){destination=url;},async showModal(o:any){errors.push(o.content);return {confirm:false};},cloud:{init(){},async callFunction({data}:any){try{return {result:{ok:true,data:await f.api(data,{OPENID:who,APPID:'app'})}};}catch(e){return {result:{ok:false,error:(e as Error).message}};}}}};
 try{
  registerCloudPage('manage');page={...registered,data:structuredClone(registered.data),setData(v:any){Object.assign(this.data,v);}};page.onLoad({});page.data.section='applications';await page.load();assert.equal(page.data.autoApprovalActive,false);
  await page.toggleAutoApproval({detail:{value:true}});await page.saveForm();assert.match(errors.pop()!,/截止日期和时间/);assert.equal((await f.repo.workspace()).autoApproval,undefined);
  page.data.fields=page.data.fields.map((field:any)=>({...field,value:field.key==='deadlineDate'?'2026-09-23':'08:01'}));await page.saveForm();assert.deepEqual(errors,[]);assert.equal((await f.repo.workspace()).autoApproval!.expiresAt,'2026-09-23T00:01:00.000Z');assert.equal(page.data.autoApprovalActive,true);
  await f.join();page.data.section='autoApproved';await page.load();assert.equal(page.data.rows.length,1);assert.match(page.data.rows[0].detail,/自动通过/);
  await page.toggleAutoApproval({detail:{value:false}});assert.equal(page.data.autoApprovalActive,false);assert.equal((await f.repo.query('members',{eq:{studentNo:'003'}})).items[0].data.active,true);
  await f.config();who='joining-from-page';registerCloudPage('join');joinPage={...registered,data:structuredClone(registered.data),setData(v:any){Object.assign(this.data,v);}};joinPage.onLoad({});await joinPage.load();await joinPage.openForm('join');
  joinPage.data.fields=joinPage.data.fields.map((field:any)=>({...field,value:field.key==='name'?'页面新人':field.key==='studentNo'?'009':'0'}));await joinPage.saveForm();assert.deepEqual(errors,[]);assert.equal(joinPage.data.role,'member');assert.equal(destination,'/pages/index/index');
 } finally {page?.onUnload();joinPage?.onUnload();g.wx=oldWx;g.Page=oldPage;Object.assign(runtime,oldRuntime);}
});
