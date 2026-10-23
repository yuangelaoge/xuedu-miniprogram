import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { PostgresRepository } from '../server/v2/postgres';
import { createGatewayV2 } from '../server/v2/gateway';
import type { ApiRequest, Entity, PageResult, Resource } from '../miniprogram/domain/v2/protocol';
import type { PageData } from '../miniprogram/domain/v2/page-data';
import type { Metrics } from '../miniprogram/domain/types';
import type { TaskCourseOption } from '../miniprogram/domain/v2/task-options';

// This suite only accepts the disposable local container created by v2-db-test.mjs.
// Every name, identity, class, course, photo reference and observation below is synthetic.
const container = process.env.XUEDU_LOCAL_PG_CONTAINER;
const pgtest = container ? test : test.skip;
const literal = (value: unknown) => "'" + String(value).replace(/'/g, "''") + "'";
const json = (value: unknown) => literal(JSON.stringify(value)) + '::jsonb';
const raw = (sql: string) => execFileSync('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
  {input: sql, encoding: 'utf8', maxBuffer: 32_000_000}).trim();
const server = `SET ROLE service_role; SET request.jwt.claims='{"role":"service_role"}'; `;
const calls: string[] = [];
const db = {async rpc(name: string, args: Record<string, unknown>) {
  calls.push(name);
  const values = name === 'xuedu_v2_workspace' ? ''
    : name === 'xuedu_v2_bootstrap_page' ? [literal(args.p_identity_key), json(args.p_request), args.p_can_initialize ? 'true' : 'false'].join(',')
    : name === 'xuedu_v2_scheduling_read' || name === 'xuedu_v2_record_read' ? [literal(args.p_identity_key), json(args.p_request)].join(',')
    : [literal(args.p_resource), json(args.p_query)].join(',');
  try { return {data: JSON.parse(raw(server + `SELECT public.${name}(${values});`)) as unknown, error: null}; }
  catch (error) { return {data: null, error: {message: String((error as {stderr?: unknown}).stderr)}}; }
}};
const api = createGatewayV2({repository: new PostgresRepository(db), appid: 'synthetic-app', bootstrapOpenid: '',
  uuid: () => {throw new Error('Capacity probes must not write');}, maxExecutionMs: 3000,
  photos: {async upload() {throw new Error('Capacity probes must not upload');}, async urls() {throw new Error('No photo reads');},
    async list() {return [];}, async delete() {throw new Error('Capacity probes must not delete');}}});
const roles = ['admin', 'leader', 'officer', 'member'] as const;
const people = 35, weeks = 18, generations = 25;
let syntheticStartDate = '';
const memberId = (index: number) => 'person-' + String(index).padStart(2, '0');
const who = (role: typeof roles[number]) => memberId(roles.indexOf(role));
const BYTE_BUDGET = 768 * 1024; // Reserve at least 25% of the observed 1 MiB transport ceiling.
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify({ok: true, data: value}), 'utf8');
interface Measurement {key: string; bytes: number; calls: number; localWallMs: number;}
const measured: Measurement[] = [];
const baseline = new Map<string, Measurement>();
const bootRequest = (view: string, fast = true, week = 8, semesterId = 'synthetic-current'): ApiRequest => ({
  protocolVersion: 2, operation: 'bootstrap', epoch: 'synthetic-epoch',
  payload: {fastPage: fast, ...(view === 'home' ? {includeHome: true} : {page: {view, week, semesterId}})},
});
async function measure(key: string, request: ApiRequest, role: typeof roles[number] = 'admin') {
  calls.length = 0; const started = performance.now();
  const response = await api(request, {OPENID: 'synthetic-wx-' + who(role), APPID: 'synthetic-app'});
  const row = {key, bytes: byteLength(response), calls: calls.length, localWallMs: Math.round(performance.now() - started)};
  measured.push(row);
  assert.ok(row.bytes < BYTE_BUDGET, `${key}: ${row.bytes} bytes exceeds ${BYTE_BUDGET}-byte release budget`);
  assert.doesNotMatch(JSON.stringify(response), /synthetic-wx-|identityKey|base64/);
  return {response, row};
}
function insert(resource: Resource, rows: Entity[]) {
  if (!rows.length) return;
  const columns = ['id', 'epoch', 'version', 'data', 'semester_id', 'week', 'member_id', 'task_id', 'parent_id', 'identity_key', 'date'];
  const values = rows.map(row => '(' + [literal(row.id), literal(row.epoch), String(row.version), json(row.data),
    row.semesterId ? literal(row.semesterId) : 'NULL', row.week === undefined ? 'NULL' : String(row.week),
    row.memberId ? literal(row.memberId) : 'NULL', row.taskId ? literal(row.taskId) : 'NULL',
    row.parentId ? literal(row.parentId) : 'NULL', row.identityKey ? literal(row.identityKey) : 'NULL', row.date ? literal(row.date) : 'NULL'].join(',') + ')');
  raw(`INSERT INTO xuedu_v2.${resource}(${columns.join(',')}) VALUES ${values.join(',')};`);
}
const entity = (id: string, data: Record<string, unknown>, extra: Partial<Entity> = {}): Entity => ({id, epoch: 'synthetic-epoch', version: 1, data, ...extra});
function task(week: number, index: number, status = 'submitted', plan = `formal-${week}`): Entity {
  const classIndex = (index + 1) % people;
  const klass = {id: 'class-' + classIndex, name: '25合成专业' + (classIndex + 1) + '班', major: '合成专业', grade: '25'};
  const options: TaskCourseOption[] = Array.from({length: 5}, (_, option) => ({
    occurrenceId: `option-${week}-${classIndex}-${option}`, occurrenceVersion: 1,
    course: {id: `course-${classIndex}-${option}`, semesterId: 'synthetic-current', name: '合成课程数据结构与算法分析' + option, teacher: '合成教师',
      classroom: '合成教学楼-0404', nature: '专业必修课', classIds: [klass.id], weekday: option + 1, start: 3, end: 4, weeks: [week], expected: 60},
    classes: [klass], classLabel: klass.name,
    date: new Date(Date.parse(syntheticStartDate + 'T00:00:00Z') + ((week - 1) * 7 + option) * 86400000).toISOString().slice(0, 10),
  }));
  return entity(`task-${plan}-${index}`, {...options[0], courseOptions: options, status},
    {semesterId: 'synthetic-current', week, memberId: memberId(index), parentId: plan});
}
const metrics: Metrics = {expected: 60, actual: 58, late: 1, early: 0, sleep: 0, phone: 1, talk: 0, other: 0};

