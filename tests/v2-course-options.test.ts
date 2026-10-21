import test from 'node:test';
import assert from 'node:assert/strict';
import {matchingOptionSeed,optionFixture,generateOptions,optionMetrics,changed} from './helpers/course-options';
import { taskCourseOptions } from '../miniprogram/domain/v2/task-options';
import { AppState,Course } from '../miniprogram/domain/types';
import { reportSheets } from '../miniprogram/domain/reports';

async function confirmed() {
 const f=optionFixture(), {task,plan}=await generateOptions(f);
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 return {...f,task:(await f.repo.get('tasks',task.id))!};
}
async function photo(f:Awaited<ReturnType<typeof confirmed>>) {return String((await f.call('photo',{taskId:f.task.id,base64:'aGVsbG8='},{who:'member'})).data.fileID);}
test('同班候选整段可用、不含本人班/其他周/半段；选实际课程，照片/记录/Excel与原安排可追溯',async()=>{
 const f=await confirmed();const options=taskCourseOptions(f.task);
 assert.equal(options.length,3);assert.notEqual((f.task.data.course as unknown as Course).start,1);
 assert.ok(options.every(o=>o.course.classIds.join() === 'review-class-b' && o.date==='2026-10-26'));
 assert.ok(!options.some(o=>o.course.id==='partial'));
 const choice=options.find(o=>o.course.id==='alternate')!;const id=await photo(f);
 const payload={type:'recordSubmitChoice',taskId:f.task.id,occurrenceId:choice.occurrenceId,metrics:optionMetrics,photos:[id]};
 const submitted=await f.call('command',payload,{who:'member',expectedVersion:f.task.version});
 const record=changed(submitted,e=>!!e.data.firstSubmittedAt);
 assert.deepEqual(record.data.course,choice.course);assert.equal(record.date,choice.date);assert.deepEqual(record.data.classes,choice.classes);
 assert.equal((record.data.assignment as {occurrenceId:string}).occurrenceId,f.task.data.occurrenceId);
 assert.equal(record.data.selectedOccurrenceId,choice.occurrenceId);assert.equal(record.taskId,f.task.id);
 assert.equal((await f.repo.get('photos',id))!.taskId,f.task.id);assert.equal((await f.repo.get('photos',id))!.recordId,record.id);
 const retry=await f.call('command',payload,{who:'member',expectedVersion:f.task.version});assert.deepEqual(retry.data,submitted.data);
 assert.equal((await f.repo.query('records',{eq:{taskId:f.task.id}})).items.length,1);
 const report=await f.call('query',{kind:'excelReport',week:2});const sheets=reportSheets(report.data.state as AppState,2);
 assert.ok(JSON.stringify(sheets).includes('专业选修课'));assert.ok(JSON.stringify(sheets).includes('合成课程-alternate'));assert.equal((report.data.state as AppState).records[0].course.teacher,'合成教师-alternate');
 await assert.rejects(f.call('command',{...payload,occurrenceId:options[0].occurrenceId},{who:'member',expectedVersion:f.task.version}),/刷新|已提交/);
 await assert.rejects(f.call('command',{type:'recordEdit',id:record.id,occurrenceId:options[0].occurrenceId,reason:'换课程',metrics:optionMetrics,photos:[id]},{who:'member',expectedVersion:record.version}),/不能修改/);
});
test('拒绝他人任务、未分配的同班课/本班课和跨学期选择；旧客户端仍默认原课程',async()=>{
 const f=await confirmed(),id=await photo(f);
 for(const occurrenceId of ['partial:2026-10-26','review-course-a:2026-10-26','review-course-b:2026-10-19','forged'])
  await assert.rejects(f.call('command',{type:'recordSubmitChoice',taskId:f.task.id,occurrenceId,metrics:optionMetrics,photos:[id]},{who:'member',expectedVersion:f.task.version}),/只能选择/);
 await assert.rejects(f.call('command',{type:'recordSubmitChoice',taskId:f.task.id,occurrenceId:f.task.data.occurrenceId,metrics:optionMetrics,photos:[id]},{who:'officer',expectedVersion:f.task.version}),/本人任务/);
 await assert.rejects(f.call('command',{type:'recordSubmitChoice',taskId:f.task.id,occurrenceId:f.task.data.occurrenceId,metrics:optionMetrics,photos:[id]},{who:'member',semesterId:'wrong',expectedVersion:f.task.version}),/不存在|学期/);
 const submitted=await f.call('command',{type:'recordSubmit',taskId:f.task.id,metrics:optionMetrics,photos:[id]},{who:'member',expectedVersion:f.task.version});
 assert.deepEqual(changed(submitted,e=>!!e.data.firstSubmittedAt).data.course,f.task.data.course);
});
test('不同候选并发仅一个完成，同一内容新编号重试合并且无新增历史版本',async()=>{
 const f=await confirmed(),id=await photo(f),options=taskCourseOptions(f.task);
 const attempts=await Promise.allSettled(options.slice(0,2).map(o=>f.call('command',{type:'recordSubmitChoice',taskId:f.task.id,occurrenceId:o.occurrenceId,metrics:optionMetrics,photos:[id]},{who:'member',expectedVersion:f.task.version})));
 assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
 const record=(await f.repo.query('records',{eq:{taskId:f.task.id}})).items[0];
 assert.equal((await f.repo.query('record_versions',{eq:{recordId:record.id}})).items.length,1);
});
test('候选课程变更使未完成任务待调整，更新候选草稿需人工确认；已完成任务和快照不改写',async()=>{
 const f=await confirmed();const course=(await f.repo.get('courses','alternate'))!;const original=course.data.course as unknown as Course;
 const update=await f.call('command',{type:'courseSave',...original,id:'alternate',nature:'更新后的性质',effectiveDate:'2026-10-26'},{expectedVersion:course.version});
 assert.equal((await f.repo.get('tasks',f.task.id))!.data.status,'pendingAdjustment');
 const replacement=changed(update,e=>e.data.replacesTaskId===f.task.id && e.data.status==='draft');assert.ok(replacement);
 assert.equal(taskCourseOptions(replacement).find(o=>o.course.id==='alternate')!.course.nature,'更新后的性质');
 const plan=changed(update,e=>e.id===replacement.parentId);
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 assert.equal((await f.repo.get('tasks',replacement.id))!.data.status,'confirmed');
 assert.equal((await f.repo.get('tasks',f.task.id))!.data.status,'cancelled');
 const g=await confirmed(),id=await photo(g);await g.call('command',{type:'recordSubmit',taskId:g.task.id,metrics:optionMetrics,photos:[id]},{who:'member',expectedVersion:g.task.version});
 const before=(await g.repo.query('records',{eq:{taskId:g.task.id}})).items[0];
 await g.call('command',{type:'courseSave',...original,id:'alternate',nature:'又更新',effectiveDate:'2026-10-26'},{expectedVersion:1});
 assert.deepEqual((await g.repo.get('records',before.id)),before);assert.equal((await g.repo.get('tasks',g.task.id))!.data.status,'submitted');
});
test('确认重查每个候选的可用时段；优先年级仅目标周草稿，读取实际年级含班名前缀回退',async()=>{
 const f=optionFixture(),{plan}=await generateOptions(f,'25');assert.equal(plan.data.priorityGrade,'25');
 await assert.rejects(f.call('command',{type:'planGenerate',week:2,priorityGrade:'99'}),/不属于/);
 const page=await f.call('bootstrap',{page:{view:'schedule',week:2},fastPage:true},{who:'officer'});
 assert.deepEqual((page.data.page as {weekData:{gradeOptions:string[]}}).weekData.gradeOptions,['24','25']);
 const av=(await f.repo.query('availability',{eq:{memberId:'review-member',week:2}})).items[0];
 await f.call('command',{type:'availabilitySave',week:2,slots:['1:3','1:4'],optedIn:true},{who:'member',expectedVersion:av.version});
 await assert.rejects(f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version}),/完整可用/);
 assert.equal((await f.repo.get('plans',plan.id))!.data.status,'draft');
 assert.equal((await f.repo.get('plans','review-plan-1'))!.data.priorityGrade,undefined);
});

