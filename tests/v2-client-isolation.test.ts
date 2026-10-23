import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from '../miniprogram/config/runtime';
import {ApiRequest, ApiResponse, Entity} from '../miniprogram/domain/v2/protocol';
import {
  Boot, bootstrap, call, currentBoot, leaveReviewLocally, pageBootstrap,
  pageFreshnessKey, query, reviewActive, reviewControl, selectSemester,
} from '../miniprogram/services/v2/client';

type Envelope = {ok:true;data:ApiResponse<unknown>} | {ok:false;error:string;code?:string};
interface PendingCall {
  data: ApiRequest & {review?:boolean};
  resolve: (response:{result:Envelope}) => void;
  reject: (error:Error) => void;
}
const globals = globalThis as unknown as {wx:unknown};
let sequence = 0;
function harness() {
  const previousWx = globals.wx, originalRuntime = {...runtime};
  const storage = new Map<string,unknown>(), requests:PendingCall[] = [];
  runtime.mode='cloud'; runtime.env='client-isolation-'+(++sequence);
  globals.wx = {
    getStorageSync:(key:string)=>storage.get(key),
    setStorageSync:(key:string,value:unknown)=>storage.set(key,value),
    removeStorageSync:(key:string)=>storage.delete(key),
    cloud:{init(){},callFunction:({data}:{data:PendingCall['data']})=>
      new Promise<{result:Envelope}>((resolve,reject)=>requests.push({data,resolve,reject}))},
  };
  return {storage,requests,restore(){leaveReviewLocally();globals.wx=previousWx;Object.assign(runtime,originalRuntime);}};
}
const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
const entity = (id:string,data:Record<string,unknown>={}):Entity => ({id,epoch:'epoch-1',version:1,data});
function bootFor(request:PendingCall, actor='member', version=1, epoch='epoch-1'):Boot {
  return {
    status:'ready',canInitialize:false,member:entity(actor,{role:actor,active:true}),
    workspace:{id:'workspace',epoch,version,permissionsVersion:version,protocolVersion:2,
      activeSemesterId:'active',maintenance:'',maxExecutionMs:3000},
    ...(request.data.payload?.includeHome ? {home:{semester:entity('active'),week:8,weekData:null}} : {}),
    ...(request.data.payload?.page ? {page:{semester:entity('active'),week:Number((request.data.payload.page as {week?:number}).week || 8),list:{items:[],cursor:''}}} : {}),
  };
}
function reply(request:PendingCall, data:unknown=bootFor(request), version=1, epoch='epoch-1') {
  request.resolve({result:{ok:true,data:{protocolVersion:2,epoch,resourceVersions:{workspace:version},data}}});
}
function fail(request:PendingCall, error:string, code?:string) {
  request.resolve({result:{ok:false,error,code}});
}

test('页面隔离：排课超限仅拒绝原请求，记录和个人页各自发送并完成读取', async()=>{
  const h=harness();
  try {
    const schedule=pageBootstrap({view:'schedule',week:9});
    const failed=assert.rejects(schedule,/response size exceeded/);
    const records=pageBootstrap({view:'records',week:8});
    const profile=pageBootstrap({view:'profile'});
    assert.equal(h.requests.length,1);
    h.requests[0].reject(new Error('response size exceeded 1048576 Bytes'));
    await failed; await tick();
    assert.equal(h.requests.length,2);
    assert.equal((h.requests[1].data.payload?.page as {view:string}).view,'records');
    reply(h.requests[1]); await records; await tick();
    assert.equal(h.requests.length,3);
    assert.equal((h.requests[2].data.payload?.page as {view:string}).view,'profile');
    reply(h.requests[2]); const result=await profile;
    assert.equal(currentBoot(),result);
  } finally {h.restore();}
});