pgtest('capacity: seed 35 synthetic people, 18 weeks, five course options per weekly task', () => {
  raw(`INSERT INTO xuedu_v2.workspace(id,epoch,version,permissions_version,active_semester_id,max_execution_ms)
    VALUES('main','synthetic-epoch',1,1,'synthetic-current',3000);`);
  const startDate = raw(`SELECT ((current_timestamp AT TIME ZONE 'Asia/Shanghai')::date-extract(isodow FROM current_timestamp AT TIME ZONE 'Asia/Shanghai')::integer+1-49)::text;`);
  syntheticStartDate = startDate;
  insert('semesters', [entity('synthetic-current', {name: '合成完整学期', weeks, startDate, days: 7, periods: 14, grades: ['25'], edition: '模拟届'}),
    entity('synthetic-past', {name: '合成历史学期', weeks, startDate: '2020-09-07', days: 7, periods: 14})]);
  insert('classes', Array.from({length: people}, (_, index) => entity('class-' + index,
    {name: '25合成专业' + (index + 1) + '班', major: '合成专业', grade: '25', active: true, expectedCount: 60})));
  insert('members', Array.from({length: people}, (_, index) => entity(memberId(index),
    {name: '合成成员' + index, studentNo: 'synthetic-number-' + index, classId: 'class-' + index, role: roles[index] || 'member', active: true})));
  insert('bindings', Array.from({length: people}, (_, index) => entity('binding-' + index, {},
    {memberId: memberId(index), identityKey: 'synthetic-wx-' + memberId(index)})));
  insert('semester_classes', Array.from({length: people}, (_, index) => entity('link-' + index, {}, {semesterId: 'synthetic-current', parentId: 'class-' + index})));
  const courses: Entity[] = [], occurrences: Entity[] = [], tasks: Entity[] = [], records: Entity[] = [], availability: Entity[] = [], plans: Entity[] = [];
  for (let week = 1; week <= weeks; week++) {
    plans.push(entity(`formal-${week}`, {status: 'confirmed', uncovered: []}, {semesterId: 'synthetic-current', week}));
    for (let index = 0; index < people; index++) {
      const row = task(week, index); tasks.push(row);
      const first = row.data.courseOptions as TaskCourseOption[];
      for (const option of first) {
        occurrences.push(entity(option.occurrenceId, {...option, status: 'active'}, {semesterId: 'synthetic-current', week, date: option.date}));
        if (week === 1) courses.push(entity(String(option.course.id), {course: option.course}, {semesterId: 'synthetic-current'}));
      }
      availability.push(entity(`availability-${week}-${index}`, {slots: ['1:3', '1:4', '2:3', '2:4'], optedIn: true},
        {semesterId: 'synthetic-current', week, memberId: memberId(index)}));
      records.push(entity(`record-${week}-${index}`, {...first[0], metrics, photos: [`synthetic-private-photo-${week}-${index}`],
        firstSubmittedAt: '2026-10-20T00:00:00Z', absentNames: '合成缺勤名单', leaveNames: '合成请假名单',
        otherDescription: '合成其他情况', evaluation: '合成班风评价', feedback: '合成异常反馈', suggestion: '合成教师建议'},
        {semesterId: 'synthetic-current', week, memberId: memberId(index), taskId: row.id}));
    }
  }
  // A current draft can coexist with already submitted formal tasks; viewing must retain both.
  plans.push(entity('current-draft-9', {status: 'draft', uncovered: []}, {semesterId: 'synthetic-current', week: 9}));
  tasks.push(...Array.from({length: people}, (_, index) => task(9, index, 'draft', 'current-draft-9')));
  insert('courses', courses); insert('occurrences', occurrences); insert('plans', plans);
  insert('tasks', tasks); insert('records', records); insert('availability', availability);
  insert('plans', [entity('past-plan', {status: 'confirmed'}, {semesterId: 'synthetic-past', week: 8})]);
  insert('tasks', [entity('past-task', {status: 'confirmed', classLabel: '历史学期独立班级'},
    {semesterId: 'synthetic-past', week: 8, memberId: who('member'), parentId: 'past-plan'})]);
  raw('ANALYZE;');
  assert.equal(Number(raw('SELECT count(*) FROM xuedu_v2.members')), people);
  assert.equal(Number(raw('SELECT count(*) FROM xuedu_v2.records')), people * weeks);
});

