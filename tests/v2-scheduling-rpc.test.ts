import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { PostgresRepository } from '../server/v2/postgres';
import { createGatewayV2 } from '../server/v2/gateway';
import { MemoryRepository } from '../server/v2/memory';
import { makeReviewSeed, reviewIdentity } from '../server/v2/review-seed';
import { ApiRequest, Commit, Entity, Query, Resource, RESOURCES } from '../miniprogram/domain/v2/protocol';
import { Repository } from '../server/v2/repository';

const container = process.env.XUEDU_LOCAL_PG_CONTAINER;
const pgtest = container ? test : test.skip;
const now = Date.parse('2026-10-14T00:00:00Z');
const literal = (v: unknown) => "'" + String(v).replace(/'/g,"''") + "'";
const quote = (v: unknown) => literal(JSON.stringify(v)) + '::jsonb';
const args = () => ['exec','-i',container!, 'psql','-U','postgres','-v','ON_ERROR_STOP=1','-Atq'];
const raw = (sql: string) => execFileSync('docker',args(),{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20_000_000}).trim();
const role = (name='service_role') => `SET ROLE ${name}; SET request.jwt.claims='{"role":"${name}"}'; `;
const calls: string[] = [];
const db = {async rpc(name: string, a: Record<string, unknown>) {
  calls.push(name);
  const values = name === 'xuedu_v2_bootstrap_page' ? [literal(a.p_identity_key),quote(a.p_request),a.p_can_initialize?'true':'false'].join(',')
    : name === 'xuedu_v2_scheduling_read' ? [literal(a.p_identity_key),quote(a.p_request)].join(',')
    : name === 'xuedu_v2_workspace' ? '' : name === 'xuedu_v2_commit' ? quote(a.p_command)
    : [literal(a.p_resource),quote(a.p_query)].join(',');
  try { return {data:JSON.parse(raw(role()+`SELECT public.${name}(${values});`)),error:null}; }
  catch(e) {const message=String((e as {stderr?:unknown}).stderr); return {data:null,error:{message,code:message.includes('could not obtain lock')?'55P03':''}};}
}};
function synthetic(people=40, classes=20) {
  const s=makeReviewSeed('synthetic','local',now,3000);s.workspace.id='main';
  const ep=s.workspace.epoch, sid=s.workspace.activeSemesterId;
  for(const o of s.rows.occurrences!) (o.data.course as Record<string,unknown>).semesterId=sid;
  for(let i=4;i<people;i++) {
    const id='member-'+String(i).padStart(3,'0');
    s.rows.members!.push({id,epoch:ep,version:1,studentNo:id,data:{name:'合成成员'+i,role:'member',active:true,classId:'review-class-a',studentNo:id}});
    s.rows.availability!.push({id:'av-'+id,epoch:ep,version:1,semesterId:sid,week:2,memberId:id,data:{slots:['1:3','1:4'],optedIn:false}});
  }
  for(let i=2;i<classes;i++) {
    const id='class-'+String(i).padStart(3,'0'), klass={id,name:'合成班级'+i,grade:'26',major:'合成',active:true};
    const course={id:'course-'+i,semesterId:sid,name:'合成课程'+i,teacher:'合成教师',nature:'必修',classIds:[id],weekday:1,start:3,end:4,classroom:'模拟',weeks:[2],expected:30};
    s.rows.classes!.push({id,epoch:ep,version:1,data:klass});
    s.rows.semester_classes!.push({id:'link-'+i,epoch:ep,version:1,semesterId:sid,parentId:id,data:{}});
    s.rows.occurrences!.push({id:'occ-'+i,epoch:ep,version:1,semesterId:sid,week:2,date:'2026-10-19',data:{course,classes:[klass],classLabel:klass.name,status:'active'}});
  }
  return s;
}
function seed(s=synthetic()) {
  const statements = [`TRUNCATE ${['workspace',...RESOURCES].map(r=>'xuedu_v2.'+r).join(',')};`,
    `INSERT INTO xuedu_v2.workspace(id,epoch,version,permissions_version,active_semester_id,max_execution_ms) VALUES('main',${literal(s.workspace.epoch)},1,1,${literal(s.workspace.activeSemesterId)},3000);`];
  for(const [r,rows] of Object.entries(s.rows)) {
    const mapped=rows.map(e=>({id:e.id,epoch:e.epoch,version:e.version,data:e.data,semester_id:e.semesterId,week:e.week,member_id:e.memberId,task_id:e.taskId,record_id:e.recordId,parent_id:e.parentId,identity_key:e.identityKey,student_no:e.studentNo,date:e.date,sort_key:e.sortKey}));
    statements.push(`INSERT INTO xuedu_v2.${r} SELECT * FROM jsonb_populate_recordset(NULL::xuedu_v2.${r},${quote(mapped)});`);
  }
  raw(statements.join('\n'));calls.length=0;return s;
}
function gateway(repository: Repository) {
  let seq=0;
  return createGatewayV2({repository,appid:'app',bootstrapOpenid:'unused',maxExecutionMs:3000,now:()=>now,uuid:()=>`generated-${++seq}`,
    photos:{async upload(){throw Error('unused');},async list(){return [];},async delete(){},async urls(){return [];}}});
}
const context=(who='admin')=>({OPENID:reviewIdentity('synthetic',who as 'admin'),APPID:'app'});
const req=(kind='planGenerate',extra:Partial<ApiRequest>={}):ApiRequest=>({protocolVersion:2,operation:kind==='members'?'query':'command',epoch:'review-local',semesterId:'review-semester',requestId:'request-'+kind,expectedVersion:0,
  readHint:{memberId:'forged-hint'},payload:kind==='members'?{kind}:{type:kind,week:2},...extra});
const adjust=(changes:Record<string,unknown>[],extra:Partial<ApiRequest>={})=>req('taskAdjust',{payload:{type:'taskAdjust',week:2,reason:'合成补排',changes},...extra});
function legacy(s:ReturnType<typeof synthetic>) {
  const memory=new MemoryRepository(s.workspace,s.rows,()=>now);let count=0;
  const repository=new PostgresRepository({async rpc(name,a) {
    count++;
    if(name==='xuedu_v2_workspace')return {data:await memory.workspace(),error:null};
    if(name==='xuedu_v2_commit')return {data:await memory.commit(a.p_command as Commit),error:null};
    if(name==='xuedu_v2_query')return {data:await memory.query(a.p_resource as Resource,a.p_query as Query),error:null};
    throw Error(name);
  }});
  repository.schedulingRead=async()=>null;
  return {api:gateway(repository),count:()=>count};
}

test('scheduling adapter falls back only for absent migration, never for permission/lock/database errors',async()=>{
  let n=0;
  const missing=new PostgresRepository({async rpc(){n++;return {data:null,error:{code:'PGRST202'}};}});
  assert.equal(await missing.schedulingRead('wx',{}),null);assert.equal(await missing.schedulingRead('wx',{}),null);assert.equal(n,1);
  for(const [error,expected] of [[{code:'55P03'},'VERSION_CONFLICT'],[{message:'FORBIDDEN'},'FORBIDDEN'],[{message:'secret SQL'},'DATABASE_UNAVAILABLE']] as const) {
    const repo=new PostgresRepository({async rpc(){return {data:null,error};}});
    await assert.rejects(repo.schedulingRead('wx',{}),new RegExp(expected));
  }
});
pgtest('scheduling RPC: 4 and 40 people produce identical drafts with three RPCs regardless of class count',async()=>{
  for(const [people,classes] of [[4,2],[40,20]]) {
    const s=seed(synthetic(people,classes));const old=legacy(s);const before=await old.api(req(),context());
    const start=performance.now();const actual=await gateway(new PostgresRepository(db))(req(),context());
    const elapsed=Math.round(performance.now()-start);
    assert.deepEqual(calls,['xuedu_v2_scheduling_read','xuedu_v2_commit','xuedu_v2_workspace']);
    assert.deepEqual(actual,before);assert.ok(!JSON.stringify(actual).includes('identityKey'));
    console.log(`Synthetic ${people} people / ${classes} classes: draft RPC ${old.count()} -> ${calls.length}; local Docker end-to-end ${elapsed}ms (not cloud timing)`);
    assert.deepEqual(actual.data.changed,[]);
    assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.tasks WHERE parent_id="+literal(actual.data.planId)+" AND data->>'status'='draft' AND NOT coalesce((data->>'cancel')::boolean,false)")),classes);
  }
});
pgtest('scheduling RPC: member list stays paginated and redacted; 40 people requires two RPCs',async()=>{
  const s=seed();const old=legacy(s);const api=gateway(new PostgresRepository(db));
  for(const who of ['admin','leader']) {
    let cursor='';const ids:string[]=[];
    do {
      const request=req('members',{limit:13,cursor,payload:{kind:'members',version:1}});calls.length=0;
      const actual=await api(request,context(who));const expected=await old.api(request,context(who));
      assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)));
      assert.deepEqual(calls,['xuedu_v2_scheduling_read','xuedu_v2_workspace']);
      ids.push(...(actual.data.items as Entity[]).map(e=>e.id));cursor=actual.cursor || '';
      if(who==='leader')assert.ok((actual.data.items as Entity[]).every(e=>!e.studentNo&&!e.data.studentNo));
    }while(cursor);
    assert.equal(new Set(ids).size,40);
  }
  calls.length=0;const oldCount=old.count();await old.api(req('members',{readHint:{memberId:'review-admin'}}),context());const before=old.count()-oldCount;
  assert.equal((await api(req('members'),context())).data.items instanceof Array,true);
  assert.equal(calls.length,2);
  console.log(`Synthetic 40 people: open adjustment member list RPC ${before} -> 2 (one client page)`);
});
pgtest('scheduling RPC: adjustment draft matches legacy; repeat call is idempotent and preserves completed work',async()=>{
  const s=seed();const old=legacy(s);const repository=new PostgresRepository(db);const api=gateway(repository);
  const request=adjust([{memberId:'member-004',occurrenceId:'occ-2'},{memberId:'member-005',occurrenceId:'occ-3'}]);
  const expected=await old.api(request,context());const actual=await api(request,context());
  assert.deepEqual(actual,expected);assert.deepEqual(calls,['xuedu_v2_scheduling_read','xuedu_v2_commit','xuedu_v2_workspace']);
  calls.length=0;assert.deepEqual((await api(request,context())).data,actual.data);assert.equal(calls.length,2);
  assert.equal(raw("SELECT data->>'status' FROM xuedu_v2.tasks WHERE id='review-task-done'"),'submitted');
  console.log(`Synthetic 40 people / 2 adjustments: draft RPC ${old.count()} -> 3; replay -> 2`);
});
pgtest('scheduling RPC: trusted identity, roles, epoch, maintenance, semester/week and paging bounds remain enforced',async()=>{
  seed();const api=gateway(new PostgresRepository(db));
  for(const who of ['member','leader','stranger'])await assert.rejects(api(req(),context(who)),/FORBIDDEN/);
  await assert.rejects(api(req(),{...context(),APPID:'wrong'}),/微信身份/);
  await assert.rejects(api(req('members'),context('officer')),/FORBIDDEN/);
  await assert.rejects(api(adjust([{memberId:'member-004',occurrenceId:'occ-2'}]),context('officer')),/FORBIDDEN/);
  await assert.rejects(api(req('members',{limit:101}),context()),/INVALID_QUERY/);
  await assert.rejects(api(req('members',{payload:{kind:'members',version:0}}),context()),/VERSION_CONFLICT/);
  await assert.rejects(api(req('planGenerate',{epoch:'old'}),context()),/EPOCH_CHANGED/);
  await assert.rejects(api(req('planGenerate',{semesterId:'missing'}),context()),/INVALID_QUERY/);
  await assert.rejects(api(req('planGenerate',{payload:{type:'planGenerate',week:5}}),context()),/INVALID_QUERY/);
  raw("UPDATE xuedu_v2.workspace SET maintenance='paused'");
  await assert.rejects(api(req(),context()),/MAINTENANCE/);await assert.rejects(api(req('members'),context()),/维护/);
  raw("UPDATE xuedu_v2.workspace SET maintenance=''; UPDATE xuedu_v2.members SET data=jsonb_set(data,'{active}','false') WHERE id='review-admin'");
  await assert.rejects(api(req(),context()),/FORBIDDEN/);
});
pgtest('scheduling RPC: cannot assign own class, partial availability, duplicate weekly task, wrong week, or completed task',async()=>{
  seed();const api=gateway(new PostgresRepository(db));
  for(const [changes,message] of [
    [[{memberId:'review-member',occurrenceId:'review-occ-a2'}],/本人班级/],
    [[{memberId:'review-leader',occurrenceId:'occ-2'}],/完整可用/],
    [[{memberId:'member-004',occurrenceId:'occ-2'},{memberId:'member-004',occurrenceId:'occ-3'}],/每人每周/],
    [[{memberId:'member-004',occurrenceId:'review-occ-b1'}],/不存在|周次/],
  ] as [Record<string,unknown>[],RegExp][])await assert.rejects(api(adjust(changes),context()),message);
  await assert.rejects(api(adjust([{taskId:'review-task-done',cancel:true}],{expectedVersion:1,payload:{type:'taskAdjust',week:1,reason:'合成拒绝',changes:[{taskId:'review-task-done',cancel:true}]}}),context()),/未提交/);
  assert.equal(raw('SELECT version FROM xuedu_v2.workspace'),'1');
});
pgtest('scheduling RPC: changes between read/commit, including availability and permission revocation, conflict atomically',async()=>{
  for(const mutation of [
    "UPDATE xuedu_v2.availability SET version=version+1 WHERE id='av-member-004'",
    "UPDATE xuedu_v2.workspace SET version=version+1",
    "UPDATE xuedu_v2.workspace SET permissions_version=permissions_version+1; UPDATE xuedu_v2.members SET data=jsonb_set(data,'{role}','\"member\"') WHERE id='review-admin'",
    "UPDATE xuedu_v2.bindings SET identity_key='revoked' WHERE member_id='review-admin'",
  ]) {
    seed();const repository=new PostgresRepository(db);const commit=repository.commit.bind(repository);
    repository.commit=async c=>{raw(mutation);return commit(c);};
    await assert.rejects(gateway(repository)(adjust([{memberId:'member-004',occurrenceId:'occ-2'}]),context()),/VERSION_CONFLICT|IDENTITY_CHANGED/);
    assert.equal(raw("SELECT count(*) FROM xuedu_v2.plans WHERE data->>'status'='draft'"),'0');
  }
});
pgtest('scheduling RPC: concurrent drafts have one winner; revocation after commit or list read never returns stale private data',async()=>{
  seed();const repository=new PostgresRepository(db);const api=gateway(repository);
  const settled=await Promise.allSettled([api(req(),context()),api(req('planGenerate',{requestId:'other'}),context())]);
  assert.equal(settled.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(raw("SELECT count(*) FROM xuedu_v2.plans WHERE data->>'status'='draft'"),'1');
  for(const request of [req('members'),req()]) {
    seed();const r=new PostgresRepository(db);const workspace=r.workspace.bind(r);
    r.workspace=async()=>{raw('UPDATE xuedu_v2.workspace SET permissions_version=permissions_version+1');return workspace();};
    await assert.rejects(gateway(r)(request,context()),/权限已变化/);
  }
});
pgtest('scheduling RPC: service-only grants and internal guard; NOWAIT prevents waiting behind a writer',async()=>{
  seed();const sql=`SELECT public.xuedu_v2_scheduling_read(${literal(context().OPENID)},${quote({kind:'members',epoch:'review-local'})});`;
  for(const who of ['anon','authenticated']) assert.throws(()=>raw(role(who)+sql),/Command failed/);
  assert.throws(()=>raw("SET request.jwt.claims='{\"role\":\"anon\"}';"+sql),/Command failed/);
  const locker=spawn('docker',args(),{stdio:['pipe','pipe','pipe']});
  try {
    const ready=new Promise<void>((resolve,reject)=>{locker.stdout.on('data',d=>{if(String(d).includes('locked'))resolve();});locker.on('error',reject);});
    locker.stdin.write("BEGIN; SELECT 1 FROM xuedu_v2.workspace WHERE id='main' FOR UPDATE; SELECT 'locked';\n");await ready;
    await assert.rejects(new PostgresRepository(db).schedulingRead(context().OPENID,{kind:'members',epoch:'review-local'}),/VERSION_CONFLICT/);
  }finally{locker.stdin.end('ROLLBACK;\n');await new Promise<void>(resolve=>locker.on('exit',()=>resolve()));}
});
pgtest('scheduling RPC: internal read bound rejects excess data instead of silently dropping rows',async()=>{
  seed();raw(`INSERT INTO xuedu_v2.plans(id,epoch,version,semester_id,week,data) SELECT 'excess-'||i,'review-local',1,'review-semester',2,'{"status":"draft"}'::jsonb FROM generate_series(1,5001) i`);
  await assert.rejects(gateway(new PostgresRepository(db))(req(),context()),/SCHEDULING_LIMIT/);
  assert.equal(raw('SELECT version FROM xuedu_v2.workspace'),'1');
});

pgtest('schedule bootstrap: administrator receives selected-week active course options in one RPC, other roles do not',async()=>{
  seed();const repository=new PostgresRepository(db);const api=gateway(repository);
  for(const who of ['admin','leader','officer','member']) {
    const request:ApiRequest={protocolVersion:2,operation:'bootstrap',epoch:'review-local',payload:{fastPage:true,page:{view:'schedule',semesterId:'review-semester',week:2}}};
    calls.length=0;const fast=await api(request,context(who));assert.deepEqual(calls,['xuedu_v2_bootstrap_page']);
    const slow=await api({...request,payload:{...request.payload,fastPage:false}},context(who));
    assert.deepEqual(JSON.parse(JSON.stringify(fast.data.page)),JSON.parse(JSON.stringify(slow.data.page)));
    const page=fast.data.page as {weekData:{occurrences:Entity[]}};
    assert.equal(page.weekData.occurrences.length,who==='admin'?20:0);
    assert.ok(page.weekData.occurrences.every(o=>o.week===2&&o.semesterId==='review-semester'&&o.data.status==='active'));
  }
});
pgtest('scheduling RPC: officer retains draft generation; task confirmation remains a separate administrator action',async()=>{
  seed();const api=gateway(new PostgresRepository(db));const result=await api(req(),context('officer'));
  assert.deepEqual(result.data.changed,[]);
  assert.ok(Number(raw("SELECT count(*) FROM xuedu_v2.tasks WHERE parent_id="+literal(result.data.planId)+" AND data->>'status'='draft'"))>0);
  assert.equal(raw("SELECT count(*) FROM xuedu_v2.tasks WHERE parent_id="+literal(result.data.planId)+" AND data->>'status'<>'draft'"),'0');
  assert.equal(calls.length,3);
});

pgtest('scheduling receipts: large regenerate/confirm/adjust/skip fit 128 KiB and replay without rewriting business rows',async()=>{
  const s=synthetic(35,26);
  for(const available of s.rows.availability!) available.data.slots=[1,2,3,4,5].flatMap(day=>[`${day}:3`,`${day}:4`]);
  for(const occurrence of [...s.rows.occurrences!].filter(o=>o.week===2)) {
    const course=occurrence.data.course as Record<string,unknown>;
    course.name='合成课程：数据结构与算法分析';course.teacher='合成教师';course.classroom='合成教学楼01-0401';
    course.weekday=1;course.start=3;course.end=4;
    for(let i=1;i<=4;i++) {
      const other=structuredClone(occurrence);other.id=occurrence.id+'-option-'+i;
      other.date=`2026-10-${19+i}`;other.data.date=other.date;
      other.data.course={...course,id:String(course.id)+'-option-'+i,weekday:i+1};
      s.rows.occurrences!.push(other);
    }
  }
  seed(s);
  const repository=new PostgresRepository(db),api=gateway(repository);
  const stableRows=()=>raw("SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t WHERE week=1),'records',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM xuedu_v2.records r))");
  const protectedRows=stableRows();
  const originalCommit=repository.commit.bind(repository);
  let legacyReceiptBytes=0;
  repository.commit=async c=>{
    if(c.requestId==='receipt-regenerate') {
      // Reproduce the old result shape against the actual PostgreSQL CHECK,
      // only in this disposable local database. Its failed transaction must
      // roll back the superseding/new tasks as well as the oversized receipt.
      const changed=c.changes.filter(ch=>ch.value&&!['bindings','photos','audit'].includes(ch.resource))
        .map(ch=>({...ch.value!,version:ch.expectedVersion+1}));
      const old={...c,result:{changed,refresh:c.result.refresh}};
      legacyReceiptBytes=Number(raw(`SELECT octet_length(${quote({result:old.result,permissionsVersion:c.permissionsVersion,actorId:c.actorId})}::text)`));
      assert.ok(legacyReceiptBytes>131072,`old receipt has ${legacyReceiptBytes} bytes`);
      const before=raw("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t"),version=(await repository.workspace()).version;
      assert.throws(()=>raw(role()+`SELECT public.xuedu_v2_commit(${quote(old)})`),/requests_data_check/);
      assert.equal(raw("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t"),before);
      assert.equal((await repository.workspace()).version,version);
    }
    return originalCommit(c);
  };
  const run=async(request:ApiRequest)=>{
    const result=await api(request,context());
    assert.deepEqual(result.data.changed,[]);
    assert.equal(typeof result.data.planId,'string');assert.equal(typeof result.data.planVersion,'number');
    assert.ok((result.data.refresh as string[]).includes('plans'));
    assert.ok((result.data.refresh as string[]).includes('tasks'));
    const plan=(await repository.get('plans',String(result.data.planId)))!;
    assert.equal(plan.version,result.data.planVersion);
    const receiptBytes=Number(raw("SELECT octet_length(data::text) FROM xuedu_v2.requests WHERE parent_id="+literal(request.requestId)));
    assert.ok(receiptBytes<1024);
    const version=(await repository.workspace()).version;
    assert.deepEqual((await api(request,context())).data,result.data);
    assert.equal((await repository.workspace()).version,version);
    assert.equal(stableRows(),protectedRows);
    return plan;
  };
  await run(req('planGenerate',{requestId:'receipt-initial'}));
  const regenerated=await run(req('planGenerate',{requestId:'receipt-regenerate'}));
  assert.equal(raw("SELECT count(*) FROM xuedu_v2.tasks WHERE week=2 AND data->>'status'='confirmed'"),'0');
  const confirmed=await run(req('planConfirm',{requestId:'receipt-confirm',expectedVersion:regenerated.version,payload:{type:'planConfirm',id:regenerated.id}}));
  const before=raw("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t WHERE week=2 AND data->>'status'='confirmed'");
  const formal=JSON.parse(before) as {id:string}[];assert.equal(formal.length,26);
  const replacement=await run(req('planGenerate',{requestId:'receipt-replace',expectedVersion:confirmed.version}));
  assert.equal(raw("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t WHERE week=2 AND data->>'status'='confirmed'"),before);
  const adjusted=await run(adjust(formal.map(t=>({taskId:t.id,cancel:true})),{requestId:'receipt-adjust',expectedVersion:confirmed.version}));
  assert.equal((await repository.get('plans',replacement.id))!.data.status,'superseded');
  const skip=await run(req('planSkip',{requestId:'receipt-skip',expectedVersion:confirmed.version,payload:{type:'planSkip',week:2,reason:'合成假期'}}));
  assert.equal((await repository.get('plans',adjusted.id))!.data.status,'superseded');
  assert.equal(raw("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t WHERE week=2 AND data->>'status'='confirmed'"),before);
  await run(req('planConfirm',{requestId:'receipt-confirm-skip',expectedVersion:skip.version,payload:{type:'planConfirm',id:skip.id}}));
  assert.equal(raw("SELECT count(*) FROM xuedu_v2.tasks WHERE week=2 AND data->>'status'='confirmed'"),'0');
  console.log(`Synthetic 35 people / 26 classes: old regeneration receipt ${legacyReceiptBytes} bytes rejected; all compact receipts <1024 bytes (local PostgreSQL only)`);
});