test('页面去重：同一页同一周共用请求，不同周串行且保留各自结果；失败后可以重试',async()=>{
  const h=harness();
  try {
    const first=pageBootstrap({view:'schedule',week:8}), duplicate=pageBootstrap({week:8,view:'schedule'});
    const next=pageBootstrap({view:'schedule',week:9});
    assert.equal(h.requests.length,1); reply(h.requests[0]);
    const [a,b]=await Promise.all([first,duplicate]);
    assert.equal(a,b); assert.equal(a.page?.week,8); await tick();
    assert.equal(h.requests.length,2); reply(h.requests[1]); assert.equal((await next).page?.week,9);
    const broken=pageBootstrap({view:'schedule',week:9});
    const rejected=assert.rejects(broken,/网络暂不可用/);
    h.requests[2].reject(new Error('网络暂不可用')); await rejected;
    const retry=pageBootstrap({view:'schedule',week:9});
    assert.equal(h.requests.length,4);reply(h.requests[3]);assert.equal((await retry).page?.week,9);
  } finally {h.restore();}
});

test('启动隔离：普通启动失败不阻止首页和页面独立验证，同类首页请求去重',async()=>{
  const h=harness();
  try {
    const basic=bootstrap(), failed=assert.rejects(basic,/暂不可用/);
    const home=bootstrap(true), records=pageBootstrap({view:'records'});
    fail(h.requests[0],'数据库暂不可用'); await failed;await tick();
    assert.equal(h.requests.length,2);reply(h.requests[1]);assert.ok((await home).home);await tick();
    assert.equal(h.requests.length,3);reply(h.requests[2]);await records;
    const rich=bootstrap(true), shared=bootstrap(true);
    assert.equal(h.requests.length,4);reply(h.requests[3]);
    const [a,b]=await Promise.all([rich,shared]);assert.equal(a,b);assert.ok(a.home);
  } finally {h.restore();}
});

test('启动隔离：首页超限不能连带普通启动，普通启动必须独立请求并成功',async()=>{
  const h=harness();
  try {
    const home=bootstrap(true), failed=assert.rejects(home,/response size exceeded/);
    const basic=bootstrap();
    assert.equal(h.requests.length,1);
    h.requests[0].reject(new Error('response size exceeded 1048576 Bytes'));
    await failed;await tick();
    assert.equal(h.requests.length,2);assert.equal(h.requests[1].data.payload,undefined);
    reply(h.requests[1]);const result=await basic;
    assert.equal(result.status,'ready');assert.equal(result.home,undefined);assert.equal(currentBoot(),result);
  } finally {h.restore();}
});

test('权限拒绝不会变成缓存成功：各页面仍须单独通过服务端校验',async()=>{
  const h=harness();
  try {
    const seed=bootstrap();reply(h.requests[0]);await seed;
    const before=pageFreshnessKey();
    const first=pageBootstrap({view:'schedule'}), second=pageBootstrap({view:'records'});
    const firstError=assert.rejects(first,/权限不足/),secondError=assert.rejects(second,/成员资格已取消/);
    fail(h.requests[1],'权限不足','FORBIDDEN');await firstError;await tick();
    assert.equal(h.requests.length,3);fail(h.requests[2],'成员资格已取消','FORBIDDEN');await secondError;
    assert.notEqual(pageFreshnessKey(),before);
  } finally {h.restore();}
});

test('切换身份：旧请求及等待中的页面不能覆盖新身份，也不能清除新请求的队列',async()=>{
  const h=harness();
  try {
    h.storage.set('xuedu.review.active.'+runtime.env,true);
    const seed=bootstrap();reply(h.requests[0],bootFor(h.requests[0],'admin'));await seed;
    const old=pageBootstrap({view:'schedule'}),queued=pageBootstrap({view:'records'});
    const oldError=assert.rejects(old,/轮次|身份/),queuedError=assert.rejects(queued,/身份/);
    const switchRole=reviewControl('reviewRole',{role:'member'});
    reply(h.requests[2],{role:'member'});await switchRole;
    const profile=pageBootstrap({view:'profile'});
    assert.equal(h.requests.length,4);
    reply(h.requests[3],bootFor(h.requests[3],'member'));await profile;
    reply(h.requests[1],bootFor(h.requests[1],'admin'));
    await Promise.all([oldError,queuedError]);
    assert.equal(currentBoot().member?.id,'member');assert.equal(h.requests.length,4);
    const retry=pageBootstrap({view:'records'});reply(h.requests[4]);await retry;
  } finally {h.restore();}
});