const genericRequests: [string, ApiRequest][] = [
  ['fallback/home', bootRequest('home', false)], ['fallback/schedule', bootRequest('schedule', false, 9)],
  ['fallback/records', bootRequest('records', false, 9)],
  ...['week', 'submissionStatus', 'summaryReport', 'scheduleReport', 'excelReport'].map(kind => [
    `query/${kind}`, {protocolVersion: 2, operation: 'query', epoch: 'synthetic-epoch', semesterId: 'synthetic-current', payload: {kind, week: 9}},
  ] as [string, ApiRequest]),
];
pgtest('capacity: measure baseline page and generic query results before old drafts accumulate', async () => {
  for (const [key, request] of genericRequests) {
    const {row} = await measure(key, request); baseline.set(key, row);
  }
  for (const role of roles) for (const view of ['home', 'schedule', 'records', 'profile', 'availability', 'courses']) {
    const key = `fast/${role}/${view}`, {row} = await measure(key, bootRequest(view, true, 9), role);
    baseline.set(key, row);
  }
});

pgtest('capacity: 25 superseded generations per week stay stored but never inflate page or report responses', async () => {
  for (let week = 1; week <= weeks; week++) {
    const plans: Entity[] = [], tasks: Entity[] = [];
    for (let generation = 0; generation < generations; generation++) {
      const planId = `history-${week}-${generation}`;
      plans.push(entity(planId, {status: 'superseded', uncovered: []}, {semesterId: 'synthetic-current', week}));
      tasks.push(...Array.from({length: people}, (_, index) => task(week, index, 'superseded', planId)));
    }
    insert('plans', plans); insert('tasks', tasks);
  }
  raw('ANALYZE xuedu_v2.tasks; ANALYZE xuedu_v2.plans;');
  const oldBytes = Number(raw(`SELECT octet_length(jsonb_agg(xuedu_v2.entity(to_jsonb(t)))::text)
    FROM xuedu_v2.tasks t WHERE semester_id='synthetic-current' AND week=9 AND data->>'status'='superseded';`));
  assert.ok(oldBytes > 1_048_576, 'Fixture must reproduce the original over-1-MiB failure pressure');
  assert.equal(Number(raw(`SELECT count(*) FROM xuedu_v2.tasks WHERE data->>'status'='superseded';`)), people * weeks * generations);
  for (const [key, request] of genericRequests) {
    const {row} = await measure(key, request), before = baseline.get(key)!;
    assert.equal(row.bytes, before.bytes, key + ' response grew with superseded history');
    assert.equal(row.calls, before.calls, key + ' database requests grew with superseded history');
  }
  for (const role of roles) for (const view of ['home', 'schedule', 'records', 'profile', 'availability', 'courses']) {
    const key = `fast/${role}/${view}`, {response, row} = await measure(key, bootRequest(view, true, 9), role);
    assert.equal(row.bytes, baseline.get(key)!.bytes, key + ' response grew with history');
    assert.equal(row.calls, baseline.get(key)!.calls, key + ' request count grew with history');
    const page = response.data.page as PageData | undefined;
    if (view === 'schedule') {
      const tasks = page!.weekData!.tasks;
      assert.equal(tasks.length, ['admin', 'leader'].includes(role) ? people * 2 : 2);
      assert.ok(tasks.every(task => task.week === 9 && task.semesterId === 'synthetic-current'));
      assert.ok(tasks.every(task => task.data.status !== 'superseded'));
      if (!['admin', 'leader'].includes(role)) assert.ok(tasks.every(task => task.memberId === who(role)));
      assert.ok(tasks.every(task => Array.isArray(task.data.courseOptions) && task.data.courseOptions.length === 5));
    }
  }
  console.log('CAPACITY_FIXTURE', JSON.stringify({people, weeks, optionsPerTask: 5, supersededGenerationsPerWeek: generations,
    supersededTasks: people * weeks * generations, supersededWeek9JsonBytes: oldBytes, responseBudgetBytes: BYTE_BUDGET}));
  console.log('CAPACITY_RESULTS', JSON.stringify(measured.slice(baseline.size)));
});

