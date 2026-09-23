import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../server/v2/memory";
import { Commit, Entity } from "../miniprogram/domain/v2/protocol";

function row(id: string, data: Record<string, unknown>, rest: Partial<Entity> = {}): Omit<Entity, "version"> { return { id, epoch: "initial", data, ...rest }; }
async function initialized() {
 const repo = new MemoryRepository();
 await repo.commit({ epoch:"initial", workspaceVersion:0, permissionsVersion:0, identityKey:"wx-admin", actorId:"a", requestId:"init", initialize:true, reads:[], changes:[
 {resource:"members",id:"a",expectedVersion:0,value:row("a",{role:"admin",active:true,classId:"c"},{studentNo:"1"})},
 {resource:"classes",id:"c",expectedVersion:0,value:row("c",{name:"班"})},
 {resource:"bindings",id:"b",expectedVersion:0,value:row("b",{},{memberId:"a",identityKey:"wx-admin"})}], result:{ok:true} });
 return repo;
}
async function command(repo: MemoryRepository, rest: Partial<Commit> = {}): Promise<Commit> {
 const w=await repo.workspace(); return {epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:"wx-admin",actorId:"a",requestId:Math.random().toString(),reads:[],changes:[],result:{ok:true},...rest};
}
test("V2 empty workspace read is side effect free; initialize is atomic", async()=>{
 const r=new MemoryRepository(); assert.equal((await r.workspace()).version,0); assert.equal((await r.query("classes",{})).items.length,0);
 const repo=await initialized(); assert.equal((await repo.workspace()).version,1);
 await assert.rejects(repo.commit(await command(repo,{initialize:true})),/ALREADY_INITIALIZED/);
});
test("V2 transaction rejects stale versions, spoofed actor and last administrator removal without partial writes",async()=>{
 const r=await initialized(); const c=await command(r,{changes:[{resource:"members",id:"a",expectedVersion:1,value:row("a",{role:"member",active:true},{studentNo:"1"})}]});
 await assert.rejects(r.commit(c),/LAST_ADMIN/); assert.equal((await r.get("members","a"))!.version,1);
 await assert.rejects(r.commit({...c,identityKey:"other"}),/IDENTITY_CHANGED/);
 await r.commit(await command(r)); await assert.rejects(r.commit(c),/VERSION_CONFLICT/);
});
test("V2 independent idempotency survives more than 500 commands and replays original result",async()=>{
 const r=await initialized(); const first=await command(r,{requestId:"first",result:{value:99}}); await r.commit(first);
 for(let i=0;i<510;i++) await r.commit(await command(r));
 assert.deepEqual(await r.commit(first),{value:99});
 assert.equal((await r.query("requests",{eq:{identityKey:"wx-admin",parentId:"first"}})).items[0].data.result && true,true);
});
test("V2 pagination defaults50 caps100 and capacity has no workspace JSON limit",async()=>{
 const rows:Entity[]=Array.from({length:12000},(_,i)=>({id:String(i).padStart(5,"0"),epoch:"initial",version:1,semesterId:"s"+(i%10),week:i%20,memberId:"m"+(i%100),data:{notes:"观测数据".repeat(30)}}));
 const r=new MemoryRepository(undefined,{records:rows}); assert.equal((await r.query("records",{})).items.length,50); await assert.rejects(r.query("records",{limit:101}),/INVALID_QUERY/);
 let cursor="",n=0; do {const p=await r.query("records",{eq:{semesterId:"s1"},limit:100,after:cursor}); n+=p.items.length;cursor=p.cursor;}while(cursor); assert.equal(n,1200);
});
