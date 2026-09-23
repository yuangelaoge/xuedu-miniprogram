import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../miniprogram/config/runtime';
import { registerCloudPage } from '../miniprogram/services/v2/page';
import { createGatewayV2 } from '../server/v2/gateway';
import { MemoryRepository } from '../server/v2/memory';
import { Entity, Workspace } from '../miniprogram/domain/v2/protocol';

const e = (id: string, data: Record<string, unknown>, indexes = {}): Entity => ({ id, epoch: 'epoch-boundary', version: 1, data, ...indexes });
const event = (dataset: Record<string, string> = {}) => ({ currentTarget: { dataset }, detail: { value: '' } });
let fixtureSequence = 0;
async function fixture(work: (f: any) => Promise<void>) {
  const g = globalThis as any, oldWx = g.wx, oldPage = g.Page, previousRuntime = { ...runtime };
  runtime.mode = 'cloud'; runtime.env = 'v2-page-boundary-' + ++fixtureSequence;
  const workspace: Workspace = { id: 'main', epoch: 'epoch-boundary', version: 1, permissionsVersion: 1, protocolVersion: 2,
    activeSemesterId: 'semester', maintenance: '', maxExecutionMs: 3000 };
  const admin = e('admin', { name: '合成管理员', role: 'admin', active: true, classId: 'c1', studentNo: '001' }, { studentNo: '001' });
  const member = e('member', { name: '合成成员', role: 'member', active: true, classId: 'c1', studentNo: '002' }, { studentNo: '002' });
  const course = { id: 'course', semesterId: 'semester', name: '合成课程', teacher: '', nature: '', classIds: ['c2'], classroom: '101', weekday: 1, start: 1, end: 2, weeks: [1], expected: 20 };
  const metrics = { expected: 20, actual: 20, late: 0, early: 0, sleep: 0, phone: 0, talk: 0, other: 0 };
  const data = { metrics, photos: ['photo'], course, classes: [{ id: 'c2', name: '合成班二', grade: '26', major: '合成专业' }],
    memberName: '合成成员', date: '2026-09-07', firstSubmittedAt: '2026-09-07T03:00:00Z', createdAt: '2026-09-07T03:00:00Z', correctedAt: '', revision: 1,
    absentNames: '无', leaveNames: '无', evaluation: '', feedback: '', suggestion: '', otherDescription: '' };
  const recordIndexes = { semesterId: 'semester', week: 1, memberId: 'member', taskId: 'task' };
  const repository = new MemoryRepository(workspace, {
    members: [admin, member], bindings: [e('ba', {}, { identityKey: 'owner', memberId: 'admin' }), e('bm', {}, { identityKey: 'member-wechat', memberId: 'member' })],
    classes: [e('c1', { name: '合成班一', grade: '26', major: '合成专业', active: true }), e('c2', { name: '合成班二', grade: '26', major: '合成专业', active: true })],
    semesters: [e('semester', { name: '合成学期', startDate: '2026-09-07', weeks: 18, days: 7, periods: 14, grades: ['26'], edition: '', status: 'active' })],
    courses: [e('course', { name: course.name, course, active: true }, { semesterId: 'semester' })],
    course_versions: [e('course-version', { course, active: true, sequence: 1 }, { semesterId: 'semester', parentId: 'course', date: '2026-09-07' })],
    occurrences: [e('course:2026-09-07', { course, classes: data.classes, classLabel: '合成班二', status: 'active', originalDate: '2026-09-07', courseVersionId: 'course-version' }, { semesterId: 'semester', week: 1, date: '2026-09-07', parentId: 'course' })],
    tasks: [e('pending-task', { course, classes: data.classes, classLabel: '合成班二', memberName: '合成成员', date: '2026-09-07', occurrenceId: 'course:2026-09-07', status: 'confirmed' }, { semesterId: 'semester', week: 1, memberId: 'member', parentId: 'plan' })],
    plans: [e('plan', { status: 'confirmed', reason: '合成正式安排' }, { semesterId: 'semester', week: 1 })],
    semester_classes: [e('sc1', {}, { semesterId: 'semester', parentId: 'c1' }), e('sc2', {}, { semesterId: 'semester', parentId: 'c2' })],
    applications: [e('application', { name: '合成申请者', studentNo: '003', classId: 'c1', status: 'rejected', reason: '资料待补正' }, { identityKey: 'applicant', studentNo: '003' })],
    records: [e('record', data, recordIndexes)], record_versions: [e('version-one', { ...data, actorId: 'member', recordVersion: 1, reason: '首次提交' }, { ...recordIndexes, recordId: 'record' })],
    photos: [e('photo', { storageId: 'pg://xuedu-photos/cloud/epoch-boundary/photo.jpg' }, { ...recordIndexes, recordId: 'record' })],
  });
  let who = 'owner', registered: any, sequence = 0;
  const errors: string[] = [], calls: any[] = [], modalCalls: any[] = [];
  const gateway = createGatewayV2({ repository, appid: 'app', bootstrapOpenid: 'owner', maxExecutionMs: 3000,
    now: () => Date.parse('2026-09-07T04:00:00Z'), uuid: () => 'generated-' + ++sequence,
    photos: { async upload(path) { return path; }, async urls(ids) { return ids.map(id => 'https://example.test/' + id); }, async list() { return []; }, async delete() {} } });
  const storage = new Map();
  g.Page = (value: any) => registered = value;
  g.wx = { getStorageSync: (k: string) => storage.get(k), setStorageSync: (k: string, v: any) => storage.set(k, v), removeStorageSync: (k: string) => storage.delete(k),
    showToast() {}, async showModal(value: any) { modalCalls.push(value); if (value.showCancel === false) { errors.push(value.content); return { confirm: false }; } return { confirm: true, content: '合成核对原因' }; },
    cloud: { init() {}, async callFunction({ data }: any) { calls.push(data); try { return { result: { ok: true, data: await gateway(data, { OPENID: who, APPID: 'app' }) } }; } catch (error) { return { result: { ok: false, error: (error as Error).message } }; } } } };
  const page = async (view: string, q = {}) => { registerCloudPage(view as any); const p = { ...registered, data: structuredClone(registered.data), setData(values: any) { Object.assign(this.data, values); } }; p.onLoad(q); await p.load(); return p; };
  const fill = (p: any, values: Record<string, unknown>) => { p.data.fields = p.data.fields.map((field: any) => values[field.key] === undefined ? field : { ...field, value: String(values[field.key]) }); };
  try { await work({ repository, page, fill, errors, calls, modalCalls, who: (value: string) => { who = value; }, event }); }
  finally { g.wx = oldWx; g.Page = oldPage; Object.assign(runtime, previousRuntime); }
}