pgtest('capacity: week and semester selections stay isolated; warm SQL timing excludes network and cloud runtime', async () => {
  const past = (await measure('isolation/past', bootRequest('schedule', true, 8, 'synthetic-past'), 'member')).response.data.page as PageData;
  assert.deepEqual(past.weekData!.tasks.map(task => task.id), ['past-task']);
  const current = (await measure('isolation/week8', bootRequest('schedule', true, 8), 'member')).response.data.page as PageData;
  assert.equal(current.weekData!.tasks.length, 1); assert.equal(current.weekData!.tasks[0].week, 8);
  const next = (await measure('isolation/week9', bootRequest('schedule', true, 9), 'member')).response.data.page as PageData;
  assert.equal(next.weekData!.tasks.length, 2); assert.ok(next.weekData!.tasks.every(task => task.week === 9));
  const timings: Record<string, number> = {};
  for (const view of ['home', 'schedule', 'records', 'profile', 'availability', 'courses']) {
    const payload = bootRequest(view, true, 9).payload!;
    timings[view] = Number(raw(server + `DO $$ DECLARE started timestamptz:=clock_timestamp(); BEGIN
      FOR i IN 1..20 LOOP PERFORM public.xuedu_v2_bootstrap_page('synthetic-wx-person-00',${json(payload)},false); END LOOP;
      PERFORM set_config('xuedu.capacity_ms',(extract(epoch FROM clock_timestamp()-started)*1000/20)::text,false);
      END $$; SELECT current_setting('xuedu.capacity_ms');`));
    assert.ok(Number.isFinite(timings[view]));
  }
  console.log('CAPACITY_WARM_SQL_MEAN_MS', JSON.stringify(timings));
});

