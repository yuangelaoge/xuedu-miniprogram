import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {PostgresRepository} from '../server/v2/postgres';
import {Entity, RESOURCES} from '../miniprogram/domain/v2/protocol';
import {AppState} from '../miniprogram/domain/types';
import {taskCourseOptions} from '../miniprogram/domain/v2/task-options';
import {exportXlsx} from '../miniprogram/domain/reports';
import {optionApi, optionMetrics, optionSeed, changed} from './helpers/course-options';

// Real PostgreSQL and application gateway, synthetic identities/data only.
// The photo transport is a deterministic stub, not a test of WeChat/iPhone networking.
const container = process.env.XUEDU_LOCAL_PG_CONTAINER;
const pgtest = container ? test : test.skip;
const literal = (value: unknown) => "'" + String(value).replace(/'/g, "''") + "'";
const json = (value: unknown) => literal(JSON.stringify(value)) + '::jsonb';
const raw = (sql: string) => execFileSync('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'], {
  input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
}).trim();
const db = {async rpc(name: string, args: Record<string, unknown>) {
  const parameters = name === 'xuedu_v2_bootstrap_page' ? [literal(args.p_identity_key), json(args.p_request), args.p_can_initialize ? 'true' : 'false'].join(',')
    : ['xuedu_v2_record_read', 'xuedu_v2_scheduling_read'].includes(name) ? [literal(args.p_identity_key), json(args.p_request)].join(',')
    : name === 'xuedu_v2_workspace' ? '' : name === 'xuedu_v2_commit' ? json(args.p_command) : [literal(args.p_resource), json(args.p_query)].join(',');
  try { return {data: JSON.parse(raw(`SET ROLE service_role; SET request.jwt.claims='{"role":"service_role"}'; SELECT public.${name}(${parameters});`)), error: null}; }
  catch (error) { return {data: null, error: {message: String((error as {stderr?: unknown}).stderr), code: ''}}; }
}};
function seed() {
  const data = optionSeed();
  data.rows.availability = [];
  const sql = [`TRUNCATE ${['workspace', ...RESOURCES].map(name => 'xuedu_v2.' + name).join(',')};`,
    `INSERT INTO xuedu_v2.workspace(id,epoch,version,permissions_version,active_semester_id,max_execution_ms) VALUES('main',${literal(data.workspace.epoch)},1,1,${literal(data.workspace.activeSemesterId)},3000);`];
  for (const [name, rows] of Object.entries(data.rows)) {
    const records = rows.map(row => ({id: row.id, epoch: row.epoch, version: row.version, data: row.data,
      semester_id: row.semesterId, week: row.week, member_id: row.memberId, task_id: row.taskId, record_id: row.recordId,
      parent_id: row.parentId, identity_key: row.identityKey, student_no: row.studentNo, date: row.date, sort_key: row.sortKey}));
    sql.push(`INSERT INTO xuedu_v2.${name} SELECT * FROM jsonb_populate_recordset(NULL::xuedu_v2.${name},${json(records)});`);
  }
  raw(sql.join('\n'));
}

