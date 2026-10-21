import { makeReviewSeed, reviewIdentity } from '../../server/v2/review-seed';
import { createGatewayV2 } from '../../server/v2/gateway';
import { MemoryRepository } from '../../server/v2/memory';
import { Repository } from '../../server/v2/repository';
import { ApiRequest, Entity } from '../../miniprogram/domain/v2/protocol';
import { Course } from '../../miniprogram/domain/types';
export const optionNow=Date.parse('2026-10-19T02:00:00Z');
export const optionMetrics={expected:32,actual:30,late:1,early:0,sleep:0,phone:0,talk:0,other:0};
export function optionSeed() {
 const seed=makeReviewSeed('options','options',optionNow,3000);seed.workspace.id='main';
 const sid=seed.workspace.activeSemesterId, epoch=seed.workspace.epoch;
 const primary=seed.rows.occurrences!.find(o=>o.id==='review-occ-b2')!;
 const course=primary.data.course as unknown as Course;
 for (const [id,start,end,weekday,nature] of [['alternate',5,6,1,'专业选修课'],['early',1,2,1,'学科必修课'],['partial',7,8,1,'实验课']] as const) {
  const c={...course,id,semesterId:sid,name:'合成课程-'+id,teacher:'合成教师-'+id,classroom:'合成教室-'+id,start,end,weekday,nature};
  seed.rows.courses!.push({id,epoch,version:1,semesterId:sid,data:{course:c,active:true,name:c.name}});
  seed.rows.occurrences!.push({...structuredClone(primary),id, parentId:id,data:{...primary.data,course:c}});
 }
 for(const o of seed.rows.occurrences!) {
  const c=o.data.course as unknown as Course;c.semesterId=sid;
  const oldId=o.id;o.id=c.id+':'+o.date;o.parentId=c.id;o.data.originalDate=o.date;
  for(const t of seed.rows.tasks!) if(t.data.occurrenceId===oldId)t.data.occurrenceId=o.id;
 }
 seed.rows.course_versions=seed.rows.courses!.map(c=>({id:c.id+'-version',epoch,version:1,semesterId:sid,parentId:c.id,date:'2026-10-19',data:{course:c.data.course,active:true,sequence:1}}));
 const av=seed.rows.availability!.find(a=>a.memberId==='review-member')!;av.data.slots=['1:1','1:2','1:3','1:4','1:5','1:6','1:7'];
 seed.rows.classes![0].data.grade='';seed.rows.classes![0].data.name='24合成班';
 seed.rows.classes![1].data.grade='25';
 return seed;
}
export function optionApi(repository:Repository) {
 let serial=0,uploads=0;
 const api=createGatewayV2({repository,appid:'app',bootstrapOpenid:'unused',maxExecutionMs:3000,now:()=>optionNow,uuid:()=>`options-${++serial}`,
  photos:{async upload(path){uploads++;return path;},async list(){return [];},async delete(){},async urls(ids){return ids.map(id=>'https://synthetic.invalid/'+id);}}});
 const call=(operation:string,payload:Record<string,unknown>,extra:Partial<ApiRequest> & {who?:'admin'|'member'|'leader'|'officer'}={})=>{
  const {who='admin',...rest}=extra;
  return api({protocolVersion:2,operation,epoch:'review-options',semesterId:'review-semester',requestId:'client-'+ ++serial,expectedVersion:0,payload,...rest},{OPENID:reviewIdentity('options',who),APPID:'app'});
 };
 return {call,uploads:()=>uploads};
}
export function optionFixture(seed=optionSeed()) {const repo=new MemoryRepository(seed.workspace,seed.rows,()=>optionNow);return {seed,repo,...optionApi(repo)};}
export function changed(result:{data:Record<string,unknown>},predicate:(e:Entity)=>boolean):Entity {return (result.data.changed as Entity[]).find(predicate)!;}
export async function generateOptions(f:ReturnType<typeof optionApi>, priorityGrade='') {
 const draft=await f.call('command',{type:'planGenerate',week:2,priorityGrade});
 const plan=changed(draft,e=>e.data.status==='draft' && e.data.uncovered!==undefined);
 const task=changed(draft,e=>e.memberId==='review-member' && e.data.courseOptions!==undefined);
 return {plan,task};
}

/** Two eligible people / two class groups: swapping 1+1 yields 3+3. */
export function matchingOptionSeed() {
 const seed=optionSeed(),epoch=seed.workspace.epoch,sid=seed.workspace.activeSemesterId;
 const row=(id:string,data:Record<string,unknown>,extra:Partial<Entity>={}):Entity=>({id,epoch,version:1,data,...extra});
 seed.rows.classes=[...seed.rows.classes!,row('own-member',{name:'本人甲班',grade:'25',major:'其他',active:true}),row('own-officer',{name:'本人乙班',grade:'25',major:'其他',active:true})];
 seed.rows.classes[0].data.grade='25';
 seed.rows.members!.find(m=>m.id==='review-member')!.data.classId='own-member';
 seed.rows.members!.find(m=>m.id==='review-officer')!.data.classId='own-officer';
 const times=[[1,3],[2,3],[3,3],[4,3],[5,3],[2,5]];
 seed.rows.courses=times.map(([weekday,start],i)=>{
  const id='matching-'+i,c:Course={id,semesterId:sid,name:'合成课'+i,teacher:'合成教师',nature:'必修',classIds:[seed.rows.classes![i<3?0:1].id],classroom:'合成教室',weekday,start,end:start+1,weeks:[2],expected:32};
  return row(id,{name:c.name,course:c,active:true},{semesterId:sid});
 });
 seed.rows.course_versions=seed.rows.courses.map(c=>row(c.id+'-v1',{course:c.data.course,active:true,sequence:1},{semesterId:sid,parentId:c.id,date:'2026-10-19'}));
 seed.rows.occurrences=seed.rows.courses.map(c=>{
  const course=c.data.course as unknown as Course,date='2026-10-'+(25+course.weekday),schoolClass=seed.rows.classes!.find(k=>k.id===course.classIds[0])!;
  return row(c.id+':'+date,{course,status:'active',classes:[{id:schoolClass.id,...schoolClass.data}],classLabel:schoolClass.data.name,date,originalDate:date},{semesterId:sid,week:2,parentId:c.id,date});
 });
 seed.rows.availability=[['review-member',[0,3,4,5]],['review-officer',[0,1,2,3]]].map(([id,indices])=>row('available-'+id,{slots:(indices as number[]).flatMap(i=>{const [d,p]=times[i];return [`${d}:${p}`,`${d}:${p+1}`];}),optedIn:true,note:''},{semesterId:sid,week:2,memberId:String(id)}));
 for(const resource of ['tasks','plans','records','record_versions','photos'] as const)seed.rows[resource]=[];
 return seed;
}
