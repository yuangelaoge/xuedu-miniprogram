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
let photoUrlCalls=0;
const db = { async rpc(name:string,a:Record<string,unknown>) {
  calls.push(name);
  const values = name==='xuedu_v2_bootstrap_page' ? [literal(a.p_identity_key),quote(a.p_request),a.p_can_initialize?'true':'false'].join(',')
    : ['xuedu_v2_scheduling_read','xuedu_v2_record_read'].includes(name) ? [literal(a.p_identity_key),quote(a.p_request)].join(',')
    : name==='xuedu_v2_workspace' ? '' : [literal(a.p_resource),quote(a.p_query)].join(',');
  try {return {data:JSON.parse(raw(role()+`SELECT public.${name}(${values});`)),error:null};}
  catch(e) {const message=String((e as {stderr?:unknown}).stderr);return {data:null,error:{message,code:message.includes('could not obtain lock')?'55P03':''}};}
}};
const repo=new PostgresRepository(db);
const deps={repository:repo,appid:'app',bootstrapOpenid:'wx-admin',uuid:()=> 'unused',maxExecutionMs:3000,
 photos:{async upload(){throw Error('unused');},async list(){return [];},async delete(){},async urls(){photoUrlCalls++;return [];}}};
const api=createGatewayV2(deps);
const request=(view:string,extra:Record<string,unknown>={},fast=true):ApiRequest=>({protocolVersion:2,operation:'bootstrap',epoch:'e',payload:{fastPage:fast,...(view==='home'?{includeHome:true}:{page:{view,...extra}})}});
const call=(view:string,extra:Record<string,unknown>={},who='wx-admin',fast=true)=>api(request(view,extra,fast),{OPENID:who,APPID:'app'});
const seed=(r:string,id:string,data:Record<string,unknown>,extra:Record<string,unknown>={})=>{
 const e={id,epoch:'e',version:1,data,...extra};
 raw(`INSERT INTO xuedu_v2.${r}(id,epoch,version,data,semester_id,week,member_id,task_id,identity_key,parent_id,record_id) VALUES (${literal(id)},'e',1,${quote(data)},${extra.semesterId?literal(extra.semesterId):'NULL'},${extra.week||'NULL'},${extra.memberId?literal(extra.memberId):'NULL'},${extra.taskId?literal(extra.taskId):'NULL'},${extra.identityKey?literal(extra.identityKey):'NULL'},${extra.parentId?literal(extra.parentId):'NULL'},${extra.recordId?literal(extra.recordId):'NULL'});`);
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
 seed('tasks','current-draft-task',{status:'draft'},{semesterId:'s',week:1,memberId:'member',parentId:'draft'});
 seed('tasks','superseded-task',{status:'superseded'},{semesterId:'s',week:1,memberId:'member',parentId:'old-plan'});
 seed('tasks','stale-draft-task',{status:'draft'},{semesterId:'s',week:1,memberId:'member',parentId:'old-plan'});
 seed('photos','private-photo',{storageId:'synthetic-private-storage'},{semesterId:'s',week:1,memberId:'admin',taskId:'t000',recordId:'r000'});
 seed('record_versions','admin-history',{photos:['private-photo'],notes:'synthetic history'},{semesterId:'s',week:1,memberId:'admin',recordId:'r000'});
 seed('tasks','pending-task',{status:'pendingAdjustment'},{semesterId:'s',week:1,memberId:'member'});
 seed('records','past-record',{classLabel:'old'},{semesterId:'historical',week:1,memberId:'member',taskId:'past-task'});
 seed('plans','confirmed',{status:'confirmed'},{semesterId:'s',week:1});
 seed('plans','old-plan',{status:'superseded'},{semesterId:'s',week:1});
 seed('plans','draft',{status:'draft',uncovered:[{label:'c',reason:'none'}]},{semesterId:'s',week:1});
 seed('availability','av',{slots:['1:1']},{semesterId:'s',week:2,memberId:'member'});
 seed('availability','old-av',{slots:['2:2']},{semesterId:'historical',week:1,memberId:'member'});
 seed('courses','course',{course:{name:'合成课程'}},{semesterId:'s'});
});
pgtest('page RPC: existing fast paths use one read; member text sharing uses bounded authenticated fallback; page shapes agree',async()=>{
 for(const who of ['wx-admin','wx-leader','wx-member','wx-officer']) for(const view of ['schedule','records','profile','courses','availability']) {
  const extra={week:1}; calls.length=0;
  const fast=await call(view,extra,who), fastCalls=[...calls];
  const memberTextFallback=who==='wx-member' && view==='records';
  if(memberTextFallback) {
   assert.equal(fastCalls[0],'xuedu_v2_bootstrap_page');
   assert.equal(fastCalls.length,11,'member text fallback remains bounded at 11 RPCs for one page');
   assert.equal(fast.data.readPath,undefined,'legacy own-only RPC cannot be reported as the full text result');
  } else {
   assert.deepEqual(fastCalls,['xuedu_v2_bootstrap_page']);assert.equal(fast.data.readPath,'single-rpc');
  }
  const old=await call(view,extra,who,false);
  assert.deepEqual(JSON.parse(JSON.stringify(fast.data.page)),JSON.parse(JSON.stringify(old.data.page)),who+'/'+view);
  assert.deepEqual(fast.data.member,old.data.member);assert.deepEqual(JSON.parse(JSON.stringify(fast.data.workspace)),JSON.parse(JSON.stringify(old.data.workspace)));
  assert.ok(!JSON.stringify(fast).includes('identityKey'));
  if(view==='schedule') {
   const ids=fast.data.page.weekData.tasks.map((task:Entity)=>task.id);
   for(const excluded of ['draft-task','superseded-task','stale-draft-task']) assert.ok(!ids.includes(excluded),excluded+' must not enter current schedule');
   assert.equal(ids.includes('current-draft-task'),who!=='wx-officer');
  }
 }
 const next=await call('availability',{},'wx-member');assert.equal(next.data.page.week,2);assert.equal(next.data.page.weekData.availability.id,'av');
 const historical=await call('availability',{semesterId:'historical',week:1},'wx-member');assert.equal(historical.data.page.weekData.availability.id,'old-av');
});
pgtest('page RPC: fast and fallback homes agree on own links and scoped summary without observation payloads',async()=>{
 const summaries:Record<string,{taskCount:number;recordCount:number;coverage:number}>={
  'wx-admin':{taskCount:58,recordCount:57,coverage:3},
  'wx-leader':{taskCount:58,recordCount:57,coverage:3},
  'wx-member':{taskCount:57,recordCount:56,coverage:3},
  'wx-officer':{taskCount:0,recordCount:0,coverage:0},
 };
 for(const who of ['wx-admin','wx-leader','wx-member','wx-officer']) {
  calls.length=0;const fast=await call('home',{},who);assert.deepEqual([...calls],['xuedu_v2_bootstrap_page']);
  calls.length=0;const fallback=await call('home',{},who,false), h=fast.data.home, old=fallback.data.home;
  if(who==='wx-admin') console.log('Home database round trips:',calls.length,'-> 1');
  assert.equal(h.week,1);assert.equal(old.week,1);
  assert.deepEqual(h.summary,summaries[who]);assert.deepEqual(old.summary,h.summary);
  const links=(rows:Entity[])=>rows.map(row=>({id:row.id,taskId:row.taskId,memberId:row.memberId}));
  assert.deepEqual(links(h.weekData.tasks),links(old.weekData.tasks));
  assert.deepEqual(links(h.weekData.records),links(old.weekData.records));
  for(const [label,result] of [['SQL',fast],['fallback',fallback]] as const) {
   const home=result.data.home;
   assert.ok(home.weekData.tasks.every((task:Entity)=>task.memberId===result.data.member.id));
   assert.ok(home.weekData.tasks.every((task:Entity)=>['confirmed','submitted','pendingAdjustment'].includes(String(task.data.status))));
   assert.ok(home.weekData.records.every((record:Entity)=>record.memberId===result.data.member.id));
   assert.ok(home.weekData.records.every((record:Entity)=>Object.keys(record.data).every(key=>key==='classLabel')));
   assert.doesNotMatch(JSON.stringify(home),/private-photo|observation|synthetic-private-storage/);
   assert.ok(Buffer.byteLength(JSON.stringify(result))<65536,label+' synthetic home response must stay small');
  }
  if(who==='wx-admin') console.log('Synthetic admin home response bytes (fallback / SQL):',Buffer.byteLength(JSON.stringify(fallback)),Buffer.byteLength(JSON.stringify(fast)));
 }
});
pgtest('page RPC: pagination remains 50 rows and does not recompute metadata on later pages',async()=>{
 const first=(await call('records',{week:1})).data.page;
 assert.equal(first.list.items.length,50);assert.equal(first.summary.submitted,57);
 const next=(await call('records',{week:1,more:true,cursor:first.list.cursor,selectionOwner:'admin'})).data.page;
 assert.equal(next.list.items.length,7);assert.equal(next.list.cursor,'');assert.equal(next.summary,undefined);assert.equal(next.semesters,undefined);
 assert.equal(new Set([...first.list.items,...next.list.items].map((r:Entity)=>r.id)).size,57);
 const member=(await call('records',{week:1},'wx-member')).data.page;
 assert.deepEqual(member.summary,{total:58,submitted:57,skipped:false});
 assert.equal(member.list.items.length,50);
 const other=member.list.items.find((record:Entity)=>record.id==='r000');
 assert.ok(other);assert.equal(other.data.photos,undefined);assert.match(other.data.notes,/observation/);
 assert.deepEqual(member.list.items.find((record:Entity)=>record.id==='r001').data.photos,['private-photo']);
});
pgtest('page RPC: officer sees every record but only own availability and no management metadata',async()=>{
 const first=(await call('records',{week:1},'wx-officer')).data.page;
 assert.equal(first.list.items.length,50);assert.equal(first.summary.submitted,57);assert.equal(first.summary.total,58);
 const next=(await call('records',{week:1,more:true,cursor:first.list.cursor,selectionOwner:'officer'},'wx-officer')).data.page;
 assert.equal(next.list.items.length,7);assert.equal(next.list.cursor,'');
 assert.equal(new Set([...first.list.items,...next.list.items].map((r:Entity)=>r.id)).size,57);
 assert.doesNotMatch(JSON.stringify([first,next]),/slots|identityKey/);
 const other=(await call('availability',{week:2,memberId:'member'},'wx-officer')).data.page;assert.equal(other.weekData.availability,null);
 seed('availability','officer-av',{slots:['3:3'],note:'own-only'},{semesterId:'s',week:2,memberId:'officer'});
 const own=(await call('availability',{week:2,memberId:'member'},'wx-officer')).data.page;assert.deepEqual(own.weekData.availability.data.slots,['3:3']);
 const profile=(await call('profile',{},'wx-officer')).data.page;assert.equal(profile.profile.pendingCount,0);
 raw("UPDATE xuedu_v2.members SET data=data||'{\"role\":\"member\"}' WHERE id='officer'");
 const downgraded=(await call('records',{week:1},'wx-officer')).data.page;
 assert.equal(downgraded.list.items.length,50);assert.deepEqual(downgraded.summary,{total:58,submitted:57,skipped:false});
 assert.ok(downgraded.list.items.every((record:Entity)=>record.data.photos===undefined),'member text access does not retain officer photo identifiers');
 const urlsBefore=photoUrlCalls;
 await assert.rejects(api({protocolVersion:2,operation:'photoUrls',epoch:'e',semesterId:'s',payload:{recordId:'r000'}},{OPENID:'wx-officer',APPID:'app'}),/不可查看他人照片/);
 assert.equal(photoUrlCalls,urlsBefore);
 raw("UPDATE xuedu_v2.members SET data=data||'{\"role\":\"officer\",\"active\":false}' WHERE id='officer'");
 assert.equal((await call('records',{week:1},'wx-officer')).data.page,null);
 raw("UPDATE xuedu_v2.members SET data=data||'{\"active\":true}' WHERE id='officer'");
});
pgtest('page RPC: member shared detail/history retain text but never expose another member photo or download capability',async()=>{
 const context={OPENID:'wx-member',APPID:'app'};
 const read=(kind:string,extra:Record<string,unknown>={})=>api({protocolVersion:2,operation:'query',epoch:'e',semesterId:'s',payload:{kind,...extra}},context);
 const detail=await read('record',{id:'r000'});
 assert.equal(detail.data.canEdit,false);assert.equal(detail.data.record.data.photos,undefined);
 assert.match(detail.data.record.data.notes,/observation/);
 const history=await read('recordVersions',{id:'r000'});
 assert.equal(history.data.items.length,1);assert.equal(history.data.items[0].data.notes,'synthetic history');
 assert.equal(history.data.items[0].data.photos,undefined);
 const before=photoUrlCalls;
 for(const payload of [{recordId:'r000'},{recordId:'r000',versionId:'admin-history'},{ids:['private-photo']}])
  await assert.rejects(api({protocolVersion:2,operation:'photoUrls',epoch:'e',semesterId:'s',payload},context),/不可查看他人照片/);
 assert.equal(photoUrlCalls,before,'no signed URL request may occur for denied photos');
 for(const kind of ['summaryReport','excelReport','namesReport','scheduleReport']) await assert.rejects(read(kind,{week:1}),/权限|仅管理员|FORBIDDEN/);
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
