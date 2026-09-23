import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayV2, PhotosV2 } from "../server/v2/gateway";
import { MemoryRepository, EMPTY_WORKSPACE } from "../server/v2/memory";
import { ApiRequest, Entity, Resource, CLEAR_CONFIRMATION, Query } from "../miniprogram/domain/v2/protocol";
const metrics = {expected:30,actual:29,late:0,early:0,sleep:0,phone:0,talk:0,other:0};
const row=(id:string,data:Record<string,unknown>,extra:Partial<Entity>={}):Entity=>({id,data,epoch:'e1',version:1,...extra});
function setup(extra: Partial<Record<Resource,Entity[]>> = {}) {
 const course={id:'course',semesterId:'s',name:'数学',teacher:'教师',nature:'必修',classIds:['c2'],classroom:'101',weekday:1,start:1,end:2,weeks:[2],expected:30};
 const classes=[{id:'c2',name:'听课班',grade:'25',major:'计科'}];
 const record=row('record',{metrics,photos:['photo'],course,classes,classLabel:'听课班',memberName:'成员',date:'2026-09-14',firstSubmittedAt:'2026-09-14T00:00:00.000Z',createdAt:'2026-09-14T00:00:00.000Z',revision:1},{semesterId:'s',week:2,memberId:'m',taskId:'t'});
 const repo=new MemoryRepository({...EMPTY_WORKSPACE,epoch:'e1',version:1,permissionsVersion:1,activeSemesterId:'s',maxExecutionMs:3000},{
  members:[row('a',{name:'管理员',role:'admin',active:true,classId:'c1'},{studentNo:'a'}),row('b',{name:'第二管理员',role:'admin',active:true,classId:'c1'},{studentNo:'b'}),row('m',{name:'成员',role:'member',active:true,classId:'c1'},{studentNo:'m'})],
  bindings:[row('ba',{},{identityKey:'wa',memberId:'a'}),row('bb',{},{identityKey:'wb',memberId:'b'}),row('bm',{},{identityKey:'wm',memberId:'m'})],
  classes:[row('c1',{name:'本班',grade:'25',major:'自动化',active:true}),row('c2',classes[0])],
  semesters:[row('s',{name:'秋',startDate:'2026-09-07',weeks:20,days:7,periods:14,grades:['25']})],
  occurrences:[row('o',{course,classes,status:'active'},{semesterId:'s',week:2,date:'2026-09-14'})],
  plans:[row('plan',{status:'confirmed'},{semesterId:'s',week:2})],
  tasks:[row('t',{course,classes,occurrenceId:'o',date:'2026-09-14',status:'confirmed'},{semesterId:'s',week:2,memberId:'m',parentId:'plan'})],
  records:[record], photos:[row('photo',{storageId:'pg://xuedu-photos/cloud/e1/photo.jpg'},{semesterId:'s',memberId:'m',taskId:'t',recordId:'record'})],
  availability:[row('av',{slots:['1:1','1:2']},{semesterId:'s',week:2,memberId:'m'})], ...extra
 });
 let now=Date.parse('2026-09-14T01:00:00Z'),id=0;
 const photos:PhotosV2={upload:async p=>'pg://xuedu-photos/'+p,urls:async ids=>ids,list:async()=>[],delete:async()=>{}};
 const queries:{resource:Resource;query:Query}[]=[];const original=repo.query.bind(repo);repo.query=async(resource,query)=>{queries.push({resource,query});return original(resource,query);};
 const api=createGatewayV2({repository:repo,appid:'app',bootstrapOpenid:'wa',maxExecutionMs:3000,now:()=>now,uuid:()=>`generated${++id}`,photos});
 const call=async(operation:string,payload:Record<string,unknown>={},extra:Partial<ApiRequest>&{who?:string}={})=>{const w=await repo.workspace();const{who,...rest}=extra;return api({protocolVersion:2,epoch:w.epoch,semesterId:'s',operation,payload,requestId:`r${++id}`,...rest},{OPENID:who||'wa',APPID:'app'});};
 return{repo,call,photos,queries,time:(delta:number)=>now+=delta};
}
test('invariant: role revocation prevents replay of privileged record data',async()=>{
 const f=setup();
 await f.call('command',{type:'recordEdit',id:'record',reason:'管理员更正',metrics,photos:['photo']},{expectedVersion:1,requestId:'privileged'});
 await f.call('command',{type:'roleChange',id:'a',role:'member',confirmed:true,reason:'换届撤销'},{who:'wb',expectedVersion:1});
 await assert.rejects(f.call('command',{type:'recordEdit',id:'record',reason:'重放',metrics,photos:['photo']},{expectedVersion:1,requestId:'privileged'}),/权限|身份|刷新|IDENTITY|FORBIDDEN/);
});
test('invariant: bootstrap does not scan historical membership rows',async()=>{
 const f=setup(); await f.call('bootstrap');
 assert.equal(f.queries.filter(q=>q.resource==='members').length,0);
});
test('invariant: failed clear step retried with same ID reacquires an exclusive persisted lease',async()=>{
 const f=setup();const file='pg://xuedu-photos/cloud/e1/test.jpg';f.photos.list=async()=>[file];f.photos.delete=async()=>{throw new Error('storage failure');};
 const begin=await f.call('clearBegin',{confirmation:CLEAR_CONFIRMATION},{expectedVersion:1});const jobId=String(begin.data.jobId);f.time(4001);
 await assert.rejects(f.call('clearStep',{jobId},{requestId:'retry-step'}),/storage failure/);f.time(4001);
 let active=0,maxActive=0;let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 f.photos.delete=async()=>{active++;maxActive=Math.max(maxActive,active);await gate;active--;};
 const attempts=[f.call('clearStep',{jobId},{requestId:'retry-step'}),f.call('clearStep',{jobId},{requestId:'retry-step'})];
 const pending=Promise.allSettled(attempts);await new Promise(resolve=>setTimeout(resolve,10));release();const results=await pending;
 assert.equal(maxActive,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('invariant: clearing cannot delete a returned file outside the fixed old epoch',async()=>{
 const f=setup();f.photos.list=async()=>['pg://xuedu-photos/cloud/new-epoch/keep.jpg'];let deleted=false;f.photos.delete=async()=>{deleted=true;};
 const begin=await f.call('clearBegin',{confirmation:CLEAR_CONFIRMATION},{expectedVersion:1});f.time(4001);
 await assert.rejects(f.call('clearStep',{jobId:begin.data.jobId}),/固定旧轮次/);assert.equal(deleted,false);
});
test('invariant: cross-record photo references remain forbidden even with same member ownership',async()=>{
 const f=setup();const w=await f.repo.workspace();await f.repo.commit({epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'wa',actorId:'a',requestId:'seed',reads:[],changes:[{resource:'photos',id:'other-photo',expectedVersion:0,value:row('other-photo',{storageId:'private'},{memberId:'m',taskId:'other-task',recordId:'other-record'})}],result:{}});
 await assert.rejects(f.call('command',{type:'recordEdit',id:'record',reason:'非法复用',metrics,photos:['other-photo']},{who:'wm',expectedVersion:1}),/其他记录/);
});
test('invariant: independent concurrent task adjustment drafts cannot both become current',async()=>{
 const f=setup();const w=await f.repo.workspace();await f.repo.commit({epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'wa',actorId:'a',requestId:'remove-fixture-record',reads:[],changes:[{resource:'records',id:'record',expectedVersion:1,value:null}],result:{}});
 const results=await Promise.allSettled([f.call('command',{type:'taskAdjust',week:2,reason:'第一组调整',changes:[{taskId:'t',cancel:true}]},{expectedVersion:1}),f.call('command',{type:'taskAdjust',week:2,reason:'第二组调整',changes:[{taskId:'t',cancel:true}]},{expectedVersion:1,who:'wb'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await f.repo.query('plans',{})).items.filter(p=>p.data.status==='draft').length,1);
 assert.equal((await f.repo.get('tasks','t'))!.data.status,'confirmed');
});
test('invariant: permission revocation during a read prevents returning a privileged result',async()=>{
 const f=setup();const original=f.repo.query.bind(f.repo);let injected=false;
 f.repo.query=async(resource,query)=>{
  if(resource==='records'&&!injected){injected=true;const w=await f.repo.workspace();const a=(await f.repo.get('members','a'))!;
   await f.repo.commit({epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'wb',actorId:'b',requestId:'revoke-during-read',reads:[],changes:[{resource:'members',id:a.id,expectedVersion:a.version,value:{...a,data:{...a.data,role:'member'}}}],result:{}});
  }
  return original(resource,query);
 };
 await assert.rejects(f.call('query',{kind:'records'}),/权限|身份|刷新|IDENTITY|FORBIDDEN/);
});

test('invariant: removal with over 5000 completed tasks reads only outstanding tasks and preserves history',async()=>{
 const tasks=Array.from({length:6000},(_,i)=>row(i===0?'t':'historic-'+i,{status:'submitted'},{semesterId:'s',week:2,memberId:'m'}));
 tasks.push(row('unfinished',{status:'confirmed'},{semesterId:'s',week:2,memberId:'m'}));
 const f=setup({tasks});const before=await f.repo.get('records','record');
 await f.call('command',{type:'memberRemove',id:'m',reason:'换届离组'},{expectedVersion:1});
 assert.equal((await f.repo.get('members','m'))!.data.active,false);
 assert.equal((await f.repo.get('tasks','unfinished'))!.data.status,'cancelled');
 assert.equal(await f.repo.count('tasks',{eq:{status:'submitted'}}),6000);
 assert.deepEqual(await f.repo.get('records','record'),before);
 assert.ok(f.queries.filter(q=>q.resource==='tasks').every(q=>q.query.in?.status?.includes('confirmed')));
});
test('invariant: clearing preview counts 12000 records without fetching historical entities',async()=>{
 const records=Array.from({length:12000},(_,i)=>row('record-'+i,{notes:'observations '.repeat(30)},{semesterId:'s',week:2,memberId:'m',taskId:'task-'+i}));
 const f=setup({records});const preview=await f.call('clearPreview');
 assert.equal(preview.data.records,12000);assert.equal(f.queries.filter(q=>q.resource==='records'||q.resource==='photos').length,0);
});
test('invariant: original initialization receipt is not readable after that WeChat binding is replaced',async()=>{
 const f=setup({requests:[row('init-receipt',{permissionsVersion:1,actorId:'a',result:{adminProfile:'private'}},{identityKey:'wa',parentId:'initialize-once'})]});
 const request=await f.call('command',{type:'rebindRequest',studentNo:'a',reason:'更换微信等待线下核实'},{who:'new-admin-wx'});
 const id=(request.data.changed as Entity[])[0].id;
 await f.call('command',{type:'rebindConfirm',id,reason:'已线下核实',confirmed:true},{who:'wb',expectedVersion:1});
 await assert.rejects(f.call('initialize',{}, {requestId:'initialize-once',who:'wa'}),/权限|身份|刷新|IDENTITY|FORBIDDEN/);
});