pgtest('capacity: 100 regenerated drafts cannot fill the scheduling RPC; cancellation and effective tasks remain visible', async () => {
  const plans: Entity[] = [], tasks: Entity[] = [];
  for (let generation = generations; generation < 100; generation++) {
    const planId = `history-9-${generation}`;
    plans.push(entity(planId, {status: 'superseded'}, {semesterId: 'synthetic-current', week: 9}));
    tasks.push(...Array.from({length: people}, (_, index) => task(9, index, 'superseded', planId)));
  }
  insert('plans', plans); insert('tasks', tasks);
  raw(`UPDATE xuedu_v2.tasks SET data=data || '{"status":"pendingAdjustment"}' WHERE id='task-formal-9-1';
    UPDATE xuedu_v2.tasks SET data=data || '{"cancel":true,"replacesTaskId":"task-formal-9-1"}' WHERE id='task-current-draft-9-1';`);
  const historicalBytes = Number(raw(`SELECT octet_length(jsonb_agg(xuedu_v2.entity(to_jsonb(t)))::text)
    FROM xuedu_v2.tasks t WHERE semester_id='synthetic-current' AND week=9 AND data->>'status'='superseded';`));
  assert.ok(historicalBytes > 8_000_000, 'Fixture must exceed the prior internal scheduling RPC limit');
  const resultSizes: Record<string, number> = {};
  for (const kind of ['planGenerate', 'taskAdjust', 'planConfirm', 'scheduleReport']) {
    const response = await db.rpc('xuedu_v2_scheduling_read', {p_identity_key: 'synthetic-wx-person-00', p_request: {
      kind, epoch: 'synthetic-epoch', semesterId: 'synthetic-current', week: 9, id: 'current-draft-9', requestId: 'synthetic-unused-request',
    }});
    assert.equal(response.error, null, kind);
    const result = response.data as {rows: {tasks: Entity[]; plans: Entity[]}};
    assert.equal(result.rows.tasks.length, people * 2);
    assert.equal(result.rows.plans.length, 2);
    assert.ok(result.rows.tasks.every(task => ['submitted', 'pendingAdjustment', 'draft'].includes(String(task.data.status))));
    assert.equal(result.rows.tasks.find(task => task.id === 'task-current-draft-9-1')!.data.cancel, true);
    assert.equal(result.rows.tasks.find(task => task.id === 'task-formal-9-1')!.data.status, 'pendingAdjustment');
    resultSizes[kind] = byteLength(result);
    assert.ok(resultSizes[kind] < BYTE_BUDGET);
  }
  console.log('CAPACITY_SCHEDULING_100_GENERATIONS', JSON.stringify({historicalBytes, readSetBytes: resultSizes}));
});

