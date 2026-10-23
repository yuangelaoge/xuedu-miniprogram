import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from '../miniprogram/config/runtime';
import {AppState, Observation} from '../miniprogram/domain/types';
import {ApiRequest, ApiResponse, Entity} from '../miniprogram/domain/v2/protocol';
import {exportTxt, exportXlsx, reportSheets} from '../miniprogram/domain/reports';
import {bootstrap, leaveReviewLocally} from '../miniprogram/services/v2/client';
import {loadReportState} from '../miniprogram/services/v2/report-loader';
import {MemoryRepository} from '../server/v2/memory';
import {createGatewayV2} from '../server/v2/gateway';
import {optionNow, optionSeed} from './helpers/course-options';
import {reviewIdentity} from '../server/v2/review-seed';

type Role = 'admin' | 'officer' | 'leader' | 'member';
function fixture(count = 65, longText = false) {
  const seed = optionSeed();
  const original = seed.rows.records![0], sourceTask = seed.rows.tasks!.find(task => task.id === original.taskId)!;
  const sourcePhoto = seed.rows.photos![0];
  const target: Entity[] = Array.from({length: count}, (_, index) => {
    const id = 'record-' + String(index).padStart(4, '0');
    const classes = structuredClone(original.data.classes) as {id:string;name:string;grade:string;major:string}[];
    if (index === count - 1) { classes[0].name = '28合成历史班级'; classes[0].grade = '28'; }
    return {...structuredClone(original), id, week: 2, taskId: 'task-' + id, date: '2026-10-26', data: {...structuredClone(original.data),
      date: '2026-10-26', classLabel: classes.map(klass => klass.name).join('/'), classes, photos: ['photo-' + id],
      metrics: {...(original.data.metrics as Record<string, number>), actual: 20 + index % 10},
      ...(longText ? Object.fromEntries(['absentNames', 'leaveNames', 'otherDescription', 'evaluation', 'feedback', 'suggestion'].map(key => [key, '合'.repeat(5000)])) : {}),
    }};
  });
  seed.rows.records!.push(...target);
  seed.rows.plans!.push({...structuredClone(seed.rows.plans![0]), id: 'plan-week-2', week: 2});
  seed.rows.tasks!.push(...target.map(record => ({...structuredClone(sourceTask), id: record.taskId!, week: 2, parentId: 'plan-week-2',
    data: {...structuredClone(sourceTask.data), courseOptions: [{occurrenceId: 'synthetic-option', course: sourceTask.data.course}], date: '2026-10-26'}})));
  seed.rows.photos!.push(...target.map(record => ({...structuredClone(sourcePhoto), id: 'photo-' + record.id, week: 2, taskId: record.taskId, recordId: record.id})));
  const repository = new MemoryRepository(seed.workspace, seed.rows, () => optionNow);
  let serial = 0;
  const gateway = createGatewayV2({repository, appid: 'app', bootstrapOpenid: 'unused', maxExecutionMs: 3000, now: () => optionNow,
    uuid: () => 'report-check-' + ++serial, photos: {async upload(){throw Error('no upload');}, async delete(){throw Error('no deletion');}, async list(){return [];}, async urls(){throw Error('no photo URL retrieval');}}});
  const context = (role: Role) => ({OPENID: reviewIdentity('options', role), APPID: 'app'});
  const call = (payload: Record<string, unknown>, role: Role = 'officer', extra: Partial<ApiRequest> = {}) => gateway({protocolVersion: 2,
    operation: 'query', epoch: seed.workspace.epoch, semesterId: seed.workspace.activeSemesterId, payload, ...extra}, context(role));
  const mutate = async () => {
    const w = await repository.workspace(), record = (await repository.get('records', target[0].id))!;
    return repository.commit({epoch: w.epoch, workspaceVersion: w.version, permissionsVersion: w.permissionsVersion,
      actorId: 'review-admin', identityKey: reviewIdentity('options', 'admin'), requestId: 'concurrent-record-update-' + ++serial,
      reads: [], result: {}, changes: [{resource: 'records', id: record.id, expectedVersion: record.version,
        value: {...record, data: {...record.data, feedback: '其他设备刚核对修改'}}}]});
  };
  return {seed, target, repository, gateway, context, call, mutate};
}
const globals = globalThis as unknown as {wx: unknown};
let environment = 0;
async function withClient<T>(f: ReturnType<typeof fixture>, role: Role, run: (responses: ApiResponse[]) => Promise<T>, afterResponse?: (response: ApiResponse) => Promise<void>) {
  const oldRuntime = {...runtime}, oldWx = globals.wx, responses: ApiResponse[] = [];
  runtime.mode = 'cloud'; runtime.env = 'synthetic-report-pagination-' + ++environment;
  globals.wx = {getStorageSync(){}, removeStorageSync(){}, cloud: {init(){}, async callFunction({data}: {data: ApiRequest}) {
    const result = await f.gateway(data, f.context(role));
    if (data.operation === 'query') {responses.push(result); await afterResponse?.(result);}
    return {result: {ok: true, data: result}};
  }}};
  try {await bootstrap(); return await run(responses);}
  finally {leaveReviewLocally(); globals.wx = oldWx; Object.assign(runtime, oldRuntime);}
}
function normaliseTaskOptions(state: AppState): AppState {
  const value = structuredClone(state);
  for (const plan of value.plans) for (const task of plan.tasks) delete (task as typeof task & {courseOptions?: unknown}).courseOptions;
  return value;
}

