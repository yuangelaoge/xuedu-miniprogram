import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Only synthetic rows in the disposable local container from v2-db-test.mjs.
const container = process.env.XUEDU_LOCAL_PG_CONTAINER;
const pgtest = container ? test : test.skip;
const raw = (sql: string) => execFileSync('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
  {input: sql, encoding: 'utf8', maxBuffer: 20_000_000}).trim();
const literal = (v: string) => "'" + v.replace(/'/g, "''") + "'";
const query = (view: string, week = 9, who = 'admin', semesterId = 's') => JSON.parse(raw(
  `SET ROLE service_role; SET request.jwt.claims='{"role":"service_role"}'; SELECT public.xuedu_v2_bootstrap_page(${literal('wx-' + who)},${literal(JSON.stringify(view === 'home' ? {includeHome: true} : {page: {view, week, semesterId}}))}::jsonb,false);`));
const tasks = (response: any) => (response.data.page || response.data.home).weekData.tasks;
const ids = (rows: any[]) => rows.map(t => t.id).sort();
const fingerprint = () => raw(`SELECT md5(jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t),
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM xuedu_v2.plans p),
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM xuedu_v2.records r))::text);`);

pgtest('page task scope: setup synthetic current/next weeks and oversized superseded history', () => {
  raw(`INSERT INTO xuedu_v2.workspace(id,epoch,version,permissions_version,active_semester_id,max_execution_ms)
    VALUES('main','e',1,1,'s',3000);
    INSERT INTO xuedu_v2.semesters(id,epoch,version,data)
    VALUES('s','e',1,jsonb_build_object('name','合成学期','weeks',18,'startDate',((current_timestamp AT TIME ZONE 'Asia/Shanghai')::date-49)::text)),
          ('past','e',1,'{"name":"合成历史学期","weeks":18,"startDate":"2020-09-07"}');
    INSERT INTO xuedu_v2.classes(id,epoch,version,data) VALUES('class','e',1,'{"name":"合成班级"}');
    INSERT INTO xuedu_v2.members(id,epoch,version,data)
      SELECT r,'e',1,jsonb_build_object('name',r,'role',r,'active',true,'classId','class') FROM unnest(ARRAY['admin','leader','officer','member']) r;
    INSERT INTO xuedu_v2.bindings(id,epoch,version,data,member_id,identity_key)
      SELECT 'bind-'||r,'e',1,'{}',r,'wx-'||r FROM unnest(ARRAY['admin','leader','officer','member']) r;
    INSERT INTO xuedu_v2.plans(id,epoch,version,data,semester_id,week) VALUES
      ('plan8','e',1,'{"status":"confirmed"}','s',8),
      ('current9','e',1,'{"status":"draft","uncovered":[]}','s',9),
      ('old9','e',1,'{"status":"superseded"}','s',9),
      ('past-plan','e',1,'{"status":"confirmed"}','past',9);
    INSERT INTO xuedu_v2.tasks(id,epoch,version,data,semester_id,week,member_id,parent_id)
      SELECT 'valid8-'||r,'e',1,jsonb_build_object('status',r,'course',jsonb_build_object('name','合成课程','room','合成教室'),'classLabel','合成班级','expectedCount',60),
        's',8,'member','plan8' FROM unnest(ARRAY['confirmed','submitted','pendingAdjustment']) r;
    INSERT INTO xuedu_v2.tasks(id,epoch,version,data,semester_id,week,member_id,parent_id)
      SELECT 'draft9-'||r,'e',1,jsonb_build_object('status','draft','courseOptions',jsonb_build_array(
        jsonb_build_object('occurrenceId','option-a','course',jsonb_build_object('name','合成课程A','room','合成教室A'),'date','2026-10-26'),
        jsonb_build_object('occurrenceId','option-b','course',jsonb_build_object('name','合成课程B','room','合成教室B'),'date','2026-10-27'))),
        's',9,r,'current9' FROM unnest(ARRAY['admin','leader','officer','member']) r;
    INSERT INTO xuedu_v2.tasks(id,epoch,version,data,semester_id,week,member_id,parent_id) VALUES
      ('cancel9','e',1,'{"status":"draft","cancel":true,"replacesTaskId":"valid8-confirmed"}','s',9,'member','current9'),
      ('orphan9','e',1,'{"status":"draft"}','s',9,'member','old9'),
      ('cancelled9','e',1,'{"status":"cancelled"}','s',9,'member','old9'),
      ('past-task','e',1,'{"status":"confirmed"}','past',9,'member','past-plan');
    INSERT INTO xuedu_v2.tasks(id,epoch,version,data,semester_id,week,member_id,parent_id)
      SELECT 'old-task-'||i,'e',1,jsonb_build_object('status','superseded','courseOptions',jsonb_build_array(jsonb_build_object('course',jsonb_build_object('name',repeat('合成历史课程',300))))),
        's',9,'member','old9' FROM generate_series(1,393) i;
    INSERT INTO xuedu_v2.records(id,epoch,version,data,semester_id,week,member_id,task_id)
      VALUES('record8','e',1,'{"classLabel":"合成班级","photos":["private-synthetic-photo"]}','s',8,'member','valid8-submitted');`);
  assert.ok(Number(raw(`SELECT octet_length(jsonb_agg(xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(t))))::text) FROM xuedu_v2.tasks t WHERE semester_id='s' AND week=9;`)) > 1_048_576);
});

pgtest('page task scope: history stays stored; only current draft and effective tasks are returned with unchanged snapshots', () => {
  const before = fingerprint();
  for (const who of ['admin','leader','officer','member']) {
    const page = query('schedule',9,who);
    const expected = ['admin','leader'].includes(who) ? ['draft9-admin','draft9-leader','draft9-officer','draft9-member','cancel9']
      : ['draft9-'+who,...(who === 'member' ? ['cancel9'] : [])];
    assert.deepEqual(ids(tasks(page)), expected.sort());
    const own = tasks(page).find((t: any) => t.id === 'draft9-'+who);
    const stored = JSON.parse(raw(`SELECT xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(t))) FROM xuedu_v2.tasks t WHERE id=${literal(own.id)}`));
    assert.deepEqual(own,stored);assert.equal(own.data.courseOptions.length,2);
    assert.equal(page.data.page.weekData.plan,undefined);
    assert.equal(page.data.page.weekData.draft.id,'current9');
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 100_000);
    assert.doesNotMatch(JSON.stringify(page),/identityKey|private-synthetic-photo/);
  }
  assert.equal(fingerprint(),before);
  console.log('Synthetic next-week response bytes:',Buffer.byteLength(JSON.stringify(query('schedule'))));
});