pgtest('capacity: legal maximum Chinese observations paginate completely without exceeding the response budget', async () => {
  const fields = ['absentNames', 'leaveNames', 'otherDescription', 'evaluation', 'feedback', 'suggestion'];
  const patch = Object.fromEntries(fields.map(field => [field, '测'.repeat(5000)]));
  raw(`UPDATE xuedu_v2.records SET data=data || ${json(patch)} WHERE semester_id='synthetic-current' AND week=9;`);
  const maxRecordBytes = Number(raw(`SELECT max(octet_length(data::text)) FROM xuedu_v2.records WHERE week=9;`));
  assert.ok(maxRecordBytes > 90_000 && maxRecordBytes < 131_072);
  const results: {path: string; pages: number; records: number; maxResponseBytes: number}[] = [];
  for (const path of ['fast/admin', 'fast/leader', 'fast/officer', 'fast/member', 'fallback/admin', 'query/admin']) {
    const [route, roleText] = path.split('/');
    const role = roleText as typeof roles[number];
    let cursor = '', pages = 0, maximum = 0;
    const ids = new Set<string>();
    do {
      const request: ApiRequest = route === 'query'
        ? {protocolVersion: 2, operation: 'query', epoch: 'synthetic-epoch', semesterId: 'synthetic-current', cursor, limit: 100,
          payload: {kind: 'records', week: 9}}
        : {...bootRequest('records', route === 'fast', 9), payload: {fastPage: route === 'fast', page: {
          view: 'records', week: 9, semesterId: 'synthetic-current', cursor, more: pages > 0, selectionOwner: who(role),
        }}};
      const {response, row} = await measure(`long-observations/${path}/${pages}`, request, role);
      maximum = Math.max(maximum, row.bytes);
      const list = route === 'query' ? {items: response.data.items as Entity[], cursor: response.cursor || ''}
        : (response.data.page as PageData).list as PageResult;
      assert.ok(list.items.length > 0 && list.items.length < 35, 'Whole records must be split into multiple pages');
      for (const record of list.items) {
        assert.ok(!ids.has(record.id), 'Pagination duplicated a record'); ids.add(record.id);
        assert.equal(record.week, 9); assert.equal(record.semesterId, 'synthetic-current');
        for (const field of fields) assert.equal(record.data[field], patch[field], field + ' was truncated');
        if (role === 'member' && record.memberId !== who(role)) assert.equal(record.data.photos, undefined);
      }
      if (list.cursor) assert.equal(list.cursor, list.items.at(-1)!.id);
      cursor = list.cursor; pages++;
      assert.ok(pages < 40, 'Cursor did not make progress');
    } while (cursor);
    assert.equal(ids.size, people, path + ' did not deliver every record');
    results.push({path, pages, records: ids.size, maxResponseBytes: maximum});
  }
  const week = (await measure('long-observations/legacy-week', {protocolVersion: 2, operation: 'query', epoch: 'synthetic-epoch',
    semesterId: 'synthetic-current', payload: {kind: 'week', week: 9}})).response;
  const links = week.data.records as Entity[];
  assert.equal(links.length, people);
  assert.ok(links.every(record => record.week === 9 && record.semesterId === 'synthetic-current'));
  for (const record of links) {
    assert.ok(record.taskId && record.memberId);
    assert.equal(typeof record.data.classLabel, 'string');
    for (const field of [...fields, 'photos']) assert.equal(record.data[field], undefined);
  }
  console.log('CAPACITY_MAXIMUM_OBSERVATIONS', JSON.stringify({maxRecordBytes, fields: 6, charactersPerField: 5000, results}));
});