test('V2边界：普通成员可查看课程总表，管理维护入口仍受权限限制', async () => fixture(async f => {
  f.who('member-wechat'); const courses = await f.page('courses');
  assert.equal(courses.data.error, ''); assert.equal(courses.data.rows.length, 1);
  const manage = await f.page('manage'); assert.match(manage.data.error, /管理权限/);
}));

test('V2边界：被驳回申请通过页面再次提交时携带原申请版本并复用申请', async () => fixture(async f => {
  f.who('applicant'); const page = await f.page('join');
  await page.newForm(event({ type: 'join' }));
  f.fill(page, { name: '合成申请者更正', studentNo: '003', classId: '0' });
  await page.saveForm();
  assert.deepEqual(f.errors, []);
  const saved = await f.repository.get('applications', 'application');
  assert.equal(saved.data.status, 'pending'); assert.equal(saved.version, 2);
  assert.equal((await f.repository.query('applications', {})).items.length, 1);
}));

test('V2边界：已加载历史后再次纠错，页面重新读取最新版本而非保留末页旧缓存', async () => fixture(async f => {
  f.who('member-wechat'); const page = await f.page('record', { id: 'record', semesterId: 'semester' });
  assert.equal(page.data.error, ''); await page.history(); assert.equal(page.data.versions.length, 1);
  page.editRecord(); f.fill(page, { actual: 19, reason: '重新核对原签字表' }); await page.saveForm();
  assert.deepEqual(f.errors, []); await page.history();
  assert.equal(page.data.versions.length, 2);
  assert.ok(page.data.versions.some((version: Entity) => version.data.reason === '重新核对原签字表'));
}));

