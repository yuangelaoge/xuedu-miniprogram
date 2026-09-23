import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCutoverPlan, verifyCutover, writeCutoverMaterials, TARGET } from '../scripts/v2-cutover.mjs';
import { RESOURCES } from '../miniprogram/domain/v2/protocol';

function source(): any {
  return { ...TARGET, revision: 12, document: { stage: 'trial', epoch: 'old-epoch', version: 9, receipts: [], files: [{ id: 'old-photo' }], state: {
    members: [
      { id: 'a1', name: '合成甲', studentNo: 'synthetic-1', identityKey: 'synthetic-wechat-1', role: 'admin', active: true, classId: 'c1' },
      { id: 'a2', name: '合成乙', studentNo: 'synthetic-2', identityKey: 'synthetic-wechat-2', role: 'admin', active: false, classId: 'c1', removedAt: '2025-01-01' },
      { id: 'a3', name: '合成丙', studentNo: 'synthetic-3', identityKey: 'synthetic-wechat-3', role: 'admin', active: true, classId: 'c2' },
      { id: 'm1', role: 'leader', active: true },
    ], classes: [
      { id: 'c1', name: '合成班1', grade: '25', major: '合成专业', active: false },
      { id: 'c2', name: '合成班2', grade: '26', major: '合成专业' },
      { id: 'c3', name: '合成班3', grade: '24', major: '合成专业' },
    ], semesters: [{ id: 's1' }], courses: [], applications: [], availability: [], plans: [], drafts: [], records: [], audit: [],
  } } };
}
const options = { epoch: 'new-epoch', maxExecutionMs: 3000 };
function imported(plan: any) {
  return { target: structuredClone(plan.target), workspace: structuredClone(plan.workspace),
    resources: Object.fromEntries(RESOURCES.map(key => [key, structuredClone(plan.retained[key] || [])])) };
}

test('V2切换保留所有管理员原状态、稳定ID、微信绑定及去重班级完整资料', () => {
  const input = source(), before = structuredClone(input), plan = createCutoverPlan(input, options);
  assert.deepEqual(input, before);
  assert.equal(plan.retained.members.length, 3); assert.equal(plan.retained.classes.length, 2);
  assert.equal(plan.retained.members[1].data.active, false);
  assert.equal(plan.retained.members[1].data.removedAt, '2025-01-01');
  assert.equal(plan.retained.members[1].data.classId, 'c1');
  assert.equal(plan.retained.classes[0].data.active, false);
  assert.equal(plan.retained.bindings[1].identityKey, 'synthetic-wechat-2');
  assert.equal(plan.retained.bindings[1].data.active, false);
  assert.equal(plan.retained.members[0].data.identityKey, undefined);
  assert.equal(plan.workspace.activeSemesterId, ''); assert.equal(plan.workspace.maintenance, plan.id);
  assert.equal(plan.summary.deletedClasses, 1); assert.equal(plan.destructiveActionsAuthorized, false);
  assert.equal(plan.photoPolicy.deleteAutomatically, false);
});

test('V2切换拒绝无有效管理员、缺班级、伪匿名快照、重复身份或学号', () => {
  for (const [mutate, code] of [
    [(v: any) => v.document.state.members.forEach((m: any) => m.active = false), 'NO_ACTIVE_ADMINISTRATOR'],
    [(v: any) => v.document.state.classes.shift(), 'MISSING_ADMINISTRATOR_CLASS'],
    [(v: any) => v.document.state.members[0].identityKey = 'self', 'INVALID_ADMINISTRATOR'],
    [(v: any) => v.document.state.members[1].identityKey = v.document.state.members[0].identityKey, 'DUPLICATE_ADMIN_BINDING'],
    [(v: any) => v.document.state.members[1].studentNo = v.document.state.members[0].studentNo, 'DUPLICATE_ADMIN_STUDENT_NUMBER'],
  ] as const) {
    const input = source(); mutate(input); assert.throws(() => createCutoverPlan(input, options), new RegExp(code));
  }
});

test('V2切换发现任一种未完成旧清理立即停止，不自动解冻或恢复', () => {
  for (const key of ['cleaning', 'resetAll', 'businessClear']) {
    const input = source(); input.document[key] = key === 'cleaning' ? true : { id: 'unfinished' };
    const before = structuredClone(input);
    assert.throws(() => createCutoverPlan(input, options), /UNFINISHED_LEGACY_MAINTENANCE/);
    assert.deepEqual(input, before);
  }
});

