import { createSeed } from '../../miniprogram/domain/seed';
import { AppState, Course } from '../../miniprogram/domain/types';
import { slotsFor } from '../../miniprogram/domain/calendar';

/** Counts[member][group]; each distinct course has an independent non-early slot. */
export function matchingFixture(counts: number[][]): AppState {
 const s=createSeed(),sid=s.activeSemesterId;
 s.semesters=[{...s.semesters[0],id:sid,grades:['25','26'],days:7,periods:14}];
 s.classes=counts[0].map((_,i)=>({id:'g'+i,name:'合成班'+i,grade:'25',major:'专业'+i}));
 s.classes.push({id:'own',name:'成员班',grade:'26',major:'成员专业'});
 s.members=counts.map((_,i)=>({id:'m'+i,name:'合成成员'+i,classId:'own',studentNo:'s'+i,role:'member',active:true}));
 let slot=0;
 s.courses=counts[0].flatMap((_,g)=>Array.from({length:Math.max(...counts.map(row=>row[g]))},(_,i):Course=>{
  const n=slot++;return {id:`g${g}-${i}`,semesterId:sid,name:`合成课程${g}-${i}`,teacher:'合成教师',nature:'必修',classIds:['g'+g],classroom:'合成教室',weekday:1+Math.floor(n/6),start:3+2*(n%6),end:4+2*(n%6),weeks:[2],expected:30};
 }));
 s.availability=s.members.map((m,i)=>({memberId:m.id,semesterId:sid,week:2,slots:s.courses.filter(c=>Number(c.id.split('-')[1])<counts[i][Number(c.classIds[0].slice(1))]).flatMap(slotsFor),optedIn:true,note:'',updatedAt:''}));
 s.records=[];s.plans=[];s.drafts=[];return s;
}

/** 40 people, 40 disjoint class groups, 400 synthetic lessons. */
export function fortyPersonFixture(): AppState {
 const s=matchingFixture(Array.from({length:40},()=>Array(40).fill(10)));
 let seed=40;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 const choose=(count:number)=>{const remaining=Array.from({length:30},(_,i)=>i),picked:number[]=[];while(picked.length<count)picked.push(remaining.splice(Math.floor(random()*remaining.length),1)[0]);return picked;};
 for(let group=0;group<40;group++) {
  const slots=choose(10);
  s.courses.filter(c=>c.classIds[0]==='g'+group).forEach((c,i)=>{c.weekday=1+Math.floor(slots[i]/6);c.start=3+2*(slots[i]%6);c.end=c.start+1;});
 }
 s.availability.forEach(a=>a.slots=choose(5).flatMap(n=>[`${1+Math.floor(n/6)}:${3+2*(n%6)}`,`${1+Math.floor(n/6)}:${4+2*(n%6)}`]));
 return s;
}