pgtest('capacity: bounded-read migration replays without changing stored history or opening client grants', () => {
  const fingerprint = () => raw(`SELECT md5(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM xuedu_v2.tasks t),
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM xuedu_v2.plans p),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM xuedu_v2.records r))::text);`);
  const before = fingerprint();
  raw(readFileSync('server/migrations/013-bounded-read-pages.sql', 'utf8'));
  assert.equal(fingerprint(), before);
  for (const signature of ['public.xuedu_v2_query(text,jsonb)', 'public.xuedu_v2_scheduling_read(text,jsonb)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(raw(`SELECT has_function_privilege(${literal(role)},${literal(signature)},'EXECUTE');`), 'f');
    assert.equal(raw(`SELECT has_function_privilege('service_role',${literal(signature)},'EXECUTE');`), 't');
  }
});

pgtest('capacity: long-observation Excel and names exports deliver all pages under one live version', async () => {
  const results: {kind: string; role: string; pages: number; records: number; maxResponseBytes: number}[] = [];
  for (const kind of ['excelReport', 'namesReport']) for (const role of ['admin', 'officer'] as const) {
    let cursor = '', version: number | undefined, pages = 0, maximum = 0;
    const ids = new Set<string>();
    do {
      const request: ApiRequest = {protocolVersion: 2, operation: 'query', epoch: 'synthetic-epoch', semesterId: 'synthetic-current',
        cursor, payload: {kind, week: 9, paged: true, ...(version === undefined ? {} : {reportVersion: version})}};
      const {response, row} = await measure(`long-export/${kind}/${role}/${pages}`, request, role);
      assert.equal(response.data.reportPage, true); maximum = Math.max(maximum, row.bytes);
      if (version === undefined) {
        version = Number(response.data.version);
        const metadata = response.data.metadata as {records: unknown[]; activeSemesterId: string};
        assert.equal(metadata.activeSemesterId, 'synthetic-current'); assert.deepEqual(metadata.records, []);
      } else {assert.equal(response.data.version, version); assert.equal(response.data.metadata, undefined);}
      const records = response.data.records as {id: string; semesterId: string; week: number; suggestion: string}[];
      for (const record of records) {
        assert.ok(!ids.has(record.id)); ids.add(record.id);
        assert.equal(record.week, 9); assert.equal(record.semesterId, 'synthetic-current');
        assert.equal(record.suggestion, '测'.repeat(5000));
      }
      cursor = response.cursor || ''; pages++; assert.ok(pages < 40);
    } while (cursor);
    assert.equal(ids.size, people); results.push({kind, role, pages, records: ids.size, maxResponseBytes: maximum});
  }
  const input: ApiRequest = {protocolVersion: 2, operation: 'query', epoch: 'synthetic-epoch', semesterId: 'synthetic-current',
    payload: {kind: 'excelReport', week: 9}};
  await assert.rejects(api(input, {OPENID: 'synthetic-wx-person-00', APPID: 'synthetic-app'}),
    (error: unknown) => (error as {code?: string}).code === 'RESPONSE_TOO_LARGE');
  const first = await api({...input, payload: {...input.payload, paged: true}}, {OPENID: 'synthetic-wx-person-00', APPID: 'synthetic-app'});
  raw('UPDATE xuedu_v2.workspace SET version=2 WHERE id=\'main\';');
  try {
    await assert.rejects(api({...input, cursor: first.cursor, payload: {...input.payload, paged: true, reportVersion: first.data.version}},
      {OPENID: 'synthetic-wx-person-00', APPID: 'synthetic-app'}), (error: unknown) => (error as {code?: string}).code === 'VERSION_CONFLICT');
  } finally {raw('UPDATE xuedu_v2.workspace SET version=1 WHERE id=\'main\';');}
  for (const role of ['leader', 'member'] as const) await assert.rejects(api({...input, payload: {...input.payload, paged: true}},
    {OPENID: 'synthetic-wx-' + who(role), APPID: 'synthetic-app'}), (error: unknown) => (error as {code?: string}).code === 'FORBIDDEN');
  console.log('CAPACITY_MAXIMUM_EXPORTS', JSON.stringify(results));
});