pgtest('page task scope: current week, next week without publication, historical selection and other page queries remain independent', () => {
  assert.deepEqual(ids(tasks(query('home',8,'member'))),['valid8-confirmed','valid8-pendingAdjustment','valid8-submitted']);
  assert.deepEqual(ids(tasks(query('schedule',8,'member'))),['valid8-confirmed','valid8-pendingAdjustment','valid8-submitted']);
  assert.deepEqual(ids(tasks(query('schedule',9,'member','past'))),['past-task']);
  for (const view of ['profile','records','courses','availability']) assert.ok(query(view,8,'member').data.page);
  assert.equal(query('records',8,'member').data.page.list.items.length,1);
  assert.equal(query('records',8,'member').data.page.list.items[0].id,'record8');
  assert.equal(tasks(query('schedule',10,'member')).length,0);
  // Synthetic publication proves next-week effective tasks survive the same filter.
  raw(`UPDATE xuedu_v2.plans SET data=data||'{"status":"confirmed"}' WHERE id='current9';
    UPDATE xuedu_v2.tasks SET data=data||'{"status":"confirmed"}' WHERE parent_id='current9' AND data->>'cancel' IS DISTINCT FROM 'true';
    UPDATE xuedu_v2.tasks SET data=data||'{"status":"cancelled"}' WHERE id='cancel9';`);
  assert.deepEqual(ids(tasks(query('schedule',9,'member'))),['draft9-member']);
  assert.equal(query('schedule',9,'member').data.page.weekData.plan.id,'current9');
  assert.equal(query('schedule',9,'member').data.page.weekData.draft,undefined);
  raw(`UPDATE xuedu_v2.tasks SET data=data||'{"status":"cancelled"}' WHERE week=8;`);
  assert.equal(tasks(query('home',8,'member')).length,0);
  assert.equal(tasks(query('schedule',9,'member')).length,1);
});

pgtest('page task scope: reapplying migration preserves stored data and server-only access', () => {
  const before = fingerprint();
  raw(readFileSync('server/migrations/012-page-task-scope.sql','utf8'));
  assert.equal(fingerprint(),before);
  for (const role of ['anon','authenticated']) assert.equal(raw(`SELECT has_function_privilege(${literal(role)},'public.xuedu_v2_bootstrap_page(text,jsonb,boolean)','EXECUTE')`),'f');
  assert.equal(raw(`SELECT has_function_privilege('service_role','public.xuedu_v2_bootstrap_page(text,jsonb,boolean)','EXECUTE')`),'t');
});
