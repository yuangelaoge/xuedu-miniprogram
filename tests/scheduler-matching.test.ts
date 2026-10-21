import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan, eligible } from '../miniprogram/domain/scheduler';
import { classGrade, isEarlyCourse } from '../miniprogram/domain/course-preferences';
import { slotsFor } from '../miniprogram/domain/calendar';
import { AppState, Course, Observation } from '../miniprogram/domain/types';
import { matchingFixture, fortyPersonFixture } from './helpers/scheduler-matching';
const plan=(s:AppState,revision=0,grade='')=>generatePlan(s,s.activeSemesterId,2,revision,grade);
const counts=(s:AppState)=>plan(s).tasks.map(t=>t.candidateCourses!.length).sort((a,b)=>a-b);
const history=(s:AppState,course:Course,memberId:string)=>({id:'history-'+course.id,semesterId:s.activeSemesterId,week:1,course,memberId}) as Observation;

test('问答反例：甲乙从各1门交换为各3门，所有候选都满足同班与完整无课时段',()=>{
 const s=matchingFixture([[1,3],[3,1]]);
 const time=[[1,3],[2,3],[3,3],[4,3],[5,3],[2,5]];
 s.courses.forEach((c,i)=>Object.assign(c,{weekday:time[i][0],start:time[i][1],end:time[i][1]+1}));
 s.availability[0].slots=[0,3,4,5].flatMap(i=>slotsFor(s.courses[i]));
 s.availability[1].slots=[0,1,2,3].flatMap(i=>slotsFor(s.courses[i]));
 s.classes.push({id:'own2',name:'乙班',grade:'26',major:'成员专业'});s.members[1].classId='own2';
 for(const revision of [0,1,2,41]) {
  const p=plan(s,revision);assert.equal(p.tasks.length,2);
  assert.deepEqual(p.tasks.map(t=>[t.memberId,t.course.classIds[0],t.candidateCourses!.length]).sort(),[['m0','g1',3],['m1','g0',3]]);
  for(const t of p.tasks)assert.ok(t.candidateCourses!.every(c=>eligible(s,c,t.memberId,2)&&c.classIds.join()===t.course.classIds.join()));
 }
});
test('先最大化至少2门的人数，再最大化总数；不是简单偏向候选最多的人',()=>{
 assert.deepEqual(counts(matchingFixture([[1,2],[2,8]])),[2,2]); // 4 choices for 2 people beats 9 for only 1.
 assert.deepEqual(counts(matchingFixture([[2,3],[4,2]])),[3,4]); // Equal people: total 7 beats 4.
 assert.deepEqual(counts(matchingFixture([[0,3],[1,3]])),[1,3]); // Coverage stays 2 even if one person has only 1.
});
test('候选数量不能挤占行政班覆盖、年级、班级轮换、成员轮换或非早八',()=>{
 const coverage=matchingFixture([[1,6]]);coverage.classes.push({id:'combined',name:'合班',grade:'25',major:'专业0'});coverage.courses[0].classIds.push('combined');
 assert.equal(plan(coverage).tasks[0].course.classIds.length,2);
 const grade=matchingFixture([[1,6]]);grade.classes[0].grade='26';assert.equal(plan(grade,0,'26').tasks[0].course.classIds[0],'g0');
 const classes=matchingFixture([[1,6]]);classes.courses.forEach(c=>c.name='同名课程');classes.records=[history(classes,classes.courses[1],'unknown')];assert.equal(plan(classes).tasks[0].course.classIds[0],'g0');
 const members=matchingFixture([[6],[1]]);members.records=[history(members,members.courses[0],'m0')];assert.equal(plan(members).tasks[0].memberId,'m1');
 // A repeated class remains eligible if it is the only feasible group.
 assert.equal(plan(members).tasks.length,1);
 const early=matchingFixture([[3],[1]]);
 early.courses.forEach((c,i)=>Object.assign(c,{weekday:i+1,start:1,end:2}));
 const later={...early.courses[0],id:'later',weekday:4,start:3,end:4};early.courses.push(later);
 early.availability[0].slots=early.courses.slice(0,3).flatMap(slotsFor);early.availability[1].slots=slotsFor(later);
 assert.equal(plan(early).tasks[0].memberId,'m1');assert.deepEqual(counts(early),[1]);
});
test('重复 ID、重复课表项不会增加候选；同名不同教师/时段仍是不同课程',()=>{
 const s=matchingFixture([[1,2],[2,1]]), original=s.courses[0];
 s.courses.push(structuredClone(original),{...original,id:'import-duplicate',weeks:[1,2,3],expected:31,nature:'标签更新'});
 assert.deepEqual(counts(s),[2,2]);assert.ok(plan(s).tasks.every(t=>!t.candidateCourses!.some(c=>c.id==='import-duplicate')));
 const distinct=matchingFixture([[1]]);distinct.courses.push({...distinct.courses[0],id:'different-teacher',teacher:'另一教师'});
 assert.deepEqual(counts(distinct),[2]);
 const invalid=matchingFixture([[1]]);invalid.courses.push({...invalid.courses[0],teacher:'冲突同ID'});assert.throws(()=>plan(invalid),/同一课程标识/);
});
test('所有候选排除本人班与含本人合班、半段、其他周/学期、未报名管理人员及停用成员',()=>{
 const s=matchingFixture([[3],[3],[3],[3]]);
 s.members[0].classId='g0';s.classes.push({id:'combined',name:'合班',grade:'25',major:'专业0'});s.courses.forEach(c=>c.classIds.push('combined'));
 s.members[1].classId='combined';s.availability[2].slots=s.courses.map(c=>`${c.weekday}:${c.start}`);s.members[3].role='admin';s.availability[3].optedIn=false;
 assert.equal(plan(s).tasks.length,0);
 s.availability[3].optedIn=true;assert.deepEqual(counts(s),[3]);
 s.availability[3].week=1;assert.equal(plan(s).tasks.length,0);
 s.availability[3].week=2;s.members[3].active=false;assert.equal(plan(s).tasks.length,0);
 s.members[3].active=true;s.courses[0].weeks=[1];s.courses[1].semesterId='other';assert.deepEqual(counts(s),[1]);
});
test('240种小规模穷举逐项对照：原有5层目标及两层候选目标全部最优',()=>{
 let improvedPeople=0;
 for(let trial=1;trial<=240;trial++) {
  let seed=trial;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const s=matchingFixture(Array.from({length:4},()=>Array.from({length:4},()=>Math.floor(random()*7))));
  if(trial%3===0){s.classes.push({id:'combined',name:'合班',grade:'25',major:'专业0'});s.courses.filter(c=>c.classIds[0]==='g0').forEach(c=>c.classIds.push('combined'));}
  s.classes[1].grade='26';s.members[0].classId=trial%4===0?'g0':'own';
  s.courses.forEach(c=>{if(random()<.25){const old=slotsFor(c);c.start=1;c.end=2;s.availability.forEach(a=>{if(old.every(slot=>a.slots.includes(slot)))a.slots.push(...slotsFor(c));});}});
  s.records=s.courses.filter(()=>random()<.12).map((c,i)=>history(s,c,'m'+i%4));
  const priority=trial%2?'26':'',previousClasses=new Set(s.records.flatMap(r=>r.course.classIds)),previousMembers=new Set(s.records.map(r=>r.memberId));
  const groups=[0,1,2,3].map(g=>s.courses.filter(c=>c.classIds[0]==='g'+g));
  const choices=groups.map(courses=>s.members.map(m=>courses.filter(c=>eligible(s,c,m.id,2))));
  type Pair={memberId:string;course:Course};
  const score=(pairs:Pair[])=>[pairs.length,pairs.reduce((n,p)=>n+p.course.classIds.length,0),pairs.filter(p=>!priority||p.course.classIds.some(id=>classGrade(s.classes.find(c=>c.id===id)!)===priority)).length,pairs.filter(p=>!p.course.classIds.some(id=>previousClasses.has(id))).length,pairs.filter(p=>!previousMembers.has(p.memberId)).length,pairs.filter(p=>!isEarlyCourse(p.course)).length,pairs.filter(p=>choices[Number(p.course.classIds[0].slice(1))][Number(p.memberId.slice(1))].length>=2).length,pairs.reduce((n,p)=>n+choices[Number(p.course.classIds[0].slice(1))][Number(p.memberId.slice(1))].length,0)];
  const compare=(a:number[],b:number[])=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
  let best:number[]=[-1],bestPairs:Pair[]=[];
  function enumerate(g:number,used:Set<number>,pairs:Pair[]) {
   if(g===groups.length){const value=score(pairs);if(compare(value,best)>0){best=value;bestPairs=pairs;}return;}
   enumerate(g+1,used,pairs);
   for(let m=0;m<s.members.length;m++)if(!used.has(m)&&choices[g][m].length) {
    // The non-early recommended course is optimal for this fixed pairing.
    const course=choices[g][m].find(c=>!isEarlyCourse(c))||choices[g][m][0];
    enumerate(g+1,new Set([...used,m]),[...pairs,{memberId:s.members[m].id,course}]);
   }
  }
  enumerate(0,new Set(),[]);const p=plan(s,trial,priority);
  assert.deepEqual(score(p.tasks),best,'case '+trial);assert.equal(new Set(p.tasks.map(t=>t.memberId)).size,p.tasks.length);
  for(const t of p.tasks)assert.deepEqual(new Set(t.candidateCourses!.map(c=>c.id)),new Set(choices[Number(t.course.classIds[0].slice(1))][Number(t.memberId.slice(1))].map(c=>c.id)));
  if(bestPairs.length&&best[6]>0)improvedPeople++;
 }
 assert.ok(improvedPeople>0);
});

test('40人/40班组/400课程：最大覆盖、每人一次、全部候选合法且生成不修改输入',()=>{
 const s=fortyPersonFixture(),before=structuredClone(s),p=plan(s);
 assert.equal(p.tasks.length,40);assert.equal(new Set(p.tasks.map(t=>t.memberId)).size,40);assert.equal(p.uncovered.length,0);
 for(const t of p.tasks) {
  assert.ok(t.candidateCourses!.every(c=>eligible(s,c,t.memberId,2)&&c.classIds.join()===t.course.classIds.join()));
  assert.equal(new Set(t.candidateCourses!.map(c=>c.id)).size,t.candidateCourses!.length);
 }
 assert.deepEqual(s,before);
});
