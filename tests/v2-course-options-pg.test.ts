import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PostgresRepository } from '../server/v2/postgres';
import { createPhotos } from '../server/v2/photos';
import { createGatewayV2 } from '../server/v2/gateway';
import { makeReviewSeed, reviewIdentity } from '../server/v2/review-seed';
import { ApiRequest, Entity, RESOURCES } from '../miniprogram/domain/v2/protocol';
import { Repository } from '../server/v2/repository';
import {matchingOptionSeed,optionSeed,optionApi,generateOptions,optionMetrics,changed} from './helpers/course-options';
import {taskCourseOptions} from '../miniprogram/domain/v2/task-options';
import {readFileSync} from 'node:fs';

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
function seed(s=optionSeed()) {
  const statements = [`TRUNCATE ${['workspace',...RESOURCES].map(r=>'xuedu_v2.'+r).join(',')};`,
    `INSERT INTO xuedu_v2.workspace(id,epoch,version,permissions_version,active_semester_id,max_execution_ms) VALUES('main',${literal(s.workspace.epoch)},1,1,${literal(s.workspace.activeSemesterId)},3000);`];
  for(const [r,rows] of Object.entries(s.rows)) {
    const mapped=rows.map(e=>({id:e.id,epoch:e.epoch,version:e.version,data:e.data,semester_id:e.semesterId,week:e.week,member_id:e.memberId,task_id:e.taskId,record_id:e.recordId,parent_id:e.parentId,identity_key:e.identityKey,student_no:e.studentNo,date:e.date,sort_key:e.sortKey}));
    statements.push(`INSERT INTO xuedu_v2.${r} SELECT * FROM jsonb_populate_recordset(NULL::xuedu_v2.${r},${quote(mapped)});`);
  }
  raw(statements.join('\n'));calls.length=0;return s;
}