test('V2边界：管理页面任免、停用及恢复分别调用正确命令并保留角色', async () => fixture(async f => {
  const page = await f.page('manage');
  await page.rowAction(event({ id: 'member', action: 'admin' }));
  assert.equal((await f.repository.get('members', 'member')).data.role, 'admin');
  await page.rowAction(event({ id: 'member', action: 'remove' }));
  assert.equal((await f.repository.get('members', 'member')).data.active, false);
  await page.rowAction(event({ id: 'member', action: 'restore' }));
  assert.equal((await f.repository.get('members', 'member')).data.role, 'admin');
  await page.rowAction(event({ id: 'member', action: 'member' }));
  await page.rowAction(event({ id: 'member', action: 'remove' }));
  await page.rowAction(event({ id: 'member', action: 'restore' }));
  const restored = await f.repository.get('members', 'member');
  assert.equal(restored.data.role, 'member'); assert.equal(restored.data.active, true);
  assert.equal((await f.repository.get('tasks', 'pending-task')).data.status, 'cancelled');
  assert.deepEqual(f.calls.filter((c: any) => c.operation === 'command').map((c: any) => c.payload.type),
    ['roleChange', 'memberStatus', 'memberStatus', 'roleChange', 'memberRemove', 'memberRestore']);
  assert.deepEqual(f.errors, []);
}));

test('V2边界：课程改动页面呈现受影响任务，保留草稿人工确认状态', async () => fixture(async f => {
  const page = await f.page('manage'); const course = await f.repository.get('courses', 'course');
  await page.openForm('courseSave', course);
  f.fill(page, { classroom: '202', effectiveDate: '2026-09-07' });
  await page.saveForm(); assert.deepEqual(f.errors, []);
  assert.equal(page.data.impacts.length, 1);
  assert.equal(page.data.impacts[0].id, 'pending-task');
  assert.equal(page.data.impacts[0].status, 'pendingAdjustment');
  assert.equal((await f.repository.get('tasks', 'pending-task')).data.status, 'pendingAdjustment');
  assert.ok((await f.repository.query('plans', {})).items.some((plan: Entity) => plan.data.status === 'draft'));
  assert.equal((await f.repository.get('records', 'record')).data.course.classroom, '101');
}));

test('V2边界：页面查看新学期草稿不启用全组，另一账号默认仍是原启用学期', async () => fixture(async f => {
  const page = await f.page('manage'); await page.openForm('semesterCreate');
  f.fill(page, { name: '另一学期草稿', startDate: '2027-03-01', weeksCount: 18 }); await page.saveForm();
  assert.deepEqual(f.errors, []);
  const draft = (await f.repository.query('semesters', {})).items.find((semester: Entity) => semester.data.status === 'draft');
  assert.ok(draft); const selectedIndex = page.data.semesters.findIndex((semester: Entity) => semester.id === draft.id);
  page.chooseSemester({ currentTarget: { dataset: {} }, detail: { value: String(selectedIndex) } });
  while (page.data.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.semesterId, draft.id);
  assert.equal((await f.repository.workspace()).activeSemesterId, 'semester');
  f.who('member-wechat'); const records = await f.page('records');
  assert.equal(records.data.semesterId, 'semester');
  assert.equal((await f.repository.get('records', 'record')).semesterId, 'semester');
}));