test('分页报表真实链路：65条跨分页完整读取，旧/新协议的Excel与TXT完全相同，历史班级名称保留', async () => {
  for (const kind of ['report', 'excelReport', 'namesReport'] as const) for (const role of ['admin', 'officer'] as const) {
    const f = fixture(), legacy = await f.call({kind, week: 2}, role);
    const oldState = legacy.data.state as unknown as AppState;
    await withClient(f, role, async responses => {
      const result = await loadReportState(kind, f.seed.workspace.activeSemesterId, 2), state = result.data.state;
      assert.equal(responses.length, 2);
      assert.equal(state.records.length, 65);
      assert.equal(new Set(state.records.map(record => record.id)).size, 65);
      assert.ok(state.records.every(record => record.week === 2 && record.semesterId === f.seed.workspace.activeSemesterId));
      assert.deepEqual(state, normaliseTaskOptions(oldState));
      assert.deepEqual(reportSheets(state, 2), reportSheets(oldState, 2));
      assert.equal(exportTxt(state, 2), exportTxt(oldState, 2));
      assert.deepEqual(Buffer.from(exportXlsx(state, 2)), Buffer.from(exportXlsx(oldState, 2)));
      assert.ok(state.classes.some(klass => klass.name === '28合成历史班级' && klass.grade === '28'));
      assert.equal((responses[0].data.metadata as AppState).records.length, 0);
      assert.equal(responses[1].data.metadata, undefined);
      assert.equal(responses[1].cursor, '');
    });
  }
});

test('35份合法5000字备注：旧协议明确拒绝超大响应，新协议每包低于900KiB且没有漏字漏记录', async () => {
  const f = fixture(35, true);
  await assert.rejects(f.call({kind: 'excelReport', week: 2}), (error: unknown) => {
    assert.equal((error as {code?: string}).code, 'RESPONSE_TOO_LARGE'); return true;
  });
  await withClient(f, 'officer', async responses => {
    const result = await loadReportState('excelReport', f.seed.workspace.activeSemesterId, 2);
    assert.ok(responses.length > 1);
    assert.ok(responses.every(response => Buffer.byteLength(JSON.stringify({ok: true, data: response})) < 900 * 1024));
    assert.equal(result.data.state.records.length, 35);
    for (const record of result.data.state.records) {
      for (const key of ['absentNames', 'leaveNames', 'otherDescription', 'evaluation', 'feedback', 'suggestion'] as const) assert.equal(record[key], '合'.repeat(5000));
    }
    assert.deepEqual(result.data.state.records.map(record => record.id), f.target.map(record => record.id));
  });
});

test('分页导出期间真实记录更新：后页拒绝旧版本，不返回半份报表；重新开始可完整成功', async () => {
  const f = fixture(); let changed = false;
  await withClient(f, 'officer', async responses => {
    await assert.rejects(loadReportState('report', f.seed.workspace.activeSemesterId, 2), /变化|重新生成/);
    assert.equal(responses.length, 1, 'The continuation must fail at the server.');
    const result = await loadReportState('report', f.seed.workspace.activeSemesterId, 2);
    assert.equal(result.data.state.records.length, 65);
    assert.equal(result.data.state.records[0].feedback, '其他设备刚核对修改');
    assert.equal(result.data.version, 2);
  }, async response => {if (!changed && response.cursor) {changed = true; await f.mutate();}});
});

test('分页服务端每页重新验证权限和版本，缺少版本/非法游标/错误轮次不能续读', async () => {
  const f = fixture();
  const first = await f.call({kind: 'excelReport', week: 2, paged: true});
  assert.ok(first.cursor);
  await assert.rejects(f.call({kind: 'excelReport', week: 2, paged: true}, 'officer', {cursor: first.cursor}), /变化|重新生成/);
  for (const cursor of [123, 'x'.repeat(257)]) await assert.rejects(f.call({kind: 'excelReport', week: 2, paged: true, reportVersion: first.data.version}, 'officer', {cursor: cursor as string}), /范围|无效/);
  await assert.rejects(f.call({kind: 'excelReport', week: 2, paged: true, reportVersion: first.data.version}, 'officer', {cursor: first.cursor, epoch: 'old'}), /范围|变化/);
  for (const role of ['member', 'leader'] as const) for (const kind of ['excelReport', 'namesReport'] as const) {
    await assert.rejects(f.call({kind, week: 2, paged: true, reportVersion: first.data.version}, role, {cursor: first.cursor}), /权限|仅管理员/);
  }
  const w = await f.repository.workspace(), officer = (await f.repository.get('members', 'review-officer'))!;
  await f.repository.commit({epoch: w.epoch, workspaceVersion: w.version, permissionsVersion: w.permissionsVersion,
    actorId: 'review-admin', identityKey: reviewIdentity('options', 'admin'), requestId: 'revoke-officer', reads: [], result: {},
    changes: [{resource: 'members', id: officer.id, expectedVersion: officer.version, value: {...officer, data: {...officer.data, role: 'member'}}}]});
  await assert.rejects(f.call({kind: 'excelReport', week: 2, paged: true, reportVersion: w.version + 1}, 'officer', {cursor: first.cursor}), /权限|仅管理员/);
});

test('空周分页只返回完整空报告；目标周的资料不混入上一周', async () => {
  const f = fixture(0);
  await withClient(f, 'officer', async responses => {
    const result = await loadReportState('namesReport', f.seed.workspace.activeSemesterId, 2);
    assert.equal(result.data.state.records.length, 0);
    assert.equal(responses.length, 1);
    assert.equal(result.cursor, '');
  });
  const original = (await f.call({kind: 'report', week: 1})).data.state as unknown as AppState;
  assert.equal(original.records.length, 1);
  assert.equal((original.records[0] as Observation).week, 1);
});
