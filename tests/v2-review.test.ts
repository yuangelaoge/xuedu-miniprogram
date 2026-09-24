import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { createReviewGateway, ReviewSession, ReviewStore, verifyReviewPassword } from '../server/v2/review';
import { makeReviewSeed, ReviewRole, ReviewSnapshot } from '../server/v2/review-seed';
import { previewAuthorizedImages } from '../miniprogram/services/v2/page';
import { runtime } from '../miniprogram/config/runtime';
import { exportTxt, exportXlsx } from '../miniprogram/domain/reports';

const password = 'synthetic-review-secret';
const salt = randomBytes(16);
const passwordHash = `scrypt$16384$8$1$${salt.toString('base64url')}$${scryptSync(password,salt,32,{N:16384,r:8,p:1,maxmem:32*1024*1024}).toString('base64url')}`;
const timestamp = Date.parse('2026-09-24T02:00:00.000Z');
class Store implements ReviewStore {
  sessions = new Map<string,ReviewSession>();
  async login(digest:string,valid:boolean,seed:ReviewSnapshot,expiresAt:string) { if (!valid) return false; this.sessions.set(digest,{snapshot:seed,version:1,role:'admin',expiresAt}); return true; }
  async read(digest:string) { return this.sessions.get(digest) || null; }
  async save(digest:string,expectedVersion:number,snapshot:ReviewSnapshot) { const s=this.sessions.get(digest)!; if(s.version!==expectedVersion) throw new Error('REVIEW_VERSION_CONFLICT'); s.snapshot=snapshot; return ++s.version; }
  async role(digest:string,expectedVersion:number,role:ReviewRole) { const s=this.sessions.get(digest)!; if(s.version!==expectedVersion) throw new Error('REVIEW_VERSION_CONFLICT'); s.role=role; return ++s.version; }
  async logout(digest:string) { this.sessions.delete(digest); }
}
function setup() {
  const store=new Store(); let now=timestamp; let n=0;
  const gateway=createReviewGateway({appid:'test-app',passwordHash,sessionKey:'a'.repeat(64),enabled:true,accessUntil:'2026-09-25T02:00:00.000Z',store,maxExecutionMs:3000,now:()=>now,uuid:()=>`review-test-${++n}`});
  const call=(operation:string, fields:Record<string,unknown>={}, openid='trusted-reviewer')=>gateway({protocolVersion:2,operation,...fields},{OPENID:openid,APPID:'test-app'});
  return {store,call,advance:(ms:number)=>{now+=ms;}};
}
test('审核密码仅校验服务端 scrypt 摘要',()=>{
  assert.equal(verifyReviewPassword(password,passwordHash),true);
  assert.equal(verifyReviewPassword('wrong',passwordHash),false);
  assert.equal(verifyReviewPassword(password,'not-a-hash'),false);
});
test('审核账号绑定可信微信、到期失效，不可借审核会话调用真实业务清空',async()=>{
  const x=setup();
  await assert.rejects(x.call('reviewLogin',{payload:{username:'审核老师辛苦了',password:'wrong'}}),/账号或密码无效/);
  await assert.rejects(x.call('bootstrap',{review:true}),/审核体验已到期/);
  await x.call('reviewLogin',{payload:{username:'审核老师辛苦了',password}});
  const boot=await x.call('bootstrap',{review:true});
  assert.equal(boot.data.status,'ready'); assert.equal((boot.data.member as any).data.role,'admin');
  await assert.rejects(x.call('clearPreview',{review:true,epoch:boot.epoch}),/无权执行/);
  await assert.rejects(x.call('bootstrap',{review:true},'another-wechat'),/审核体验已到期/);
  await x.call('reviewRole',{payload:{role:'member'}});
  const memberBoot=await x.call('bootstrap',{review:true});
  assert.equal((memberBoot.data.member as any).data.role,'member');
  await assert.rejects(x.call('query',{review:true,epoch:boot.epoch,semesterId:'review-semester',payload:{kind:'record',id:'review-record'}}),/不可查看他人记录/);
  await assert.rejects(x.call('query',{review:true,epoch:boot.epoch,payload:{kind:'members'}}),/没有管理权限/);
  const mine=await x.call('query',{review:true,epoch:boot.epoch,semesterId:'review-semester',payload:{kind:'week',week:1}});
  assert.equal((mine.data.tasks as any[]).length,1); assert.equal((mine.data.records as any[]).length,0);
  await x.call('reviewRole',{payload:{role:'leader'}});
  const lead=await x.call('query',{review:true,epoch:boot.epoch,semesterId:'review-semester',payload:{kind:'records'}});
  assert.equal((lead.data.items as any[]).length,1);
  await x.call('reviewLogout');
  await assert.rejects(x.call('bootstrap',{review:true}),/审核体验已到期/);
});
test('审核样例照片不保存原图；角色切换和写入仅更新对应会话',async()=>{
  const x=setup(); await x.call('reviewLogin',{payload:{username:'审核老师辛苦了',password}});
  await x.call('reviewRole',{payload:{role:'member'}});
  const boot=await x.call('bootstrap',{review:true});
  const photo=await x.call('photo',{review:true,epoch:boot.epoch,semesterId:'review-semester',requestId:'photo-1',payload:{taskId:'review-task-open',base64:'aGVsbG8='}});
  assert.ok(photo.data.photoId);
  const digest=[...x.store.sessions.keys()][0], state=x.store.sessions.get(digest)!;
  assert.ok(state.snapshot.rows.photos?.some(row=>row.id===photo.data.photoId));
  assert.doesNotMatch(JSON.stringify(state.snapshot),/aGVsbG8=/);
  const urls=await x.call('photoUrls',{review:true,epoch:boot.epoch,semesterId:'review-semester',payload:{ids:[photo.data.photoId]}});
  assert.deepEqual(urls.data.urls,['/assets/review-signature.png']);
  const submit=await x.call('command',{review:true,epoch:boot.epoch,semesterId:'review-semester',expectedVersion:1,requestId:'submit-1',payload:{type:'recordSubmit',taskId:'review-task-open',metrics:{expected:32,actual:31,late:0,early:0,sleep:0,phone:0,talk:0,other:0},photos:[photo.data.photoId],absentNames:'',leaveNames:'',evaluation:'审核样例正常',feedback:'',suggestion:'',otherDescription:''}});
  assert.ok(submit.data.changed);
  const mine=await x.call('query',{review:true,epoch:boot.epoch,semesterId:'review-semester',payload:{kind:'records'}});
  assert.equal((mine.data.items as any[]).length,1);
  assert.equal(state.snapshot.workspace.id,'review');
});
test('审核样例创建只含合成资料',()=>{
  const seed=makeReviewSeed('f'.repeat(64),'seed',timestamp,3000);
  assert.equal(seed.workspace.id,'review'); assert.equal(seed.rows.members?.length,3);
  assert.ok(JSON.stringify(seed).length<524288);
});
test('审核样例可读取课程、历史记录与报表，并生成下一周排班草稿', async()=>{
  const x=setup(); await x.call('reviewLogin',{payload:{username:'审核老师辛苦了',password}});
  const boot=await x.call('bootstrap',{review:true});
  const semesterId='review-semester';
  const classes=await x.call('query',{review:true,epoch:boot.epoch,payload:{kind:'classes'}});
  assert.equal((classes.data.items as any[]).length,2);
  const courses=await x.call('query',{review:true,epoch:boot.epoch,semesterId,payload:{kind:'courses'}});
  assert.equal((courses.data.items as any[]).length,2);
  const report=await x.call('query',{review:true,epoch:boot.epoch,semesterId,payload:{kind:'report',week:1}});
  assert.equal((report.data.records as any[]).length,1);
  assert.match(exportTxt(report.data.state as any,1),/审核样例/);
  assert.ok(exportXlsx(report.data.state as any,1).byteLength>1000);
  const applications=await x.call('query',{review:true,epoch:boot.epoch,payload:{kind:'applications'}});
  assert.equal((applications.data.items as any[]).length,1);
  const generated=await x.call('command',{review:true,epoch:boot.epoch,semesterId,expectedVersion:0,requestId:'generate-2',payload:{type:'planGenerate',week:2}});
  assert.ok(generated.data.changed);
  const nextWeek=await x.call('query',{review:true,epoch:boot.epoch,semesterId,payload:{kind:'week',week:2}});
  assert.equal(nextWeek.data.draft?.data.status,'draft');
  const draft=nextWeek.data.draft as any;
  await x.call('command',{review:true,epoch:boot.epoch,semesterId,expectedVersion:draft.version,requestId:'confirm-2',payload:{type:'planConfirm',id:draft.id,reason:'审核样例确认'}});
  const confirmed=await x.call('query',{review:true,epoch:boot.epoch,semesterId,payload:{kind:'week',week:2}});
  assert.equal(confirmed.data.plan?.data.status,'confirmed');
});

