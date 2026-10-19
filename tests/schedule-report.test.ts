import test from 'node:test';
import assert from 'node:assert/strict';
import { optionFixture, generateOptions, optionApi, optionMetrics } from './helpers/course-options';
import { MemoryRepository } from '../server/v2/memory';
import { ScheduleReport, scheduleSheet, exportScheduleXlsx } from '../miniprogram/domain/schedule-report';

async function confirmed() {
  const f=optionFixture(), {plan,task}=await generateOptions(f);
  await assert.rejects(f.call('query',{kind:'scheduleReport',week:2}),/尚无已确认/);
  await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
  return {...f,task:(await f.repo.get('tasks',task.id))!};
}
test('安排表列出全部有效成员，无安排者课程空白；排除草稿/取消/其他周，已完成保留所有分配课程',async()=>{
  const f=await confirmed();
  const before=await f.call('query',{kind:'scheduleReport',week:2},{who:'officer'});
  const schedule=before.data.schedule as ScheduleReport;
  assert.equal(schedule.members.length,4);
  assert.deepEqual(schedule.members.filter(m=>m.courses.length===0).map(m=>m.role),['admin','officer']);
  assert.equal(schedule.members.find(m=>m.role==='member')!.courses.length,3);
  assert.ok(schedule.members.flatMap(m=>m.courses).every(c=>c.date==='2026-10-26'));
  const pic=await f.call('photo',{taskId:f.task.id,base64:'aGVsbG8='},{who:'member'});
  await f.call('command',{type:'recordSubmitChoice',taskId:f.task.id,occurrenceId:'early:2026-10-26',metrics:optionMetrics,photos:[pic.data.fileID]},{who:'member',expectedVersion:f.task.version});
  const after=await f.call('query',{kind:'scheduleReport',week:2});
  assert.deepEqual(after.data.schedule,schedule);
  await assert.rejects(f.call('query',{kind:'reportCheck',format:'schedule',week:2,version:before.data.version}),/变化/);
  const snapshot=f.repo.snapshot();
  for(const status of ['draft','cancelled'])snapshot.rows.tasks!.push({...structuredClone(f.task),id:'excluded-'+status,data:{...f.task.data,status,courseOptions:[{course:{name:'不得出现'}}]}});
  snapshot.rows.members!.push({id:'inactive-without-task',epoch:snapshot.workspace.epoch,version:1,data:{name:'不应出现',role:'member',active:false}});
  // A departed person's completed historical assignment is retained.
  snapshot.rows.members!.find(m=>m.id==='review-member')!.data.active=false;
  const second=optionApi(new MemoryRepository(snapshot.workspace,snapshot.rows));
  assert.deepEqual((await second.call('query',{kind:'scheduleReport',week:2})).data.schedule,schedule);
  const pending=snapshot.rows.tasks!.find(t=>t.id===f.task.id)!;pending.data.status='pendingAdjustment';
  await assert.rejects(optionApi(new MemoryRepository(snapshot.workspace,snapshot.rows)).call('query',{kind:'scheduleReport',week:2}),/待调整/);
});
test('安排表及复核只允许管理员/信息部干事，其他周不套用已确认安排',async()=>{
  const f=await confirmed();
  for(const who of ['leader','member'] as const) {
    await assert.rejects(f.call('query',{kind:'scheduleReport',week:2},{who}),/权限|管理员|信息部/);
    await assert.rejects(f.call('query',{kind:'reportCheck',format:'schedule',week:2,version:(await f.repo.workspace()).version},{who}),/权限|管理员|信息部/);
  }
  await assert.rejects(f.call('query',{kind:'scheduleReport',week:3}),/尚无已确认/);
});
test('实际XLSX按人合并身份/姓名，多门课平等列出，无课者后七列为空',async()=>{
  const f=await confirmed(),report=(await f.call('query',{kind:'scheduleReport',week:2})).data.schedule as ScheduleReport;
  const sheet=scheduleSheet(report),buffer=Buffer.from(exportScheduleXlsx(report));
  const files=new Map<string,string>();let at=0;
  while(buffer.readUInt32LE(at)===0x04034b50) {
    assert.equal(buffer.readUInt16LE(at+8),0);
    const size=buffer.readUInt32LE(at+18),nameSize=buffer.readUInt16LE(at+26),extra=buffer.readUInt16LE(at+28),start=at+30+nameSize+extra;
    files.set(buffer.subarray(at+30,at+30+nameSize).toString(),buffer.subarray(start,start+size).toString());at=start+size;
  }
  const xml=files.get('xl/worksheets/sheet1.xml')!;
  assert.match(xml,/<mergeCell ref="A7:A9"/);assert.match(xml,/<mergeCell ref="B7:B9"/);
  assert.equal((xml.match(/样例成员/g)||[]).length,1);
  assert.doesNotMatch(xml,/主要|备选|推荐|autoFilter/);
  assert.match(xml,/专业选修课/);assert.match(xml,/学科必修课/);assert.match(xml,/合成教师-alternate/);
  const empty=sheet.rows[3];assert.deepEqual(empty,['管理员','样例管理员',null,null,null,null,null,null,null]);
  const row4=xml.match(/<row r="4"[\s\S]*?<\/row>/)![0];
  assert.doesNotMatch(row4,/<c r="[C-I]4"[^>]*>[\s\S]*?<(?:v|t)>[^<]+</);
  assert.equal(sheet.rows.length,9);assert.ok(files.has('[Content_Types].xml'));
});
