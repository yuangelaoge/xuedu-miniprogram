import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { PostgresRepository } from "../server/v2/postgres";
import { Commit, Entity } from "../miniprogram/domain/v2/protocol";
const container = process.env.XUEDU_LOCAL_PG_CONTAINER;
const pgtest = container ? test : test.skip;
const quote = (v: unknown) => "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
const command = (sql: string) => ['exec','-i',container!, 'psql','-U','postgres','-v','ON_ERROR_STOP=1','-Atq','-c',sql];
const raw = (sql: string) => execFileSync('docker', command(sql), {encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const role = (name = 'service_role') => `SET ROLE ${name}; SET request.jwt.claims='{"role":"${name}"}'; `;
const db = { async rpc(name: string, args: Record<string,unknown>) {
 const values = name === 'xuedu_v2_workspace' ? '' : ['xuedu_v2_query','xuedu_v2_count'].includes(name) ? "'" + String(args.p_resource).replace(/'/g,"''") + "'," + quote(args.p_query) : quote(args.p_command);
 try { return {data:JSON.parse(raw(role()+`SELECT public.${name}(${values});`)),error:null}; }
 catch (e) {const message=String((e as {stderr?:unknown}).stderr);return {data:null,error:{message,code:message.includes('duplicate key')?'23505':''}};}
}};
const repo = new PostgresRepository(db);
const row = (id:string,data:Record<string,unknown>,extra:Partial<Entity>={}): Omit<Entity,'version'> => ({id,epoch:'initial',data,...extra});
async function base(rest:Partial<Commit>={}):Promise<Commit>{const w=await repo.workspace();return{epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'wx-a',actorId:'a',requestId:Math.random().toString(36),reads:[],changes:[],result:{ok:true},...rest};}
async function initialize(){return repo.commit(await base({initialize:true,changes:[
 {resource:'classes',id:'c',expectedVersion:0,value:row('c',{name:'真实班级',grade:'25',major:'自动化'})},
 {resource:'members',id:'a',expectedVersion:0,value:row('a',{name:'管理员',role:'admin',active:true,classId:'c'},{studentNo:'1'})},
 {resource:'bindings',id:'ba',expectedVersion:0,value:row('ba',{},{memberId:'a',identityKey:'wx-a'})}]}));}
pgtest('real PostgreSQL: private tables, RLS, server-only RPC; workspace read never initializes',async()=>{
 assert.equal((await repo.workspace()).version,0);assert.equal(raw('SELECT count(*) FROM xuedu_v2.workspace'),'0');
 for(const name of ['anon','authenticated']){
  assert.throws(()=>raw(role(name)+'SELECT public.xuedu_v2_workspace()'),/Command failed/);
  assert.throws(()=>raw(role(name)+'SELECT * FROM xuedu_v2.members'),/Command failed/);
 }
 assert.throws(()=>raw("SET request.jwt.claims='{\"role\":\"anon\"}';SELECT public.xuedu_v2_workspace()"),/Command failed/);
 assert.equal(raw("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='xuedu_v2' AND c.relkind='r' AND NOT c.relrowsecurity"),'0');
 await initialize(); await assert.rejects(repo.commit(await base({initialize:true})),/ALREADY_INITIALIZED/);
});
pgtest('real PostgreSQL: conflicts and unique constraints rollback atomically; idempotency replays',async()=>{
 const c=await base({requestId:'replay',result:{stable:42}});await repo.commit(c);assert.deepEqual(await repo.commit(c),{stable:42});
 await assert.rejects(repo.commit({...c,requestId:'conflict'}),/VERSION_CONFLICT/);
 await assert.rejects(repo.commit(await base({identityKey:'spoof'})),/IDENTITY_CHANGED/);
 const before=(await repo.workspace()).version;
 await assert.rejects(repo.commit(await base({changes:[{resource:'members',id:'duplicate',expectedVersion:0,value:row('duplicate',{role:'member',active:true},{studentNo:'1'})}]})),/UNIQUE_CONFLICT/);
 assert.equal((await repo.workspace()).version,before);assert.equal(await repo.get('members','duplicate'),undefined);
 await assert.rejects(repo.commit(await base({changes:[{resource:'members',id:'a',expectedVersion:1,value:row('a',{role:'member',active:true},{studentNo:'1'})}]})),/LAST_ADMIN/);
});
pgtest('real PostgreSQL: concurrent resignations leave one active administrator',async()=>{
 await repo.commit(await base({changes:[{resource:'members',id:'b',expectedVersion:0,value:row('b',{role:'admin',active:true,classId:'c'},{studentNo:'2'})},{resource:'bindings',id:'bb',expectedVersion:0,value:row('bb',{},{memberId:'b',identityKey:'wx-b'})}]}));
 const c1=await base({changes:[{resource:'members',id:'a',expectedVersion:1,value:row('a',{role:'member',active:true,classId:'c'},{studentNo:'1'})}]});
 const c2=await base({identityKey:'wx-b',actorId:'b',changes:[{resource:'members',id:'b',expectedVersion:1,value:row('b',{role:'member',active:true,classId:'c'},{studentNo:'2'})}]});
 const run=promisify(execFile); const results=await Promise.allSettled([c1,c2].map(c=>run('docker',command(role()+`SELECT public.xuedu_v2_commit(${quote(c)});`))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(raw("SELECT count(*) FROM xuedu_v2.members WHERE data->>'role'='admin' AND data->>'active'='true'"),'1');
 // Restore test principal independently through the surviving trusted administrator.
 raw("UPDATE xuedu_v2.members SET data=data||'{\"role\":\"admin\"}'::jsonb WHERE id='a'");
});
pgtest('real PostgreSQL: 10 semesters/100 members/60 classes/12000 records paginate above 650KB and still write',async()=>{
 await repo.commit(await base({requestId:'capacity-replay',result:{stable:84}}));
 raw(`INSERT INTO xuedu_v2.semesters SELECT 's'||i,'initial',1,jsonb_build_object('name','semester '||i),NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM generate_series(1,10)i;
 INSERT INTO xuedu_v2.classes(id,epoch,version,data) SELECT 'class'||i,'initial',1,jsonb_build_object('name','class '||i) FROM generate_series(1,59)i;
 INSERT INTO xuedu_v2.members(id,epoch,version,data,student_no) SELECT 'm'||i,'initial',1,jsonb_build_object('role','member','active',true,'classId','c'),'student'||i FROM generate_series(1,98)i;
 INSERT INTO xuedu_v2.records(id,epoch,version,data,semester_id,week,member_id,task_id) SELECT 'r'||lpad(i::text,5,'0'),'initial',1,jsonb_build_object('notes',repeat('observation ',30)),'s'||(1+(i%10)),1+(i%20),'m'||(1+(i%98)),'t'||i FROM generate_series(1,12000)i;
 INSERT INTO xuedu_v2.requests(id,epoch,version,data,identity_key,parent_id) SELECT 'request'||i,'initial',1,jsonb_build_object('result',jsonb_build_object('i',i)),'wx-a','seed'||i FROM generate_series(1,600)i;`);
 assert.ok(Number(raw('SELECT sum(pg_column_size(data)) FROM xuedu_v2.records'))>650000);
 assert.equal(await repo.count('records',{eq:{semesterId:'s2'}}),1200);assert.equal(await repo.count('records',{}),12000);
 assert.equal((await repo.query('records',{})).items.length,50); await assert.rejects(repo.query('records',{limit:101}),/INVALID_QUERY/);
 let cursor='',count=0;do{const p=await repo.query('records',{eq:{semesterId:'s2'},limit:100,after:cursor});count+=p.items.length;cursor=p.cursor;}while(cursor);assert.equal(count,1200);
 let reportCursor='',reportCount=0;do{const report=await repo.query('records',{eq:{semesterId:'s2',week:2},limit:100,after:reportCursor});assert.ok(report.items.every(r=>r.semesterId==='s2'&&r.week===2));reportCount+=report.items.length;reportCursor=report.cursor;}while(reportCursor);assert.equal(reportCount,600);
 await repo.commit(await base({changes:[{resource:'audit',id:'after-capacity',expectedVersion:0,value:row('after-capacity',{action:'capacity-verified'})}]}));
 assert.ok(Number(raw('SELECT count(*) FROM xuedu_v2.requests'))>600);
 assert.deepEqual(await repo.commit(await base({requestId:'capacity-replay'})),{stable:84});
 await assert.rejects(repo.commit(await base({requestId:'replay'})),/IDENTITY_CHANGED/);
});
pgtest('real PostgreSQL: status-indexed task reads exclude completed history',async()=>{
 raw(`INSERT INTO xuedu_v2.tasks(id,epoch,version,data,semester_id,week,member_id) SELECT 'historical-task'||i,'initial',1,jsonb_build_object('status',CASE WHEN i=6001 THEN 'confirmed' ELSE 'submitted' END),'s1',1,'m1' FROM generate_series(1,6001)i;`);
 const filter={eq:{memberId:'m1'},in:{status:['confirmed','pendingAdjustment','draft']}};
 assert.equal(await repo.count('tasks',filter),1);assert.equal((await repo.query('tasks',filter)).items.length,1);
 assert.equal(await repo.count('tasks',{eq:{status:'submitted'}}),6000);
});
pgtest('real PostgreSQL: revoked bindings and removed members cannot replay old authorized results',async()=>{
 const receipt=await base({requestId:'private-before-rebind',result:{privateRecord:'private'}});await repo.commit(receipt);
 const binding=(await repo.get('bindings','ba'))!;
 await repo.commit(await base({changes:[{resource:'bindings',id:binding.id,expectedVersion:binding.version,value:{...binding,identityKey:'wx-new'}}]}));
 await assert.rejects(repo.commit(receipt),/IDENTITY_CHANGED/);
 await assert.rejects(repo.commit(await base()),/IDENTITY_CHANGED/);
 const moved=(await repo.get('bindings','ba'))!;
 await repo.commit(await base({identityKey:'wx-new',changes:[{resource:'bindings',id:moved.id,expectedVersion:moved.version,value:{...moved,identityKey:'wx-a'}}]}));
 await repo.commit(await base({changes:[{resource:'bindings',id:'bm1',expectedVersion:0,value:row('bm1',{},{memberId:'m1',identityKey:'wx-m1'})}]}));
 const memberReceipt=await base({actorId:'m1',identityKey:'wx-m1',requestId:'member-before-remove',result:{ok:true}});await repo.commit(memberReceipt);
 const member=(await repo.get('members','m1'))!;
 await repo.commit(await base({changes:[{resource:'members',id:member.id,expectedVersion:member.version,value:{...member,data:{...member.data,active:false}}}]}));
 await assert.rejects(repo.commit(memberReceipt),/IDENTITY_CHANGED/);
 await assert.rejects(repo.commit(await base({actorId:'m1',identityKey:'wx-m1'})),/IDENTITY_CHANGED/);
});
pgtest('real PostgreSQL: epoch and maintenance freeze reject delayed writers',async()=>{
 const before=await base();await repo.commit(await base({workspace:{maintenance:'job'}}));
 await assert.rejects(repo.commit(await base()),/MAINTENANCE/);
 await assert.rejects(repo.commit({...before,requestId:'delayed'}),/VERSION_CONFLICT/);
 await assert.rejects(repo.commit(await base({maintenanceId:'old-job'})),/MAINTENANCE/);
 await repo.commit(await base({maintenanceId:'job',workspace:{maintenance:''}}));
});
pgtest('real PostgreSQL: cutover validates legacy retention, stays frozen until independent open, keeps old workspace',async()=>{
 const {createCutoverPlan}=await import('../scripts/v2-cutover.mjs');
 raw("CREATE SCHEMA xuedu_private; CREATE TABLE xuedu_private.workspace(stage text PRIMARY KEY,revision bigint,document jsonb)");
 const member={id:'admin-old',name:'管理员',studentNo:'001',classId:'class-old',role:'admin',active:true,identityKey:'old-wx'};
 const inactive={...member,id:'admin-inactive',studentNo:'002',active:false,identityKey:'inactive-wx'};
 const state={members:[member,inactive],classes:[{id:'class-old',name:'原班级',grade:'25',major:'自动化'}],semesters:[],applications:[],courses:[],availability:[],plans:[],drafts:[],records:[],audit:[]};
 const source={environmentId:'xuedu-trial-d2gs2dpnla9206eb3',functionName:'xueduTrial',revision:3,document:{stage:'trial',epoch:'legacy',version:3,state,files:[]}};
 raw(`INSERT INTO xuedu_private.workspace VALUES('trial',3,${quote(source.document)})`);
 raw("DO $$DECLARE r record;BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='xuedu_v2' LOOP EXECUTE format('TRUNCATE xuedu_v2.%I',r.tablename);END LOOP;END$$");
 const plan=createCutoverPlan(source,{epoch:'new-epoch',maxExecutionMs:3000});
 const corrupt=JSON.parse(JSON.stringify(plan));corrupt.retained.members.find((m:Entity)=>m.id==='admin-inactive').data.active=true;
 assert.throws(()=>raw(role()+`SELECT public.xuedu_v2_cutover_prepare(${quote(corrupt)})`),/Command failed/);
 raw(role()+`SELECT public.xuedu_v2_cutover_prepare(${quote(plan)})`);
 assert.equal((await repo.workspace()).maintenance,plan.id);assert.equal((await repo.query('members',{})).items.length,2);
 assert.equal(raw('SELECT count(*) FROM xuedu_private.workspace'),'1');
 assert.throws(()=>raw(role()+`SELECT public.xuedu_v2_cutover_open('new-epoch',1,'wrong')`),/Command failed/);
 raw(role()+`SELECT public.xuedu_v2_cutover_open('new-epoch',1,'${plan.sha256}')`);
 assert.equal((await repo.workspace()).maintenance,'');assert.equal(raw("SELECT data->>'active' FROM xuedu_v2.members WHERE id='admin-inactive'"),'false');
 assert.throws(()=>raw(role()+"SELECT public.xuedu_commit_workspace('trial',3,'{}')"),/Command failed/);
 // Migration cannot silently bypass a legacy unfinished cleanup on a repeat installation.
 raw("UPDATE xuedu_private.workspace SET document=document||'{\"cleaning\":true}'::jsonb");
 assert.throws(()=>execFileSync('docker',['exec','-i',container!,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],{input:readFileSync('server/migrations/003-v2-resources.sql'),stdio:['pipe','pipe','pipe']}),/Command failed/);
});