test('审核样例预览先把代码包图片解析为可预览的本地路径',async()=>{
  const original=(globalThis as any).wx, env=runtime.env;
  const previews:any[]=[]; runtime.env='review-preview-test';
  (globalThis as any).wx={getStorageSync:(key:string)=>key==='xuedu.review.active.review-preview-test',async getImageInfo({src}:any){assert.equal(src,'/assets/review-signature.png');return {path:'wxfile://review-sample.png'};},async previewImage(options:any){previews.push(options);}};
  try { await previewAuthorizedImages(['/assets/review-signature.png'],0); assert.deepEqual(previews,[{urls:['wxfile://review-sample.png'],current:'wxfile://review-sample.png'}]); }
  finally { (globalThis as any).wx=original;runtime.env=env; }
});
test('审核申请人可走人工审核和限时自动通过，均只绑定本会话',async()=>{
  const manual=setup(); await manual.call('reviewLogin',{payload:{username:'审核老师辛苦了',password}});
  await manual.call('reviewRole',{payload:{role:'applicant'}});
  const first=await manual.call('bootstrap',{review:true});assert.equal(first.data.member,null);
  await manual.call('command',{review:true,epoch:first.epoch,requestId:'applicant-join',payload:{type:'join',name:'样例新同学',studentNo:'REVIEW-NEW-1',classId:'review-class-a'}});
  await manual.call('reviewRole',{payload:{role:'admin'}});
  const applications=await manual.call('query',{review:true,epoch:first.epoch,payload:{kind:'applications'}});
  const submitted=(applications.data.items as any[]).find(row=>row.studentNo==='REVIEW-NEW-1');assert.ok(submitted);
  await manual.call('command',{review:true,epoch:first.epoch,expectedVersion:submitted.version,requestId:'approve-applicant',payload:{type:'applicationReview',id:submitted.id,approved:true,reason:'审核样例确认'}});
  await manual.call('reviewRole',{payload:{role:'applicant'}});
  const admitted=await manual.call('bootstrap',{review:true});assert.equal((admitted.data.member as any).data.role,'member');

  const automatic=setup();await automatic.call('reviewLogin',{payload:{username:'审核老师辛苦了',password}});
  const adminBoot=await automatic.call('bootstrap',{review:true});
  await automatic.call('command',{review:true,epoch:adminBoot.epoch,expectedVersion:adminBoot.resourceVersions.workspace,requestId:'enable-auto',payload:{type:'autoApprovalSet',enabled:true,expiresAt:'2026-09-24T03:00:00.000Z'}});
  await automatic.call('reviewRole',{payload:{role:'applicant'}});
  const applicantBoot=await automatic.call('bootstrap',{review:true});assert.equal(applicantBoot.data.member,null);
  const joined=await automatic.call('command',{review:true,epoch:applicantBoot.epoch,requestId:'auto-join',payload:{type:'join',name:'样例自动入组',studentNo:'REVIEW-NEW-2',classId:'review-class-b'}});
  assert.equal(joined.data.automaticallyApproved,true);
  const autoMember=await automatic.call('bootstrap',{review:true});assert.equal((autoMember.data.member as any).data.role,'member');
});