test('旧身份的过期错误不能清除新审核会话',async()=>{
  const h=harness();
  try {
    h.storage.set('xuedu.review.active.'+runtime.env,true);
    const old=pageBootstrap({view:'schedule'}),oldError=assert.rejects(old,/轮次/);
    const login=reviewControl('reviewLogin');reply(h.requests[1],{role:'member'});await login;
    const fresh=pageBootstrap({view:'profile'});reply(h.requests[2]);await fresh;
    fail(h.requests[0],'审核会话已过期','REVIEW_EXPIRED');await oldError;
    assert.equal(reviewActive(),true);assert.equal(currentBoot().member?.id,'member');
  } finally {h.restore();}
});

test('环境切换：旧请求不得覆盖新环境，旧环境排队页面不向新环境发送',async()=>{
  const h=harness();
  try {
    const old=pageBootstrap({view:'schedule'}),queued=pageBootstrap({view:'records'});
    const oldError=assert.rejects(old,/轮次|身份/),queuedError=assert.rejects(queued,/身份/);
    runtime.env+='-new';
    const fresh=pageBootstrap({view:'profile'});reply(h.requests[1],bootFor(h.requests[1],'new-member'));await fresh;
    reply(h.requests[0],bootFor(h.requests[0],'old-member'));await Promise.all([oldError,queuedError]);
    assert.equal(h.requests.length,2);assert.equal(currentBoot().member?.id,'new-member');
  } finally {h.restore();}
});

test('版本与轮次围栏：较旧读取不能覆盖较新状态，排队页面使用已确认轮次',async()=>{
  const h=harness();
  try {
    const seed=bootstrap();reply(h.requests[0]);await seed;
    const older=query('records'),oldError=assert.rejects(older,/版本/);
    const fresh=pageBootstrap({view:'profile'});reply(h.requests[2],bootFor(h.requests[2],'member',2),2);await fresh;
    reply(h.requests[1],{items:[]},1);await oldError;
    const previousEpoch=query('records'),epochError=assert.rejects(previousEpoch,/轮次/);
    const newEpoch=bootstrap();reply(h.requests[4],bootFor(h.requests[4],'member',3,'epoch-2'),3,'epoch-2');await newEpoch;
    reply(h.requests[3],{items:[]},2);await epochError;
    const queued=pageBootstrap({view:'profile'});
    assert.equal(h.requests[5].data.epoch,'epoch-2');reply(h.requests[5],bootFor(h.requests[5],'member',3,'epoch-2'),3,'epoch-2');await queued;
  } finally {h.restore();}
});

test('本机学期选择不会因排队合并而串周；冷启动仍恢复当前身份保存的学期',async()=>{
  const h=harness();
  try {
    const seed=bootstrap();reply(h.requests[0]);await seed;
    selectSemester('history-a');const a=pageBootstrap({view:'schedule',week:8});
    selectSemester('history-b');const b=pageBootstrap({view:'schedule',week:8});
    assert.equal((h.requests[1].data.payload?.page as {semesterId:string}).semesterId,'history-a');
    reply(h.requests[1]);await a;await tick();
    assert.equal((h.requests[2].data.payload?.page as {semesterId:string}).semesterId,'history-b');
    reply(h.requests[2]);await b;
    leaveReviewLocally();
    h.storage.set('xuedu.view.'+runtime.env+'.member','history-saved');
    const cold=pageBootstrap({view:'records'});reply(h.requests[3]);await tick();
    assert.equal((h.requests[4].data.payload?.page as {semesterId:string}).semesterId,'history-saved');
    const data=bootFor(h.requests[4]);data.page!.semester=entity('history-saved');reply(h.requests[4],data);await cold;
  } finally {h.restore();}
});

// Direct reads stay subject to the same fence; this import is exercised here to guard
// callers such as the independent next-week home request, which bypass pageBootstrap.
test('独立首页下周请求保留原错误，不影响后续页面重试',async()=>{
  const h=harness();
  try {
    const direct=call<Boot>('bootstrap',{payload:{fastPage:true,page:{view:'schedule',week:9}}});
    const rejected=assert.rejects(direct,/超限/);h.requests[0].reject(new Error('响应超限'));await rejected;
    const profile=pageBootstrap({view:'profile'});reply(h.requests[1]);assert.equal((await profile).status,'ready');
  } finally {h.restore();}
});
