import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiRequest, Entity } from '../miniprogram/domain/v2/protocol';
import { Repository } from '../server/v2/repository';
import { createGatewayV2 } from '../server/v2/gateway';
import { MemoryRepository } from '../server/v2/memory';
import { reviewIdentity } from '../server/v2/review-seed';
import { optionNow, optionSeed } from './helpers/course-options';

function fixture() {
  const seed = optionSeed(), source = seed.rows.records![0];
  seed.rows.records = Array.from({length:65}, (_, i) => ({...structuredClone(source), id:'foreign-'+String(i).padStart(3,'0'), taskId:'foreign-task-'+i}));
  const own: Entity = {...structuredClone(source),id:'z-own',memberId:'review-member',taskId:'review-task-open'};
  seed.rows.records.push(own,source);
  seed.rows.record_versions!.push({...structuredClone(seed.rows.record_versions![0]),id:'foreign-history',recordId:'foreign-000'});
  const repository: Repository = new MemoryRepository(seed.workspace,seed.rows,()=>optionNow);
  const gateway = createGatewayV2({repository,appid:'app',bootstrapOpenid:'unused',maxExecutionMs:3000,now:()=>optionNow,uuid:()=> 'unused',
    photos:{async upload(){throw Error('unexpected upload');},async delete(){throw Error('unexpected delete');},async list(){return [];},async urls(){return ['https://synthetic.invalid/photo'];}}});
  const call = (request:Partial<ApiRequest>,role='member') => gateway({protocolVersion:2,operation:'query',epoch:seed.workspace.epoch,semesterId:seed.workspace.activeSemesterId,...request},
    {OPENID:reviewIdentity('options',role as 'member'|'admin'|'officer'|'leader'|'applicant'),APPID:'app'});
  return {seed,repository,gateway,call,own};
}
const supported = {recordTextSharing:true};

test('旧客户端缺省与false能力保持本人记录分页；支持无照片的新客户端才读取全组文字',async()=>{
  const f=fixture();
  for (const capability of [undefined,{recordTextSharing:false}]) {
    const result=await f.call({payload:{kind:'records',week:1},clientCapabilities:capability});
    assert.deepEqual((result.data.items as Entity[]).map(r=>r.id),['z-own']);
    assert.equal(result.cursor,'');
    const page=await f.call({operation:'bootstrap',clientCapabilities:capability,payload:{fastPage:true,page:{view:'records',week:1}}});
    const data=page.data.page as {list:{items:Entity[]};summary:{submitted:number}};
    assert.deepEqual(data.list.items.map(r=>r.id),['z-own']);assert.equal(data.summary.submitted,1);
  }
  const result=await f.call({clientCapabilities:supported,payload:{kind:'records',week:1}});
  assert.equal((result.data.items as Entity[]).length,50);assert.ok(result.cursor);
  assert.ok((result.data.items as Entity[]).every(r=>r.data.photos===undefined));
});

test('旧版他人详情/历史在读取前拒绝，新版只开放文字；能力标识不能越过角色与照片权限',async()=>{
  const f=fixture(),foreign='foreign-000';
  for(const kind of ['record','recordVersions']) {
    await assert.rejects(f.call({payload:{kind,id:foreign}}),/不可查看他人记录/);
    const result=await f.call({clientCapabilities:supported,payload:{kind,id:foreign}});
    if(kind==='record') {const record=result.data.record as Entity;assert.equal(record.data.photos,undefined);assert.equal(result.data.canEdit,false);}
    else {const rows=result.data.items as Entity[];assert.equal(rows.length,1);assert.equal(rows[0].data.photos,undefined);}
  }
  await assert.rejects(f.call({operation:'bootstrap',payload:{page:{view:'record',targetId:foreign}}}),/无权查看/);
  const detail=await f.call({operation:'bootstrap',clientCapabilities:supported,payload:{page:{view:'record',targetId:foreign}}});
  assert.equal((detail.data.page as {record:{record:Entity}}).record.record.data.photos,undefined);
  for(const capability of [undefined,supported]) {
    await assert.rejects(f.call({operation:'photoUrls',clientCapabilities:capability,payload:{recordId:foreign}}),/不可查看他人照片/);
    await assert.rejects(f.call({clientCapabilities:capability,payload:{kind:'excelReport',week:1}}),/仅管理员/);
  }
  await assert.rejects(f.call({clientCapabilities:supported,payload:{kind:'records',week:1}},'applicant'),/通过审核/);
  for(const role of ['admin','leader','officer']) {
    const result=await f.call({payload:{kind:'record',id:foreign}},role);
    assert.deepEqual((result.data.record as Entity).data.photos,['review-photo-sample']);
    assert.equal((await f.call({operation:'photoUrls',payload:{recordId:foreign}},role)).data.urls instanceof Array,true);
  }
});

test('旧版records继续使用本人快速RPC，新版普通成员才走全组文字后备查询',async()=>{
  const f=fixture();let fastCalls=0;
  const prior=await f.call({operation:'bootstrap',payload:{page:{view:'records',week:1}}});
  f.repository.bootstrapPage=async()=>{fastCalls++;return structuredClone(prior);};
  const old=await f.call({operation:'bootstrap',payload:{fastPage:true,page:{view:'records',week:1}}});
  assert.equal(fastCalls,1);assert.deepEqual((old.data.page as {list:{items:Entity[]}}).list.items.map(r=>r.id),['z-own']);
  const current=await f.call({operation:'bootstrap',clientCapabilities:supported,payload:{fastPage:true,page:{view:'records',week:1}}});
  assert.equal(fastCalls,2);const items=(current.data.page as {list:{items:Entity[]}}).list.items;
  assert.equal(items.length,50);assert.ok(items.every(r=>r.data.photos===undefined));
});
