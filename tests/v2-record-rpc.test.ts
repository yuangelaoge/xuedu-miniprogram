import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PostgresRepository } from '../server/v2/postgres';
import { createPhotos } from '../server/v2/photos';
import { createGatewayV2 } from '../server/v2/gateway';
import { makeReviewSeed, reviewIdentity } from '../server/v2/review-seed';
import { ApiRequest, Entity, RESOURCES } from '../miniprogram/domain/v2/protocol';
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
    : ['xuedu_v2_record_read','xuedu_v2_scheduling_read'].includes(name) ? [literal(a.p_identity_key),quote(a.p_request)].join(',')
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
let serial=0;
const ctx=(who='member')=>({OPENID:reviewIdentity('synthetic',who as 'member'),APPID:'app'});
const photo=(n=1):ApiRequest=>({protocolVersion:2,operation:'photo',epoch:'review-local',semesterId:'review-semester',requestId:'photo-'+n,payload:{taskId:'review-task-open',base64:Buffer.from([255,216,n,255,217]).toString('base64')}});
const metrics={expected:32,actual:30,late:0,early:0,sleep:0,phone:0,talk:0,other:0};
const submit=(ids:string[],id='submit'):ApiRequest=>({protocolVersion:2,operation:'command',epoch:'review-local',semesterId:'review-semester',expectedVersion:1,requestId:id,payload:{type:'recordSubmit',taskId:'review-task-open',metrics,photos:ids}});
const edit=(id='edit'):ApiRequest=>({protocolVersion:2,operation:'command',epoch:'review-local',semesterId:'review-semester',expectedVersion:1,requestId:id,payload:{type:'recordEdit',id:'review-record',metrics,photos:['review-photo-sample'],reason:'本地核对'}});
function api(repo:Repository,hooks:{uploaded?:()=>Promise<void>;now?:number}={}) {
 const files=new Map<string,Uint8Array>();let uploads=0;
 const photos=createPhotos({async upload(path,bytes,options){uploads++;assert.equal(options.upsert,true);files.set(path,bytes);await hooks.uploaded?.();return {data:{},error:null};},async list(){return {data:{objects:[],folders:[],hasNext:false},error:null};},async remove(){throw Error('must not delete');},async createSignedUrls(paths){return {data:paths.map(path=>({path,signedURL:'https://synthetic.invalid/'+path})),error:null};}},b=>Buffer.from(b,'base64'));
 return {call:createGatewayV2({repository:repo,appid:'app',bootstrapOpenid:'unused',photos,maxExecutionMs:3000,uuid:()=>`record-${++serial}`,now:()=>hooks.now ?? now}),files,uploads:()=>uploads};
}
pgtest('old-client writes: one photo, three RPCs per upload/submit/edit; fresh-ID retries reuse real success',async()=>{
 const n=1;
  seed();const fallback=new PostgresRepository(db);fallback.recordRead=async()=>null;
  const old=api(fallback),oldIds:string[]=[];
  for(let i=1;i<=n;i++) {calls.length=0;oldIds.push(String((await old.call(photo(i),ctx())).data.fileID));assert.equal(calls.length,9);}
  calls.length=0;await old.call(submit(oldIds),ctx());const oldCount=calls.length;assert.equal(oldCount,11+2*n);
  seed();const a=api(new PostgresRepository(db)),ids:string[]=[];
  for(let i=1;i<=n;i++) {calls.length=0;const r=await a.call(photo(i),ctx());ids.push(String(r.data.fileID));assert.deepEqual(calls,['xuedu_v2_record_read','xuedu_v2_commit','xuedu_v2_workspace']);assert.equal('writeState' in r.data,false);}
  calls.length=0;const request=submit(ids),r=await a.call(request,ctx());assert.equal(calls.length,3);assert.equal('writeState' in r.data,false);
  console.log(`Synthetic ${n} photo(s), unchanged old protocol: photo DB RPC=9 -> 3 + storage; recordSubmit DB RPC=${oldCount} -> 3 (not cloud timing)`);
  calls.length=0;assert.deepEqual((await a.call({...request,requestId:'fresh-client-id'},ctx())).data,r.data);assert.equal(calls.length,2);
  assert.deepEqual((await a.call({...request,requestId:'reordered',payload:Object.fromEntries(Object.entries(request.payload!).reverse())},ctx())).data,r.data);
  assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id='review-task-open'")),1);
  await assert.rejects(a.call({...request,requestId:'different-observation',payload:{...request.payload,metrics:{...metrics,actual:29}}},ctx()),/修改|VERSION|记录|提交/);
  calls.length=0;const saved=(r.data.changed as Entity[]).find(e=>e.data.firstSubmittedAt&&!e.recordId)!;
  const update={...edit(),expectedVersion:1,payload:{...edit().payload,id:saved.id,photos:ids}};
  const changed=await a.call(update,ctx());assert.equal(calls.length,3);assert.equal('writeState' in changed.data,false);
  assert.deepEqual((await a.call({...update,requestId:'new-edit-id'},ctx())).data,changed.data);
  const after=JSON.parse(raw(`SELECT data FROM xuedu_v2.records WHERE id=${literal(saved.id)}`));assert.equal(after.firstSubmittedAt,saved.data.firstSubmittedAt);assert.equal(after.revision,2);
  // A later explicit edit with the new version remains a distinct revision.
  await a.call({...update,requestId:'next-edit',expectedVersion:2},ctx());assert.equal(raw(`SELECT data->>'revision' FROM xuedu_v2.records WHERE id=${literal(saved.id)}`),'3');
});
pgtest('new submissions reject two or three photos without creating a record or completing the task',async()=>{
 for (const n of [2,3]) {
  seed();const a=api(new PostgresRepository(db)),ids:string[]=[];
  for(let i=1;i<=n;i++) ids.push(String((await a.call(photo(i),ctx())).data.fileID));
  const before=raw("SELECT version FROM xuedu_v2.workspace WHERE id='main'");
  await assert.rejects(a.call(submit(ids,'multi-photo-submit'),ctx()),/每份记录需上传1张签字照片/);
  // The gateway fallback enforces the same rule for a staged deployment without the read RPC.
  const fallback=new PostgresRepository(db);fallback.recordRead=async()=>null;
  await assert.rejects(api(fallback).call(submit(ids,'multi-photo-fallback'),ctx()),/每份记录需上传1张签字照片/);
  assert.equal(raw("SELECT version FROM xuedu_v2.workspace WHERE id='main'"),before);
  assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id='review-task-open'")),0);
  assert.equal(raw("SELECT data->>'status' FROM xuedu_v2.tasks WHERE id='review-task-open'"),'confirmed');
  assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.photos WHERE task_id='review-task-open' AND record_id IS NOT NULL")),0);
 }
});
pgtest('historical two- or three-photo records keep all original photos through corrections and fresh-ID retries',async()=>{
 for (const n of [2,3]) {
  const s=synthetic(),record=s.rows.records!.find(row=>row.id==='review-record')!;
  const source=s.rows.photos!.find(row=>row.id==='review-photo-sample')!,ids=[source.id];
  for(let i=1;i<n;i++) {
   const id='review-photo-legacy-'+i;ids.push(id);
   s.rows.photos!.push({...source,id,data:{...source.data,storageId:'synthetic-legacy-file-'+i}});
  }
  record.data.photos=ids.slice();
  for(const version of s.rows.record_versions!.filter(row=>row.recordId===record.id)) version.data.photos=ids.slice();
  seed(s);const a=api(new PostgresRepository(db));
  const request:ApiRequest={...edit(),payload:{...edit().payload,photos:ids}};
  calls.length=0;const corrected=await a.call(request,ctx('leader'));assert.equal(calls.length,3);
  calls.length=0;assert.deepEqual((await a.call({...request,requestId:'legacy-edit-new-id'},ctx('leader'))).data,corrected.data);assert.equal(calls.length,2);
  const after=JSON.parse(raw("SELECT data FROM xuedu_v2.records WHERE id='review-record'")) as Record<string,unknown>;
  assert.deepEqual(after.photos,ids);assert.equal(after.firstSubmittedAt,record.data.firstSubmittedAt);assert.equal(after.revision,2);
  const history=JSON.parse(raw("SELECT jsonb_agg(data ORDER BY version,id) FROM xuedu_v2.record_versions WHERE record_id='review-record'")) as Record<string,unknown>[];
  assert.equal(history.length,2);assert.ok(history.every(row=>JSON.stringify(row.photos)===JSON.stringify(ids)));
  // A different multi-photo set is not grandfathered in, even if it is made of the owner's photos.
  const replacement={...source,id:'review-photo-replacement',data:{...source.data,storageId:'synthetic-replacement'}};
  raw(`INSERT INTO xuedu_v2.photos(id,epoch,version,data,semester_id,member_id,task_id,record_id)
   VALUES(${literal(replacement.id)},${literal(replacement.epoch)},1,${quote(replacement.data)},${literal(replacement.semesterId)},${literal(replacement.memberId)},${literal(replacement.taskId)},${literal(replacement.recordId)});`);
  await assert.rejects(a.call({...request,requestId:'changed-legacy-photos',expectedVersion:2,
   payload:{...request.payload,photos:[...ids.slice(0,-1),replacement.id]}},ctx('leader')),/每份记录需上传1张签字照片/);
  assert.equal(raw("SELECT data->>'revision' FROM xuedu_v2.records WHERE id='review-record'"),'2');
 }
});
pgtest('lost responses: old-client new-ID retry recovers photo, submit and edit without duplicate revisions',async()=>{
 seed();const repo=new PostgresRepository(db);const commit=repo.commit.bind(repo);let lose=true;
 repo.commit=async c=>{const r=await commit(c);if(lose){lose=false;throw Error('lost response');}return r;};
 const a=api(repo);await assert.rejects(a.call(photo(),ctx()),/lost response/);const recovered=await a.call({...photo(),requestId:'new-photo-retry'},ctx());assert.ok(recovered.data.fileID);assert.equal(a.uploads(),1);
 const request=submit([String(recovered.data.fileID)]);lose=true;await assert.rejects(a.call(request,ctx()),/lost response/);const saved=await a.call({...request,requestId:'new-submit-retry'},ctx());assert.ok(saved.data.changed);assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id='review-task-open'")),1);
 lose=true;await assert.rejects(a.call(edit(),ctx('leader')),/lost response/);await a.call({...edit(),requestId:'new-edit-retry'},ctx('leader'));assert.equal(raw("SELECT data->>'revision' FROM xuedu_v2.records WHERE id='review-record'"),'2');
});
pgtest('storage succeeded but registration failed: retry reuses bytes and only one photo registration exists',async()=>{
 seed();const repo=new PostgresRepository(db),commit=repo.commit.bind(repo);let fail=true;
 repo.commit=async c=>{if(fail){fail=false;throw Error('before commit');}return commit(c);};const a=api(repo);
 await assert.rejects(a.call(photo(),ctx()),/before commit/);assert.equal(a.files.size,1);assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.photos WHERE task_id='review-task-open'")),0);
 const retry=await a.call({...photo(),requestId:'fresh-photo-request'},ctx());assert.ok(retry.data.fileID);assert.equal(a.files.size,1);
 assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.photos WHERE task_id='review-task-open'")),1);
 assert.equal(JSON.parse(raw("SELECT data FROM xuedu_v2.requests LIMIT 1")).result.writeState,undefined);
});
pgtest('overlapping photo retries with different client IDs share one receipt and one registered file',async()=>{
 seed();const repo=new PostgresRepository(db);let release!:()=>void,started!:()=>void;const began=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);let first=true;
 const a=api(repo,{uploaded:async()=>{if(first){first=false;started();await hold;}}});const inFlight=a.call(photo(),ctx());await began;
 const retry=await a.call({...photo(),requestId:'overlap-retry'},ctx());release();assert.deepEqual((await inFlight).data,retry.data);
 assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.photos WHERE task_id='review-task-open'")),1);assert.equal(a.files.size,1);
});
pgtest('identity, epoch, maintenance, photo ownership and the exact 24h limit remain enforced',async()=>{
 seed();const a=api(new PostgresRepository(db));
 await assert.rejects(a.call(photo(),ctx('officer')),/他人任务/);assert.equal(a.files.size,0);
 await assert.rejects(a.call(submit(['review-photo-sample']),ctx()),/其他记录/);
 await assert.rejects(a.call(edit(),ctx()),/本人记录/);
 await assert.rejects(a.call({...photo(),epoch:'old'},ctx()),/EPOCH/);
 await assert.rejects(a.call(photo(),{...ctx(),APPID:'wrong'}),/微信身份/);
 const limit=api(new PostgresRepository(db),{now:now+86400000});await assert.rejects(limit.call(edit(),ctx('leader')),/24小时/);
 await limit.call(edit('admin-correction'),ctx('admin'));
 raw("UPDATE xuedu_v2.workspace SET maintenance='locked'");await assert.rejects(a.call(photo(),ctx()),/MAINTENANCE/);
 raw("UPDATE xuedu_v2.workspace SET maintenance='',permissions_version=permissions_version+1; UPDATE xuedu_v2.members SET data=jsonb_set(data,'{active}','false') WHERE id='review-member'");
 await assert.rejects(a.call(photo(),ctx()),/FORBIDDEN/);
});
pgtest('permission changes revalidate writes and never replay an obsolete privileged result',async()=>{
 seed();const a=api(new PostgresRepository(db));const p=await a.call(photo(),ctx());
 raw("UPDATE xuedu_v2.workspace SET version=version+1,permissions_version=permissions_version+1");
 // Unrelated permission changes must not permanently prevent an unchanged photo.
 const next=await a.call({...photo(),requestId:'after-role-change'},ctx());assert.ok(next.data.fileID);assert.equal(a.files.size,1);
 await a.call(edit(),ctx('admin'));
 raw("UPDATE xuedu_v2.workspace SET version=version+1,permissions_version=permissions_version+1;UPDATE xuedu_v2.members SET data=jsonb_set(data,'{role}','\"member\"') WHERE id='review-admin'");
 await assert.rejects(a.call({...edit(),requestId:'stale-privilege-retry',expectedVersion:2},ctx('admin')),/本人记录/);
 await assert.rejects(a.call(submit([String(p.data.fileID)]),ctx('leader')),/本人任务/);
 raw("DELETE FROM xuedu_v2.bindings WHERE member_id='review-member';UPDATE xuedu_v2.workspace SET permissions_version=permissions_version+1");
 await assert.rejects(a.call(photo(),ctx()),/FORBIDDEN/);
});
pgtest('concurrent identical records are idempotent; different observations compete without duplicate tasks',async()=>{
 seed();const repo=new PostgresRepository(db),a=api(repo),id=String((await a.call(photo(),ctx())).data.fileID);
 const same=await Promise.all([a.call(submit([id],'one'),ctx()),a.call(submit([id],'two'),ctx())]);assert.deepEqual(same[0].data,same[1].data);
 assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id='review-task-open'")),1);
 seed();const b=api(new PostgresRepository(db)),pid=String((await b.call(photo(),ctx())).data.fileID);
 const request=submit([pid]);const outcomes=await Promise.allSettled([b.call(request,ctx()),b.call({...request,requestId:'changed',payload:{...request.payload,metrics:{...metrics,actual:29}}},ctx())]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id='review-task-open'")),1);
 seed();const read=repo.recordRead.bind(repo);repo.recordRead=async(...args)=>{const r=await read(...args);raw("UPDATE xuedu_v2.workspace SET version=version+1,permissions_version=permissions_version+1");return r;};
 await assert.rejects(a.call(photo(),ctx()),/VERSION_CONFLICT/);
 seed();repo.recordRead=read;const commit=repo.commit.bind(repo);repo.commit=async c=>{const r=await commit(c);raw("UPDATE xuedu_v2.workspace SET permissions_version=permissions_version+1");return r;};
 await assert.rejects(a.call(edit(),ctx('leader')),/权限/);
});
pgtest('read RPC is server-only, bounded and falls back only for absent migration; recovery API is absent',async()=>{
 seed();for(const who of ['anon','authenticated']) assert.throws(()=>raw(role(who)+`SELECT public.xuedu_v2_record_read('x','{}');`),/permission denied/);
 const rows=(await new PostgresRepository(db).recordRead(ctx().OPENID,{kind:'recordSubmit',epoch:'review-local',semesterId:'review-semester',taskId:'review-task-open',photos:[],operationDigest:'a'.repeat(64)}))!.rows;
 assert.equal(raw("SELECT pg_get_indexdef('xuedu_v2.records_task_unique'::regclass)").includes('UNIQUE'),true);
 assert.equal(rows.members?.length,1);assert.equal(rows.records?.length,0);assert.equal(rows.tasks?.length,1);assert.equal(rows.occurrences?.length,1);
 const a=api(new PostgresRepository(db));calls.length=0;await assert.rejects(a.call({protocolVersion:2,operation:'resolveWrite',epoch:'review-local',payload:{original:photo()}},ctx()),/更新小程序/);assert.equal(calls.length,0);
 await assert.rejects(a.call({...photo(),requestId:'record-v1-forged'},ctx()),/保留前缀/);assert.equal(calls.length,0);
 let n=0;const absent=new PostgresRepository({async rpc(){n++;return {data:null,error:{code:'PGRST202'}};}});assert.equal(await absent.recordRead('x',{}),null);assert.equal(await absent.recordRead('x',{}),null);assert.equal(n,1);
 for(const error of [{code:'55P03'},{message:'FORBIDDEN'},{message:'secret'}]) await assert.rejects(new PostgresRepository({async rpc(){return {data:null,error};}}).recordRead('x',{}));
});