pgtest('PG: 40人范围读取生成候选、选课提交保持3次RPC、新编号重试2次；保存实际快照',async()=>{
 const data=optionSeed();for(let i=4;i<40;i++)data.rows.members!.push({id:'extra-'+i,epoch:data.workspace.epoch,version:1,studentNo:'extra-'+i,data:{name:'合成成员'+i,role:'member',active:true,classId:'review-class-a',studentNo:'extra-'+i}});
 seed(data);const f=optionApi(new PostgresRepository(db));
 const {plan,task}=await generateOptions(f,'25');assert.deepEqual(calls,['xuedu_v2_scheduling_read','xuedu_v2_commit','xuedu_v2_workspace','xuedu_v2_query','xuedu_v2_query']);assert.equal(taskCourseOptions(task).length,3);
 calls.length=0;await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});assert.equal(calls.length,3);
 calls.length=0;const image=await f.call('photo',{taskId:task.id,base64:'aGVsbG8='},{who:'member'});assert.equal(calls.length,3);
 const option=taskCourseOptions(task).find(o=>o.course.id==='alternate')!;
 const payload={type:'recordSubmitChoice',taskId:task.id,occurrenceId:option.occurrenceId,metrics:optionMetrics,photos:[image.data.fileID]};
 calls.length=0;const result=await f.call('command',payload,{who:'member',expectedVersion:2});assert.equal(calls.length,3);
 const record=changed(result,e=>!!e.data.firstSubmittedAt);assert.deepEqual(record.data.course,option.course);assert.equal(record.date,option.date);
 calls.length=0;assert.deepEqual((await f.call('command',payload,{who:'member',expectedVersion:2})).data,result.data);assert.equal(calls.length,2);
 assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id="+literal(task.id))),1);
 assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.record_versions WHERE record_id="+literal(record.id))),1);
 calls.length=0;const page=await f.call('bootstrap',{fastPage:true,page:{view:'schedule',week:2}},{who:'officer'});assert.equal(calls.length,1);
 assert.deepEqual((page.data.page as {weekData:{gradeOptions:string[]}}).weekData.gradeOptions,['24','25']);
 calls.length=0;const exported=await f.call('query',{kind:'scheduleReport',week:2},{who:'officer'});
 const members=(exported.data.schedule as {members:{name:string;courses:unknown[]}[]}).members;
 assert.equal(members.length,40);assert.equal(members.filter(m=>m.courses.length===0).length,38);
 assert.equal(members.find(m=>m.name==='样例成员')!.courses.length,3);
 assert.ok(calls.length<=3,'export reads stay bounded instead of per member');
 for(const who of ['leader','member'] as const)await assert.rejects(f.call('query',{kind:'scheduleReport',week:2},{who}),/FORBIDDEN/);
 await assert.rejects(f.call('query',{kind:'scheduleReport',week:3}),/尚无已确认/);
});
pgtest('PG: 未分配/他人候选拒绝；两个候选并发只写一条，旧单课程及旧提交格式仍可用',async()=>{
 seed();const f=optionApi(new PostgresRepository(db)),{plan,task}=await generateOptions(f);
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 const image=await f.call('photo',{taskId:task.id,base64:'aGVsbG8='},{who:'member'});
 const base={type:'recordSubmitChoice',taskId:task.id,metrics:optionMetrics,photos:[image.data.fileID]};
 await assert.rejects(f.call('command',{...base,occurrenceId:'partial:2026-10-26'},{who:'member',expectedVersion:2}),/只能选择/);
 await assert.rejects(f.call('command',{...base,occurrenceId:task.data.occurrenceId},{who:'officer',expectedVersion:2}),/本人任务/);
 const results=await Promise.allSettled(taskCourseOptions(task).slice(0,2).map(o=>f.call('command',{...base,occurrenceId:o.occurrenceId},{who:'member',expectedVersion:2})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id="+literal(task.id))),1);
 seed();const legacy=optionApi(new PostgresRepository(db));const pic=await legacy.call('photo',{taskId:'review-task-open',base64:'aGVsbG8='},{who:'member'});
 calls.length=0;const result=await legacy.call('command',{type:'recordSubmit',taskId:'review-task-open',metrics:optionMetrics,photos:[pic.data.fileID]},{who:'member',expectedVersion:1});assert.equal(calls.length,3);
 assert.equal((changed(result,e=>!!e.data.firstSubmittedAt).data.course as {id:string}).id,'review-course-b');
});
pgtest('PG: 变更非默认候选也进入待调整，确认更新版本后实际提交；011重放不改业务数据/权限',async()=>{
 seed();const repo=new PostgresRepository(db),f=optionApi(repo),{plan,task}=await generateOptions(f);
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 const c=(await repo.get('courses','early'))!;
 const updated=await f.call('command',{type:'courseSave',...(c.data.course as Record<string,unknown>),nature:'自定义课程性质',effectiveDate:'2026-10-26'},{expectedVersion:1});
 assert.equal((await repo.get('tasks',task.id))!.data.status,'pendingAdjustment');
 const replacement=changed(updated,e=>e.data.replacesTaskId===task.id && e.data.status==='draft'),draft=changed(updated,e=>e.id===replacement.parentId);
 const option=taskCourseOptions(replacement).find(o=>o.course.id==='early')!;assert.equal(option.course.nature,'自定义课程性质');
 await f.call('command',{type:'planConfirm',id:draft.id},{expectedVersion:draft.version});
 const image=await f.call('photo',{taskId:replacement.id,base64:'aGVsbG8='},{who:'member'});
 const result=await f.call('command',{type:'recordSubmitChoice',taskId:replacement.id,occurrenceId:option.occurrenceId,metrics:optionMetrics,photos:[image.data.fileID]},{who:'member',expectedVersion:2});
 assert.equal((changed(result,e=>!!e.data.firstSubmittedAt).data.course as {nature:string}).nature,'自定义课程性质');
 const snapshot=()=>raw("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM xuedu_v2.tasks t");const before=snapshot();raw(readFileSync('server/migrations/011-task-course-options.sql','utf8'));assert.equal(snapshot(),before);
 for(const roleName of ['anon','authenticated']) for(const fn of ["xuedu_v2_record_read('x','{}')","xuedu_v2_bootstrap_page('x','{}',false)","xuedu_v2_scheduling_read('x','{}')"])assert.throws(()=>raw(role(roleName)+'SELECT public.'+fn),/permission denied/);
});

pgtest('PG: 提交事务验证实际所选实例版本，读取后课程并发变化不得写入',async()=>{
 seed();const repo=new PostgresRepository(db),f=optionApi(repo),{plan,task}=await generateOptions(f);
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 const pic=await f.call('photo',{taskId:task.id,base64:'aGVsbG8='},{who:'member'});
 const original=repo.recordRead.bind(repo);repo.recordRead=async(identity,request)=>{const read=await original(identity,request);if(request.kind==='recordSubmit')raw("UPDATE xuedu_v2.occurrences SET version=version+1 WHERE id='alternate:2026-10-26'");return read;};
 await assert.rejects(f.call('command',{type:'recordSubmitChoice',taskId:task.id,occurrenceId:'alternate:2026-10-26',metrics:optionMetrics,photos:[pic.data.fileID]},{who:'member',expectedVersion:2}),/VERSION_CONFLICT/);
 assert.equal(Number(raw("SELECT count(*) FROM xuedu_v2.records WHERE task_id="+literal(task.id))),0);
});

pgtest('PG: 两人匹配优化各3门，仍3次RPC；提交后重生成只调整剩余成员和班级',async()=>{
 seed(matchingOptionSeed());const repo=new PostgresRepository(db),f=optionApi(repo);
 const {plan,task}=await generateOptions(f);assert.deepEqual(calls,['xuedu_v2_scheduling_read','xuedu_v2_commit','xuedu_v2_workspace','xuedu_v2_query','xuedu_v2_query']);assert.equal(taskCourseOptions(task).length,3);
 const tasks=JSON.parse(raw("SELECT jsonb_agg(data ORDER BY id) FROM xuedu_v2.tasks"));assert.deepEqual(tasks.map((t:any)=>t.courseOptions.length),[3,3]);
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 const current=(await repo.get('tasks',task.id))!,pic=await f.call('photo',{taskId:task.id,base64:'aGVsbG8='},{who:'member'});
 const submitted=await f.call('command',{type:'recordSubmitChoice',taskId:task.id,occurrenceId:taskCourseOptions(current)[2].occurrenceId,metrics:optionMetrics,photos:[pic.data.fileID]},{who:'member',expectedVersion:current.version});
 const record=changed(submitted,e=>!!e.data.firstSubmittedAt),frozen=await repo.get('tasks',task.id);
 const version=(await repo.get('plans',plan.id))!.version;calls.length=0;const regenerated=await f.call('command',{type:'planGenerate',week:2},{expectedVersion:version});assert.equal(calls.length,3);
 const pending=(await repo.query('tasks',{eq:{parentId:String(regenerated.data.planId)}})).items.filter(e=>e.memberId&&e.data.courseOptions&&!e.data.cancel);
 assert.equal(pending.length,1);assert.ok(pending.every(t=>t.memberId!=='review-member'&&taskCourseOptions(t).every(o=>!o.course.classIds.includes('review-class-b'))));
 assert.deepEqual(await repo.get('tasks',task.id),frozen);assert.deepEqual(await repo.get('records',record.id),record);
});