test('优化只生成草稿：确认前正式安排不变，已提交成员/班级冻结，既有前端候选结构兼容',async()=>{
 const f=optionFixture(matchingOptionSeed()),{plan,task}=await generateOptions(f);
 const draftTasks=(await f.repo.query('tasks',{eq:{parentId:plan.id}})).items;
 assert.deepEqual(draftTasks.map(t=>taskCourseOptions(t).length),[3,3]);assert.ok(draftTasks.every(t=>t.data.status==='draft'));
 assert.equal(taskCourseOptions(task)[0].course.classIds[0],'review-class-b');
 await f.call('command',{type:'planConfirm',id:plan.id},{expectedVersion:plan.version});
 const confirmed=(await f.repo.query('tasks',{eq:{week:2}})).items;
 const another=await f.call('command',{type:'planGenerate',week:2},{expectedVersion:(await f.repo.get('plans',plan.id))!.version});
 assert.deepEqual((await f.repo.query('tasks',{eq:{week:2,status:'confirmed'}})).items,confirmed);
 const next=changed(another,e=>e.data.status==='draft'&&e.data.uncovered!==undefined);
 await f.call('command',{type:'planConfirm',id:next.id},{expectedVersion:next.version});
 const current=(await f.repo.query('tasks',{eq:{week:2,memberId:'review-member',status:'confirmed'}})).items[0];
 const pic=await f.call('photo',{taskId:current.id,base64:'aGVsbG8='},{who:'member'});
 const submitted=await f.call('command',{type:'recordSubmitChoice',taskId:current.id,occurrenceId:taskCourseOptions(current)[2].occurrenceId,metrics:optionMetrics,photos:[pic.data.fileID]},{who:'member',expectedVersion:current.version});
 const record=changed(submitted,e=>!!e.data.firstSubmittedAt),frozen=(await f.repo.get('tasks',current.id))!;
 const regenerated=await f.call('command',{type:'planGenerate',week:2},{expectedVersion:(await f.repo.get('plans',next.id))!.version});
 const pending=(regenerated.data.changed as typeof frozen[]).filter(e=>e.memberId&&e.data.courseOptions&&!e.data.cancel);
 assert.equal(pending.length,1);assert.ok(pending.every(t=>t.memberId!=='review-member'&&taskCourseOptions(t).every(o=>!o.course.classIds.includes('review-class-b'))));
 assert.deepEqual(await f.repo.get('tasks',current.id),frozen);assert.deepEqual(await f.repo.get('records',record.id),record);
});
