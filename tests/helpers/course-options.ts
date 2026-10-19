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
export function optionFixture() {const seed=optionSeed(),repo=new MemoryRepository(seed.workspace,seed.rows,()=>optionNow);return {seed,repo,...optionApi(repo)};}
export function changed(result:{data:Record<string,unknown>},predicate:(e:Entity)=>boolean):Entity {return (result.data.changed as Entity[]).find(predicate)!;}
export async function generateOptions(f:ReturnType<typeof optionApi>, priorityGrade='') {
 const draft=await f.call('command',{type:'planGenerate',week:2,priorityGrade});
 const plan=changed(draft,e=>e.data.status==='draft' && e.data.uncovered!==undefined);
 const task=changed(draft,e=>e.memberId==='review-member' && e.data.courseOptions!==undefined);
 return {plan,task};
}