pgtest('完整周流程：保存无课→草稿→确认→文件照片→备选提交/丢响应重试→修改→版本复核和Excel导出', async () => {
  seed();
  const repo = new PostgresRepository(db), api = optionApi(repo);
  const available = await api.call('command', {type: 'availabilitySave', week: 2,
    slots: ['1:1', '1:2', '1:3', '1:4', '1:5', '1:6'], optedIn: true, note: '本地合成流程'}, {who: 'member'});
  const availability = changed(available, row => row.memberId === 'review-member' && Array.isArray(row.data.slots));
  assert.equal(availability.week, 2);
  assert.equal(availability.data.slots instanceof Array && availability.data.slots.length, 6);
  await assert.rejects(api.call('command', {type: 'planGenerate', week: 2}, {who: 'member'}), /无权|FORBIDDEN/);
  await assert.rejects(api.call('command', {type: 'planGenerate', week: 2}, {who: 'leader'}), /无权|FORBIDDEN/);
  const generated = await api.call('command', {type: 'planGenerate', week: 2}, {who: 'officer'});
  const plan = (await repo.get('plans', String(generated.data.planId)))!;
  assert.equal(plan.data.status, 'draft');
  const draft = (await repo.query('tasks', {eq: {parentId: plan.id, memberId: 'review-member'}})).items[0];
  assert.equal(draft.data.status, 'draft');
  assert.equal(taskCourseOptions(draft).length, 3);
  assert.equal((await repo.query('tasks', {eq: {week: 2, status: 'confirmed'}})).items.length, 0, 'Generating a draft cannot publish it.');
  for (const who of ['member', 'leader', 'officer'] as const) await assert.rejects(api.call('command', {type: 'planConfirm', id: plan.id}, {who, expectedVersion: plan.version}), /仅管理员|FORBIDDEN/);
  await api.call('command', {type: 'planConfirm', id: plan.id}, {expectedVersion: plan.version});
  const task = (await repo.get('tasks', draft.id))!;
  assert.equal(task.data.status, 'confirmed');
  const chosen = taskCourseOptions(task).find(option => option.course.id === 'alternate')!;
  assert.ok(chosen);
  const photoPayload = {taskId: task.id, file: 'http://vweixinf.tc.qq.com/301/synthetic', bytes: 5};
  await assert.rejects(api.call('photoFile', photoPayload, {who: 'officer'}), /他人任务|本人/);
  const photo = await api.call('photoFile', photoPayload, {who: 'member', requestId: 'flow-photo'});
  assert.deepEqual((await api.call('photoFile', photoPayload, {who: 'member', requestId: 'flow-photo'})).data, photo.data);
  assert.equal(api.uploads(), 1);
  const photoId = String(photo.data.fileID);
  assert.equal((await repo.query('photos', {eq: {taskId: task.id}})).items.length, 1);

  const commit = repo.commit.bind(repo);
  let loseReply = true;
  repo.commit = async command => {
    const result = await commit(command);
    if (loseReply) { loseReply = false; throw new Error('synthetic reply lost after successful commit'); }
    return result;
  };
  const payload = {type: 'recordSubmitChoice', taskId: task.id, occurrenceId: chosen.occurrenceId,
    metrics: optionMetrics, photos: [photoId], evaluation: '合成课堂评价', absentNames: '无', leaveNames: '无'};
  await assert.rejects(api.call('command', payload, {who: 'member', expectedVersion: task.version, requestId: 'flow-submit'}), /reply lost/);
  const recovered = await api.call('command', payload, {who: 'member', expectedVersion: task.version, requestId: 'flow-submit-retry'});
  repo.commit = commit;
  const record = changed(recovered, row => !!row.data.firstSubmittedAt && !row.recordId);
  assert.deepEqual(record.data.course, chosen.course);
  assert.equal(record.date, chosen.date);
  assert.equal((await repo.query('records', {eq: {taskId: task.id}})).items.length, 1);
  assert.equal((await repo.query('record_versions', {eq: {recordId: record.id}})).items.length, 1);
  assert.equal((await repo.get('tasks', task.id))!.data.status, 'submitted');
  const beforeEdit = await api.call('query', {kind: 'report', format: 'xlsx', week: 2}, {who: 'officer'});
  const edited = await api.call('command', {type: 'recordEdit', id: record.id, metrics: {...optionMetrics, actual: 31},
    photos: [photoId], reason: '合成核对实到人数'}, {who: 'member', expectedVersion: record.version});
  const revised = changed(edited, row => row.id === record.id);
  assert.equal(revised.data.firstSubmittedAt, record.data.firstSubmittedAt);
  assert.equal((revised.data.metrics as Record<string, number>).actual, 31);
  assert.equal((await repo.query('record_versions', {eq: {recordId: record.id}})).items.length, 2);
  await assert.rejects(api.call('query', {kind: 'reportCheck', format: 'xlsx', version: beforeEdit.data.version}, {who: 'officer'}), /变化|重新生成/);
  const afterEdit = await api.call('query', {kind: 'report', format: 'xlsx', week: 2}, {who: 'officer'});
  const state = afterEdit.data.state as unknown as AppState;
  const paged = await api.call('query', {kind: 'excelReport', week: 2, paged: true}, {who: 'officer'});
  assert.equal(paged.data.reportPage, true);
  assert.equal(paged.cursor, '');
  assert.deepEqual(paged.data.records, state.records);
  assert.deepEqual((paged.data.metadata as AppState).records, []);
  assert.equal(paged.data.version, afterEdit.data.version);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].metrics.actual, 31);
  assert.equal(state.records[0].course.id, chosen.course.id);
  const workbook = Buffer.from(exportXlsx(state, 2));
  assert.equal(workbook.readUInt32LE(0), 0x04034b50);
  assert.ok(workbook.includes(Buffer.from('xl/charts/chart')), 'The exported workbook contains editable native Excel charts.');
  assert.equal((await api.call('query', {kind: 'reportCheck', format: 'xlsx', version: afterEdit.data.version}, {who: 'officer'})).data.valid, true);
  await assert.rejects(api.call('query', {kind: 'report', format: 'xlsx', week: 2}, {who: 'member'}), /协作|仅管理员|FORBIDDEN/);
  const photos = (await repo.query('photos', {eq: {taskId: task.id}})).items;
  assert.equal(photos.length, 1);
  assert.equal(photos[0].recordId, record.id);
});
