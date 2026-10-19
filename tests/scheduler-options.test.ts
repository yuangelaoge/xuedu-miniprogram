import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePlan,eligible} from '../miniprogram/domain/scheduler';
import {classGrade,isEarlyCourse} from '../miniprogram/domain/course-preferences';
import {createSeed} from '../miniprogram/domain/seed';
import {AppState,Course,Observation} from '../miniprogram/domain/types';
function fixture():AppState {
 const s=createSeed(),sid=s.activeSemesterId;
 s.classes=[{id:'a',name:'24甲班',grade:'24',major:'甲'},{id:'b',name:'25乙班',grade:'25',major:'乙'},{id:'c',name:'26丙班',grade:'26',major:'丙'},{id:'own',name:'成员班',grade:'26',major:'其他'}];
 s.semesters=[{...s.semesters[0],id:sid,grades:['24','25','26']}];
 s.members=Array.from({length:3},(_,i)=>({id:'m'+i,name:'合成成员'+i,classId:'own',studentNo:'s'+i,role:'member' as const,active:true}));
 s.courses=s.classes.slice(0,3).flatMap((c,i)=>[1,3].map(start=>({id:c.id+'-'+start,semesterId:sid,name:c.name+'课程',teacher:'合成',nature:'已有性质',classIds:[c.id],classroom:'合成',weekday:i+1,start,end:start+1,weeks:[2],expected:30})));
 s.availability=s.members.map(m=>({memberId:m.id,semesterId:sid,week:2,slots:s.courses.flatMap(c=>[c.weekday+':'+c.start,c.weekday+':'+c.end]),optedIn:true,note:'',updatedAt:''}));s.records=[];return s;
}
function history(s:AppState,c:Course,memberId:string):Observation {return {id:'old-'+c.id,semesterId:s.activeSemesterId,week:1,memberId,course:c} as Observation;}
test('优先年级不降低覆盖；班级/成员轮换先于早八；仅有早八可用仍安排',()=>{
 const s=fixture();s.members=s.members.slice(0,1);s.availability=s.availability.slice(0,1);
 s.records=[history(s,s.courses.find(c=>c.classIds[0]==='b')!,'m0')];
 const preferred=generatePlan(s,s.activeSemesterId,2,0,'25');assert.equal(preferred.tasks[0].course.classIds[0],'b');
 const normal=generatePlan(s,s.activeSemesterId,2,0);assert.notEqual(normal.tasks[0].course.classIds[0],'b');
 s.availability[0].slots=['1:1','1:2'];const onlyEarly=generatePlan(s,s.activeSemesterId,2,0,'25');assert.equal(onlyEarly.tasks.length,1);assert.equal(onlyEarly.tasks[0].course.start,1);
 const full=fixture();assert.equal(generatePlan(full,full.activeSemesterId,2,0,'25').tasks.length,3);
 const rotate=fixture();rotate.courses=rotate.courses.filter(c=>c.classIds[0]==='a');rotate.members=rotate.members.slice(0,2);
 rotate.availability[0].slots=['1:1','1:2'];rotate.availability[1].slots=['1:3','1:4'];rotate.records=[history(rotate,rotate.courses[0],'m1')];
 const result=generatePlan(rotate,rotate.activeSemesterId,2,0);assert.equal(result.tasks[0].memberId,'m0');assert.equal(result.tasks[0].course.start,1);
});
test('候选按精确合班集合组织，不重复任务，过滤完整时段/本人班级，优先非早八',()=>{
 const s=fixture();s.courses=s.courses.filter(c=>c.classIds[0]==='a');s.courses.forEach(c=>c.classIds=['a','b']);
 s.members[0].classId='a';s.availability[1].slots=['1:1'];
 const p=generatePlan(s,s.activeSemesterId,2,0);assert.equal(p.tasks.length,1);assert.equal(p.tasks[0].memberId,'m2');assert.equal(p.tasks[0].course.start,3);
 assert.deepEqual(p.tasks[0].candidateCourses!.map(c=>c.start),[3,1]);assert.ok(p.tasks[0].candidateCourses!.every(c=>eligible(s,c,p.tasks[0].memberId,2)));
 assert.equal(classGrade({name:'27测试班'}),'27');assert.equal(classGrade({grade:'2025',name:'26测试班'}),'25');assert.equal(classGrade({grade:'24',name:'26测试班'}),'24');
});
test('最大覆盖→年级→班级轮换→成员轮换→早八，与80种小规模穷举的词典序最优解一致',()=>{
 for(let trial=1;trial<=80;trial++) {
  const s=fixture();let seed=trial;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  s.availability.forEach(a=>a.slots=a.slots.filter(()=>random()>.35));
  s.records=s.courses.filter(c=>c.start===1 && random()>.5).map((c,i)=>history(s,c,'m'+i));
  // Some cases contain a larger disjoint combined class; coverage still comes first.
  if(trial%3===0){s.classes.push({id:'d',name:'24丁班',grade:'24',major:'甲'});s.courses.filter(c=>c.classIds[0]==='a').forEach(c=>c.classIds.push('d'));}
  const priority=trial%2?'25':'';const prevClasses=new Set(s.records.flatMap(r=>r.course.classIds)),prevMembers=new Set(s.records.map(r=>r.memberId));
  const score=(pairs:{course:Course;memberId:string}[])=>[pairs.reduce((n,p)=>n+p.course.classIds.length,0),pairs.filter(p=>!priority || p.course.classIds.some(id=>classGrade(s.classes.find(c=>c.id===id)!)===priority)).length,pairs.filter(p=>!p.course.classIds.some(id=>prevClasses.has(id))).length,pairs.filter(p=>!prevMembers.has(p.memberId)).length,pairs.filter(p=>!isEarlyCourse(p.course)).length];
  const compare=(a:number[],b:number[])=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
  let best=[-1];const groups=['a','b','c'].map(id=>s.courses.filter(c=>c.classIds[0]===id));
  function enumerate(index:number,used:Set<string>,pairs:{course:Course;memberId:string}[]) {
   if(index===groups.length){const value=score(pairs);if(compare(value,best)>0)best=value;return;}
   enumerate(index+1,used,pairs);
   for(const m of s.members)if(!used.has(m.id))for(const course of groups[index])if(eligible(s,course,m.id,2))enumerate(index+1,new Set([...used,m.id]),[...pairs,{memberId:m.id,course}]);
  }
  enumerate(0,new Set(),[]);const p=generatePlan(s,s.activeSemesterId,2,trial,priority);assert.deepEqual(score(p.tasks),best,'case '+trial);
 }
});
