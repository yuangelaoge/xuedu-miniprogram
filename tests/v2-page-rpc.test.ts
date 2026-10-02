import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { PostgresRepository } from '../server/v2/postgres';
import { createGatewayV2 } from '../server/v2/gateway';
import { ApiRequest, Entity } from '../miniprogram/domain/v2/protocol';

const container = process.env.XUEDU_LOCAL_PG_CONTAINER;
const pgtest = container ? test : test.skip;
const quote = (v: unknown) => "'" + JSON.stringify(v).replace(/'/g,"''") + "'::jsonb";
const literal = (v: unknown) => "'" + String(v).replace(/'/g,"''") + "'";
const args = () => ['exec','-i',container!, 'psql','-U','postgres','-v','ON_ERROR_STOP=1','-Atq'];
const raw = (sql:string) => execFileSync('docker',args(),{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const role = (name='service_role') => `SET ROLE ${name}; SET request.jwt.claims='{"role":"${name}"}'; `;
const calls:string[]=[];
const db = { async rpc(name:string,a:Record<string,unknown>) {
  calls.push(name);
  const values = name==='xuedu_v2_bootstrap_page' ? [literal(a.p_identity_key),quote(a.p_request),a.p_can_initialize?'true':'false'].join(',')
    : name==='xuedu_v2_workspace' ? '' : [literal(a.p_resource),quote(a.p_query)].join(',');
  try {return {data:JSON.parse(raw(role()+`SELECT public.${name}(${values});`)),error:null};}
  catch(e) {const message=String((e as {stderr?:unknown}).stderr);return {data:null,error:{message,code:message.includes('could not obtain lock')?'55P03':''}};}
}};
const repo=new PostgresRepository(db);
const deps={repository:repo,appid:'app',bootstrapOpenid:'wx-admin',uuid:()=> 'unused',maxExecutionMs:3000,
 photos:{async upload(){throw Error('unused');},async list(){return [];},async delete(){},async urls(){return [];}}};
const api=createGatewayV2(deps);
const request=(view:string,extra:Record<string,unknown>={},fast=true):ApiRequest=>({protocolVersion:2,operation:'bootstrap',epoch:'e',payload:{fastPage:fast,...(view==='home'?{includeHome:true}:{page:{view,...extra}})}});
const call=(view:string,extra:Record<string,unknown>={},who='wx-admin',fast=true)=>api(request(view,extra,fast),{OPENID:who,APPID:'app'});
const seed=(r:string,id:string,data:Record<string,unknown>,extra:Record<string,unknown>={})=>{
 const e={id,epoch:'e',version:1,data,...extra};
 raw(`INSERT INTO xuedu_v2.${r}(id,epoch,version,data,semester_id,week,member_id,task_id,identity_key) VALUES (${literal(id)},'e',1,${quote(data)},${extra.semesterId?literal(extra.semesterId):'NULL'},${extra.week||'NULL'},${extra.memberId?literal(extra.memberId):'NULL'},${extra.taskId?literal(extra.taskId):'NULL'},${extra.identityKey?literal(extra.identityKey):'NULL'});`);
 return e;
};
pgtest('page RPC: empty database remains read-only and only trusted initializer is eligible',async()=>{
 const boot=await call('home');
 assert.equal(boot.data.canInitialize,true);assert.equal(boot.data.status,'needsAdministrator');
 assert.equal(boot.data.executionConfigured,true);assert.equal(raw('SELECT count(*) FROM xuedu_v2.workspace'),'0');
 assert.equal((await call('home',{},'wx-stranger')).data.canInitialize,false);
 raw(`INSERT INTO xuedu_v2.workspace(id,epoch,version,permissions_version,active_semester_id,max_execution_ms,auto_approval)
 VALUES('main','e',1,1,'s',3000,'{"enabled":true,"expiresAt":"2099-01-01"}');`);
 const start=raw("SELECT ((current_timestamp AT TIME ZONE 'Asia/Shanghai')::date-extract(isodow FROM current_timestamp AT TIME ZONE 'Asia/Shanghai')::integer+1)::text");
 seed('semesters','s',{name:'合成学期',weeks:18,startDate:start,status:'active'});
 seed('semesters','historical',{name:'合成历史学期',weeks:18,startDate:'2020-09-07',status:'archived'});
 seed('classes','c',{name:'合成班级'});
 for(const [id,roleName] of [['admin','admin'],['member','member'],['leader','leader'],['officer','officer'],['removed','member']]) {
  seed('members',id,{name:id,role:roleName,active:id!=='removed',classId:'c',identityKey:'never-expose'});
  seed('bindings','b-'+id,{},{memberId:id,identityKey:'wx-'+id});
 }
 seed('applications','application',{status:'pending',identityKey:'wx-stranger'},{identityKey:'wx-stranger'});
 for(let i=0;i<57;i++) {
  const extra={semesterId:'s',week:1,memberId:i===0?'admin':'member'};
  seed('tasks','t'+String(i).padStart(3,'0'),{status:'submitted',classLabel:'c'+i%3},extra);
  seed('records','r'+String(i).padStart(3,'0'),{classLabel:'c'+i%3,photos:['private-photo'],notes:'observation '.repeat(200)}, {...extra,taskId:'t'+String(i).padStart(3,'0')});
 }
 seed('tasks','draft-task',{status:'draft'},{semesterId:'s',week:1,memberId:'member'});
 seed('tasks','pending-task',{status:'pendingAdjustment'},{semesterId:'s',week:1,memberId:'member'});
 seed('records','past-record',{classLabel:'old'},{semesterId:'historical',week:1,memberId:'member',taskId:'past-task'});
 seed('plans','confirmed',{status:'confirmed'},{semesterId:'s',week:1});
 seed('plans','draft',{status:'draft',uncovered:[{label:'c',reason:'none'}]},{semesterId:'s',week:1});
 seed('availability','av',{slots:['1:1']},{semesterId:'s',week:2,memberId:'member'});
 seed('availability','old-av',{slots:['2:2']},{semesterId:'historical',week:1,memberId:'member'});
 seed('courses','course',{course:{name:'合成课程'}},{semesterId:'s'});
});
pgtest('page RPC: all six page paths use exactly one database request; page shapes match existing gateway',async()=>{
 for(const who of ['wx-admin','wx-leader','wx-member','wx-officer']) for(const view of ['schedule','records','profile','courses','availability']) {
  const extra={week:1}; calls.length=0;
  const fast=await call(view,extra,who); assert.deepEqual(calls,['xuedu_v2_bootstrap_page']);
  const old=await call(view,extra,who,false);
  assert.deepEqual(JSON.parse(JSON.stringify(fast.data.page)),JSON.parse(JSON.stringify(old.data.page)),who+'/'+view);
  assert.deepEqual(fast.data.member,old.data.member);assert.deepEqual(fast.data.workspace,JSON.parse(JSON.stringify(old.data.workspace)));
  assert.equal(fast.data.readPath,'single-rpc');assert.ok(!JSON.stringify(fast).includes('identityKey'));
 }
 const next=await call('availability',{},'wx-member');assert.equal(next.data.page.week,2);assert.equal(next.data.page.weekData.availability.id,'av');
 const historical=await call('availability',{semesterId:'historical',week:1},'wx-member');assert.equal(historical.data.page.weekData.availability.id,'old-av');
});
pgtest('page RPC: home returns own links and aggregate counters instead of all observation data',async()=>{
 for(const who of ['wx-admin','wx-leader','wx-member','wx-officer']) {
  calls.length=0;const fast=await call('home',{},who);assert.deepEqual(calls,['xuedu_v2_bootstrap_page']);
  calls.length=0;const old=await call('home',{},who,false), h=fast.data.home, w=old.data.home.weekData;
  if(who==='wx-admin') console.log('Home database round trips:',calls.length,'-> 1');
  assert.equal(h.week,1);
  assert.deepEqual(h.summary,{taskCount:w.tasks.filter((t:Entity)=>['confirmed','submitted','pendingAdjustment'].includes(String(t.data.status))).length,
    recordCount:w.records.length,coverage:new Set(w.records.map((r:Entity)=>r.data.classLabel)).size});
  assert.ok(h.weekData.tasks.every((t:Entity)=>t.memberId===fast.data.member.id));
  assert.ok(h.weekData.records.every((r:Entity)=>r.memberId===fast.data.member.id));
  assert.ok(!JSON.stringify(h).includes('private-photo'));assert.ok(!JSON.stringify(h).includes('observation'));
  if(who==='wx-admin') {
   const ratio=Buffer.byteLength(JSON.stringify(fast))/Buffer.byteLength(JSON.stringify(old));
   assert.ok(ratio<0.1); console.log('Synthetic admin home response bytes:',Buffer.byteLength(JSON.stringify(old)),'->',Buffer.byteLength(JSON.stringify(fast)));
  }
 }
});
pgtest('page RPC: pagination remains 50 rows and does not recompute metadata on later pages',async()=>{
 const first=(await call('records',{week:1})).data.page;
 assert.equal(first.list.items.length,50);assert.equal(first.summary.submitted,57);
 const next=(await call('records',{week:1,more:true,cursor:first.list.cursor,selectionOwner:'admin'})).data.page;
 assert.equal(next.list.items.length,7);assert.equal(next.list.cursor,'');assert.equal(next.summary,undefined);assert.equal(next.semesters,undefined);
 assert.equal(new Set([...first.list.items,...next.list.items].map((r:Entity)=>r.id)).size,57);
 assert.equal((await call('records',{week:1},'wx-member')).data.page.summary.submitted,56);
});
pgtest('page RPC: rejects malformed selections, stale pagination and mixed identities',async()=>{
 for(const extra of [{week:0},{week:61},{week:1.5},{week:'1'},{cursor:123},{semesterId:[]},{more:'yes'},{more:true,selectionOwner:'other'}]) {
  await assert.rejects(call('records',extra),/INVALID_QUERY|IDENTITY_CHANGED/);
 }
 const stale={...request('records',{semesterId:'gone'}),epoch:'old'};
 assert.equal((await api(stale,{OPENID:'wx-admin',APPID:'app'})).data.page,null);
 await assert.rejects(api({...request('records',{more:true}),epoch:'old'},{OPENID:'wx-admin',APPID:'app'}),/EPOCH_CHANGED/);
 assert.equal((await call('records',{semesterId:'historical',selectionOwner:'other'},'wx-member')).data.page.semester.id,'s');
 await assert.rejects(api(request('home'),{OPENID:'wx-admin',APPID:'spoof'}),/微信身份无效/);
 for(const roleName of ['anon','authenticated']) assert.throws(()=>raw(role(roleName)+"SELECT public.xuedu_v2_bootstrap_page('wx-admin','{\"includeHome\":true}',true)"));
 assert.throws(()=>raw("SET request.jwt.claims='{\"role\":\"anon\"}';SELECT public.xuedu_v2_bootstrap_page('wx-admin','{\"includeHome\":true}',true)"));
});
pgtest('page RPC: unbound, inactive, maintenance and rebound identities never receive business pages',async()=>{
 for(const who of ['wx-stranger','wx-removed']) {
  const b=await call('records',{},who);assert.equal(b.data.member,null);assert.equal(b.data.page,null);
  assert.equal(b.data.removed,who==='wx-removed');assert.equal(b.data.workspace.autoApproval,undefined);
 }
 assert.equal((await call('home',{},'wx-stranger')).data.application.data.status,'pending');
 raw("UPDATE xuedu_v2.workspace SET maintenance='job'");
 assert.equal((await call('home')).data.home.weekData,null);assert.equal((await call('records')).data.page,null);
 raw("UPDATE xuedu_v2.workspace SET maintenance=''; UPDATE xuedu_v2.bindings SET identity_key='wx-new-member' WHERE member_id='member'");
 assert.equal((await call('records',{},'wx-member')).data.page,null);
 assert.equal((await call('records',{},'wx-new-member')).data.member.id,'member');
 raw("UPDATE xuedu_v2.bindings SET identity_key='wx-member' WHERE member_id='member'");
 const invalid=createGatewayV2({...deps,maxExecutionMs:0});assert.equal((await invalid(request('home'),{OPENID:'wx-admin',APPID:'app'})).data.executionConfigured,false);
});
pgtest('page RPC: larger history stays outside page results; measure database-only work separately',async()=>{
 raw(`INSERT INTO xuedu_v2.records(id,epoch,version,data,semester_id,week,member_id,task_id)
 SELECT 'history-'||i,'e',1,jsonb_build_object('notes',repeat('synthetic ',200)),'historical',1+(i%18),'member','history-task-'||i FROM generate_series(1,12000)i;
 ANALYZE xuedu_v2.records;`);
 const r=await call('records',{week:1});assert.equal(r.data.page.summary.submitted,57);
 const measured=raw(role()+`DO $$ DECLARE started timestamptz:=clock_timestamp(); BEGIN
 FOR i IN 1..100 LOOP PERFORM public.xuedu_v2_bootstrap_page('wx-admin','{"includeHome":true}',false); END LOOP;
 PERFORM set_config('xuedu.page_benchmark_ms',(extract(epoch FROM clock_timestamp()-started)*1000/100)::text,false);
 END $$; SELECT current_setting('xuedu.page_benchmark_ms');`);
 console.log('Local PostgreSQL home work average (100 warmed reads, 12,057 records, excludes network/cold start):',measured,'ms');
});
pgtest('page RPC: concurrent revocation fails fast during write and denies access after commit',async()=>{
 const child=spawn('docker',args(),{stdio:['pipe','pipe','pipe']});
 let output='';const ready=new Promise<void>((resolve,reject)=>{
  child.stdout.on('data',b=>{output+=b.toString();if(output.includes('LOCKED'))resolve();});child.on('error',reject);
  child.on('exit',()=>{if(!output.includes('LOCKED'))reject(Error('lock process exited before readiness'));});
 });
 const ended=new Promise<void>((resolve,reject)=>child.on('exit',code=>code===0?resolve():reject(Error('lock process failed'))));
 child.stdin.write("BEGIN; SELECT 1 FROM xuedu_v2.workspace WHERE id='main' FOR UPDATE; UPDATE xuedu_v2.members SET data=data||'{\"active\":false}' WHERE id='member'; SELECT 'LOCKED';\n");
 try {
  await ready;await assert.rejects(call('records',{},'wx-member'),/VERSION_CONFLICT/);
 } finally {child.stdin.end('COMMIT;\n');await ended;}
 assert.equal((await call('records',{},'wx-member')).data.page,null);
});
test('page RPC adapter: only missing migration permits fallback; database denial and conflicts never fall back',async()=>{
 for(const code of ['42883','PGRST202']) {
  let count=0;const r=new PostgresRepository({async rpc(){count++;return {data:null,error:{code}};}});
  assert.equal(await r.bootstrapPage('wx',{},false),null);assert.equal(await r.bootstrapPage('wx',{},false),null);assert.equal(count,1);
 }
 for(const code of ['42501','55P03','40001']) {
  const r=new PostgresRepository({async rpc(){return {data:null,error:{code}};}});
  await assert.rejects(r.bootstrapPage('wx',{},false),/DATABASE_UNAVAILABLE|VERSION_CONFLICT/);
 }
});