test('V2切换验证环境、独立新轮次及明确的函数执行上限', () => {
  const input = source(); input.environmentId = 'another';
  assert.throws(() => createCutoverPlan(input, options), /TARGET_MISMATCH/);
  assert.throws(() => createCutoverPlan(source(), { ...options, epoch: 'old-epoch' }), /INVALID_NEW_EPOCH/);
  for (const maxExecutionMs of [undefined, 0, 999, 900001, 1.1]) {
    assert.throws(() => createCutoverPlan(source(), { ...options, maxExecutionMs }), /INVALID_EXECUTION_LIMIT/);
  }
});

test('V2离线核对需要完整资源导出且逐字段校验管理员和班级', () => {
  const input = source(), plan = createCutoverPlan(input, options), dump = imported(plan);
  assert.equal(verifyCutover(plan, input, dump).verified, true);
  dump.resources.members[0].data.classId = 'c2';
  assert.throws(() => verifyCutover(plan, input, dump), /RETAINED_RESOURCE_MISMATCH/);
  const extra = imported(plan); extra.resources.records.push({ id: 'unexpected' });
  assert.throws(() => verifyCutover(plan, input, extra), /UNEXPECTED_OR_MISSING_RESOURCE/);
  const omitted = imported(plan); delete omitted.resources.records;
  assert.throws(() => verifyCutover(plan, input, omitted), /UNEXPECTED_OR_MISSING_RESOURCE/);
});

test('V2独立核对拒绝变更过的源revision、计划哈希和提前开放的工作区', () => {
  const input = source(), plan = createCutoverPlan(input, options), dump = imported(plan);
  const changed = structuredClone(input); changed.revision++;
  assert.throws(() => verifyCutover(plan, changed, dump), /SOURCE_OR_PLAN_CHANGED/);
  const altered = structuredClone(plan); altered.retained.members[0].data.active = false;
  assert.throws(() => verifyCutover(altered, input, dump), /PLAN_HASH_MISMATCH/);
  dump.workspace.maintenance = '';
  assert.throws(() => verifyCutover(plan, input, dump), /WORKSPACE_MISMATCH/);
});

test('V2恢复材料仅创建于仓库外，目录0700文件0600，不覆盖已有材料', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'xuedu-v2-cutover-test-'));
  try {
    const inputFile = join(temporary, 'source.json'), output = join(temporary, 'materials');
    const original = JSON.stringify(source(), null, 3); writeFileSync(inputFile, original);
    const summary = writeCutoverMaterials(inputFile, output, options);
    assert.equal(summary.administrators, 3); assert.equal(statSync(output).mode & 0o777, 0o700);
    for (const filename of ['legacy-recovery.json', 'retention-plan.json', 'checksums.json'])
      assert.equal(statSync(join(output, filename)).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(output, 'legacy-recovery.json'), 'utf8'), original);
    assert.throws(() => writeCutoverMaterials(inputFile, output, options));
    const fakeRepo = join(temporary, 'repo'); mkdirSync(fakeRepo); mkdirSync(join(fakeRepo, '.git'));
    assert.throws(() => writeCutoverMaterials(inputFile, join(fakeRepo, 'material'), options), /OUTSIDE_REPOSITORY/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('V2 CLI成功和失败日志不打印姓名、学号、微信标识或输入片段', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'xuedu-v2-cutover-cli-'));
  try {
    const inputFile = join(temporary, 'source.json'), output = join(temporary, 'materials');
    writeFileSync(inputFile, JSON.stringify(source()));
    const cli = resolve('scripts/v2-cutover.mjs');
    const success = spawnSync(process.execPath, [cli, 'plan', inputFile, output, '3000'], { encoding: 'utf8' });
    assert.equal(success.status, 0); assert.doesNotMatch(success.stdout + success.stderr, /合成|synthetic/);
    writeFileSync(inputFile, 'invalid-private-wechat-synthetic-input');
    const failure = spawnSync(process.execPath, [cli, 'plan', inputFile, output, '3000'], { encoding: 'utf8' });
    assert.equal(failure.status, 1); assert.doesNotMatch(failure.stdout + failure.stderr, /private|wechat|synthetic/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
