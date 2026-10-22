import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../miniprogram/config/runtime';
import { registerCloudPage } from '../miniprogram/services/v2/page';
import { createGatewayV2 } from '../server/v2/gateway';
import { MemoryRepository } from '../server/v2/memory';
import { Entity, Workspace } from '../miniprogram/domain/v2/protocol';
import { command, queueScheduleFocus, takeScheduleFocus, selectSemester } from '../miniprogram/services/v2/client';

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
  const reads: {resource:string;method:string;query?:any}[] = [];
  for (const method of ['get','query','count'] as const) {
    const original = repository[method].bind(repository) as any;
    (repository as any)[method] = (...args:any[]) => { reads.push({resource:args[0],method,query:args[1]}); return original(...args); };
  }
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
  const page = async (view: string, q = {}) => { registerCloudPage(view as any); const p = { ...registered, data: structuredClone(registered.data), setData(values: any) { Object.assign(this.data, values); } }; p.onLoad({...(view === "home" ? {} : {week:"1"}),...q}); await p.load(); return p; };
  const fill = (p: any, values: Record<string, unknown>) => { p.data.fields = p.data.fields.map((field: any) => values[field.key] === undefined ? field : { ...field, value: String(values[field.key]) }); };
  try { await work({ repository, reads, gateway, storage, page, fill, errors, calls, modalCalls, who: (value: string) => { who = value; }, event }); }
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


test('首页启动合并：本周保持一次请求，下周独立一次读取', async () => fixture(async f => {
  const home = await f.page('home');
  assert.equal(home.data.error, '');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.page.week,2);
  assert.equal(f.calls[0].payload.includeHome, true);
  assert.equal(home.data.week, 1, '当前周以服务端时间为准');
  assert.equal(home.data.semesterId, 'semester');
  assert.equal(home.data.taskCount, 1);
  assert.equal(home.data.recordCount, 1);
  await home.load();
  assert.equal(f.calls.length, 4);
  f.who('member-wechat');
  const member = await f.page('home');
  assert.equal(member.data.error, '');
  assert.equal(member.data.homeTasks.length, 1);
  assert.ok(member.data.weekData.tasks.every((task: Entity) => task.memberId === 'member'));
  assert.ok(member.data.weekData.records.every((record: Entity) => record.memberId === 'member'));
  const wx = (globalThis as any).wx;
  const legacy = await wx.cloud.callFunction({data:{protocolVersion:2,operation:'query',epoch:'epoch-boundary',semesterId:'semester',payload:{kind:'week',week:1}}});
  assert.deepEqual(member.data.weekData, {...legacy.result.data.data,occurrences:[]}, '首页省去课程实例，任务、记录与统计口径保持一致');
}));

test('首页启动合并：未入组与无启用学期不返回内部周数据', async () => fixture(async f => {
  f.who('applicant');
  const applicant = await f.page('home');
  assert.equal(applicant.data.error, '');
  assert.equal(f.calls.length, 1);
  assert.equal(applicant.data.memberId, '');
  const wx = (globalThis as any).wx;
  const response = await wx.cloud.callFunction({data:{protocolVersion:2,operation:'bootstrap',payload:{includeHome:true}}});
  assert.deepEqual(response.result.data.data.home, {semester:null,week:1,weekData:null});
  f.who('owner');
  const state = await f.repository.workspace();
  f.repository.workspace = async () => ({...state, activeSemesterId:''});
  const before = f.calls.length, home = await f.page('home');
  assert.equal(home.data.error, '');
  assert.equal(f.calls.length - before, 1);
  assert.equal(home.data.semesterId, '');
  assert.deepEqual(home.data.homeTasks, []);
}));

test('首页启动合并：兼容尚未支持附带首页数据的旧后端', async () => fixture(async f => {
  const wx = (globalThis as any).wx, invoke = wx.cloud.callFunction;
  wx.cloud.callFunction = ({data}:any) => invoke({data: data.operation === 'bootstrap' ? {...data, payload:{}} : data});
  const home = await f.page('home');
  assert.equal(home.data.error, '');
  assert.equal(f.calls.length, 4);
  assert.match(home.data.nextWeekError,/无法读取/);
  assert.equal(home.data.semesterId, 'semester');
}));


test('页面合并：主要页面各一次启动请求，详情只多一次照片授权', async () => fixture(async f => {
  for (const [view,q] of [['profile',{}],['schedule',{}],['availability',{}],['records',{}],['courses',{}],['manage',{}],['join',{}],['submission',{taskId:'pending-task',semesterId:'semester'}]] as const) {
    const before=f.calls.length;
    const p=await f.page(view,q);
    assert.equal(p.data.error,'',view);
    assert.equal(f.calls.length-before,1,view+'只请求一次');
    assert.equal(f.calls.at(-1).payload.page.view,view);
  }
  const before=f.calls.length, detail=await f.page('record',{id:'record',semesterId:'semester'});
  assert.equal(detail.data.error,'');assert.equal(detail.data.record.id,'record');
  assert.equal(f.calls.length-before,2);assert.equal(f.calls.at(-1).operation,'photoUrls');
}));

test('页面合并：无课时间和个人页不扫描无关资料，记录概览计数不重复读全周明细', async () => fixture(async f => {
  const availability=await f.page('availability');
  assert.equal(availability.data.error,'');
  assert.ok(!f.reads.some((r:any)=>['tasks','records','occurrences','plans','classes'].includes(r.resource)));
  f.reads.length=0;
  const profile=await f.page('profile');
  assert.equal(profile.data.className,'合成班一');
  assert.equal(f.reads.filter((r:any)=>r.resource==='classes'&&r.method==='get').length,1);
  assert.ok(!f.reads.some((r:any)=>r.resource==='classes'&&r.method==='query'));
  assert.ok(f.reads.some((r:any)=>r.resource==='applications'&&r.method==='count'));
  f.reads.length=0;
  const records=await f.page('records');
  assert.equal(records.data.weekTotal,1);assert.equal(records.data.weekSubmitted,1);
  assert.equal(f.reads.filter((r:any)=>r.resource==='records'&&r.method==='query').length,1);
  assert.ok(f.reads.some((r:any)=>r.resource==='records'&&r.method==='count'));
  assert.ok(!f.reads.some((r:any)=>r.resource==='occurrences'));
}));

test('页面合并：翻页只追加下一页，不重取学期列表、统计或课程班级', async () => fixture(async f => {
  const w=await f.repository.workspace();
  await f.repository.commit({epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'owner',actorId:'admin',requestId:'page-fixture',reads:[],changes:Array.from({length:55},(_,i)=>({resource:'records',id:'extra-'+i.toString().padStart(3,'0'),expectedVersion:0,value:e('extra-'+i.toString().padStart(3,'0'),{memberName:'合成成员'},{semesterId:'semester',week:1,memberId:'member',taskId:'extra-task-'+i})})),result:{}});
  const p=await f.page('records');
  assert.equal(p.data.error,'');assert.equal(p.data.rows.length,50);assert.equal(p.data.weekSubmitted,56);
  const before=f.calls.length;f.reads.length=0;
  await p.more();
  assert.equal(p.data.error,'');assert.equal(p.data.rows.length,56);assert.equal(p.data.cursor,'');
  assert.equal(f.calls.length-before,1);
  assert.ok(!f.reads.some((r:any)=>r.method==='count'||r.resource==='semesters'&&r.method==='query'));
  assert.equal(p.data.weekSubmitted,56);
}));

test('页面合并：未入组、维护、越权管理和他人记录仍受限制', async () => fixture(async f => {
  const invoke=(view:string,other:any={})=>f.gateway({protocolVersion:2,operation:'bootstrap',payload:{page:{view,week:1,semesterId:'semester',...other}}},{OPENID:'member-wechat',APPID:'app'});
  await assert.rejects(invoke('manage',{section:'classes'}),/权限/);
  const existing=await f.repository.get('records','record'), state=await f.repository.workspace();
  await f.repository.commit({epoch:state.epoch,workspaceVersion:state.version,permissionsVersion:state.permissionsVersion,identityKey:'owner',actorId:'admin',requestId:'foreign-record',reads:[],changes:[{resource:'records',id:'foreign',expectedVersion:0,value:{...existing,id:'foreign',memberId:'admin',taskId:'foreign-task'}}],result:{}});
  await assert.rejects(invoke('record',{targetId:'foreign'}),/无权查看/);
  const own=await invoke('records');assert.ok(own.data.page.list.items.every((r:Entity)=>r.memberId==='member'));
  assert.equal(own.data.page.summary.submitted,1);
  await assert.rejects(invoke('submission',{targetId:'missing'}),/不存在/);
  f.who('applicant');const applicant=await f.page('records');assert.equal(applicant.data.memberId,'');assert.equal(applicant.data.rows.length,1);
  const rejected=await f.gateway({protocolVersion:2,operation:'bootstrap',payload:{page:{view:'records'}}},{OPENID:'applicant',APPID:'app'});
  assert.equal(rejected.data.page,null);
  const w=await f.repository.workspace();f.repository.workspace=async()=>({...w,maintenance:'maintenance-test'});
  f.who('owner');f.reads.length=0;const p=await f.page('records');assert.equal(p.data.maintenance,'maintenance-test');
  assert.ok(!f.reads.some((r:any)=>r.resource==='records'));
}));


test('页面合并：旧后端回退和历史学期深链保留原有功能', async () => fixture(async f => {
  const wx=(globalThis as any).wx, invoke=wx.cloud.callFunction;
  wx.cloud.callFunction=({data}:any)=>invoke({data:data.operation==='bootstrap'?{...data,payload:{}}:data});
  const records=await f.page('records');assert.equal(records.data.error,'');assert.equal(records.data.rows.length,1);
  assert.equal(f.calls.length,4);
  wx.cloud.callFunction=invoke;
  const state=await f.repository.workspace();
  await f.repository.commit({epoch:state.epoch,workspaceVersion:state.version,permissionsVersion:state.permissionsVersion,identityKey:'owner',actorId:'admin',requestId:'historical',reads:[],changes:[
    {resource:'semesters',id:'historical',expectedVersion:0,value:e('historical',{name:'历史学期',startDate:'2025-09-01',weeks:18,days:5,periods:14,status:'draft'})},
    {resource:'availability',id:'historical-own',expectedVersion:0,value:e('historical-own',{slots:['2:3'],optedIn:true,note:'历史填报'},{semesterId:'historical',memberId:'admin',week:1})},
  ],result:{}});
  const page=await f.page('availability',{semesterId:'historical',week:'1'});
  assert.equal(page.data.error,'');assert.equal(page.data.semesterId,'historical');
  assert.deepEqual(page.data.selectedSlots,['2:3']);assert.equal(page.data.availabilityNote,'历史填报');
}));

test('页面合并：读取过程中权限撤销不返回旧权限资料', async () => fixture(async f => {
  const query=f.repository.query.bind(f.repository), workspace=f.repository.workspace.bind(f.repository);
  let revoked=false;
  f.repository.query=async(resource:any,q:any)=>{const result=await query(resource,q);if(resource==='records')revoked=true;return result;};
  f.repository.workspace=async()=>{const w=await workspace();return revoked?{...w,permissionsVersion:w.permissionsVersion+1}:w;};
  await assert.rejects(f.gateway({protocolVersion:2,operation:'bootstrap',payload:{page:{view:'records',week:1}}},{OPENID:'owner',APPID:'app'}),/权限已变化/);
}));


test('页面合并：旧轮次先更新身份上下文并丢弃旧选择，旧轮次分页拒绝拼接', async () => fixture(async f => {
  const boot=await f.gateway({protocolVersion:2,operation:'bootstrap',epoch:'old-epoch',payload:{page:{view:'records',semesterId:'deleted-semester'}}},{OPENID:'owner',APPID:'app'});
  assert.equal(boot.epoch,'epoch-boundary');assert.equal(boot.data.page,null);
  await assert.rejects(f.gateway({protocolVersion:2,operation:'bootstrap',epoch:'old-epoch',payload:{page:{view:'records',semesterId:'deleted-semester',more:true}}},{OPENID:'owner',APPID:'app'}),/业务数据已变化/);
}));

test('加载加速：本周不读课程实例，下周仅目标周，已审核申请不读取', async () => fixture(async f => {
  const home = await f.page('home');
  assert.equal(home.data.error, '');
  assert.equal(home.data.taskCount, 1);
  assert.equal(home.data.recordCount, 1);
  assert.ok(!f.reads.some((r:any) => r.resource==='applications'));
  assert.ok(f.reads.filter((r:any)=>r.resource==='occurrences').every((r:any)=>r.query?.eq?.week===home.data.nextWeek));
  await home.load();
  assert.deepEqual(f.calls.at(-1).readHint, {memberId:'admin',semesterId:'semester'});
}));

test('加载加速：绑定、成员与学期并行读取，每项只取一次', async () => fixture(async f => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const query = f.repository.query.bind(f.repository), get = f.repository.get.bind(f.repository);
  f.repository.query = async (resource:any, q:any) => {
    if (resource === 'bindings') { started.push(resource); await gate; }
    return query(resource,q);
  };
  f.repository.get = async (resource:any, id:any) => {
    if (['members','semesters'].includes(resource)) { started.push(resource); await gate; }
    return get(resource,id);
  };
  const pending = f.gateway({protocolVersion:2,operation:'bootstrap',epoch:'epoch-boundary',readHint:{memberId:'admin',semesterId:'semester'},payload:{includeHome:true}},{OPENID:'owner',APPID:'app'});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started.sort(), ['bindings','members','semesters']);
  } finally { release(); }
  const response = await pending;
  assert.equal(response.data.member.id,'admin');
  assert.equal(started.length,3);
}));

test('加载加速：伪造成员提示、旧轮次提示和无绑定提示均不能提升权限', async () => fixture(async f => {
  const invoke = (who:string, epoch='epoch-boundary', view='records') => f.gateway({protocolVersion:2,operation:'bootstrap',epoch,
    readHint:{memberId:'admin',semesterId:'semester'},payload:{page:{view,section:'classes',week:1}}},{OPENID:who,APPID:'app'});
  const member = await invoke('member-wechat');
  assert.equal(member.data.member.id,'member');
  assert.ok(member.data.page.list.items.every((r:Entity)=>r.memberId==='member'));
  assert.equal(member.resourceVersions['members:admin'],undefined);
  await assert.rejects(invoke('member-wechat','epoch-boundary','manage'), /权限/);
  const unbound = await invoke('unbound');
  assert.equal(unbound.data.member,null);assert.equal(unbound.data.page,null);
  const stale = await invoke('member-wechat','old-epoch');
  assert.equal(stale.data.member.id,'member');assert.equal(stale.data.page,null);
}));

test('加载加速：并行预读期间撤权仍由响应前权限版本检查拦截', async () => fixture(async f => {
  const get = f.repository.get.bind(f.repository), workspace = f.repository.workspace.bind(f.repository);
  let revoked = false;
  f.repository.get = async (resource:any,id:any) => { const row=await get(resource,id); if(resource==='members')revoked=true; return row; };
  f.repository.workspace = async () => {const w=await workspace();return revoked?{...w,permissionsVersion:w.permissionsVersion+1}:w;};
  await assert.rejects(f.gateway({protocolVersion:2,operation:'bootstrap',epoch:'epoch-boundary',readHint:{memberId:'admin',semesterId:'semester'},payload:{includeHome:true}},
    {OPENID:'owner',APPID:'app'}),/权限已变化/);
}));

test('加载加速：短时返回不请求，手动刷新、到期、写入和身份变化会重新读取', async () => fixture(async f => {
  const originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  try {
    const home = await f.page('home');
    let before = f.calls.length;
    await home.onShow();await home.onShow();
    assert.equal(f.calls.length,before);
    await home.load();before+=2;assert.equal(f.calls.length,before);
    now += 15000;await home.onShow();before+=2;assert.equal(f.calls.length,before);
    await command('availabilitySave',{week:1,slots:[],optedIn:false,note:'合成保存'},'semester',0);
    before = f.calls.length;await home.onShow();assert.equal(f.calls.length,before+2);
    f.who('member-wechat');await f.page('profile');
    before=f.calls.length;await home.onShow();assert.equal(f.calls.length,before+2);
    assert.equal(home.data.memberId,'member');assert.equal(home.data.admin,false);
  } finally {Date.now=originalNow;}
}));

test('单次数据库首页：使用服务端汇总，精简记录仍可打开本人详情', async () => fixture(async f => {
  const wx=(globalThis as any).wx,invoke=wx.cloud.callFunction;
  wx.cloud.callFunction=async(args:any)=>{
    const response=await invoke(args), data=response.result.data?.data;
    if(args.data.payload?.includeHome && data?.home?.weekData) {
      const w=data.home.weekData, owner=data.member.id;
      data.home.summary={taskCount:87,recordCount:69,coverage:24};
      w.tasks=w.tasks.filter((t:Entity)=>t.memberId===owner);
      w.records=w.records.filter((r:Entity)=>r.memberId===owner).map((r:Entity)=>({id:r.id,epoch:r.epoch,version:r.version,taskId:'pending-task',memberId:r.memberId,data:{classLabel:r.data.classLabel}}));
    }
    return response;
  };
  f.who('member-wechat');const home=await f.page('home');
  assert.equal(home.data.error,'');assert.equal(home.data.taskCount,87);assert.equal(home.data.recordCount,69);assert.equal(home.data.coverage,24);
  assert.equal(home.data.homeTasks.find((t:any)=>t.id==='pending-task').recordId,'record');
  assert.equal(f.calls.filter((c:any)=>c.payload?.includeHome).length,1);
  assert.equal(f.calls.length,2);
}));

test('首页进入安排保持第8/9周，覆盖已缓存周次和搜索；填写入口直达本任务', async () => fixture(async f => {
  f.who('member-wechat');
  const home = await f.page('home');
  home.setData({week:8,nextWeek:9});
  const wx=(globalThis as any).wx, navigation:any[]=[];
  wx.switchTab=(o:any)=>navigation.push(o);
  wx.navigateTo=(o:any)=>navigation.push(o);
  const schedule=await f.page('schedule',{week:'9'});
  schedule.setData({searchText:'上次留下的搜索'});
  let before=f.calls.length;
  await home.navigate(event({target:'schedule',week:'8'}));
  assert.equal(navigation.at(-1).url,'/pages/schedule/schedule');
  await schedule.onShow();
  assert.equal(schedule.data.week,8);
  assert.equal(schedule.data.searchText,'');
  assert.equal(f.calls.length,before+1,'15秒内的旧页面也必须按指定周重新读取');
  assert.equal(f.calls.at(-1).payload.page.week,8);
  assert.equal(f.calls.at(-1).payload.page.semesterId,'semester');
  await home.navigate(event({target:'schedule',week:'9'}));
  await schedule.onShow();assert.equal(schedule.data.week,9);
  before=f.calls.length;await schedule.onShow();assert.equal(f.calls.length,before,'选择只消费一次');
  home.open(event({id:'pending-task'}));
  assert.equal(navigation.at(-1).url,'/pages/submission/submission?taskId=pending-task&semesterId=semester');
  const submission=await f.page('submission',{taskId:'pending-task',semesterId:'semester'});
  assert.equal(submission.data.error,'');
  assert.equal(submission.data.recordContext.data.course.name,'合成课程');
  // Direct tab entry still follows the existing next-week default.
  const direct=await f.page('schedule',{week:''});assert.equal(direct.data.week,2);
}));

test('首页指定安排学期不沿用历史选择，失败跳转与换身份不遗留选择', async () => fixture(async f => {
  const home=await f.page('home'),wx=(globalThis as any).wx;
  wx.switchTab=(o:any)=>o.fail?.();
  await home.navigate(event({target:'schedule',week:'8'}));
  assert.equal(takeScheduleFocus(),undefined);
  wx.switchTab=()=>{};
  selectSemester('previous-semester');
  await home.navigate(event({target:'schedule',week:'8'}));
  const schedule=await f.page('schedule');await schedule.onShow();
  assert.equal(schedule.data.semesterId,'semester');assert.equal(schedule.data.week,8);
  assert.equal(schedule.data.error,'');
  queueScheduleFocus('semester',9);
  f.who('member-wechat');await f.page('profile');
  assert.equal(takeScheduleFocus(),undefined,'切换身份后丢弃旧选择');
}));

test('安排页读取尚未完成时从首页跳转，最终显示新指定周而非旧请求的周', async () => fixture(async f => {
  const home=await f.page('home'),schedule=await f.page('schedule',{week:'9'});
  const wx=(globalThis as any).wx,invoke=wx.cloud.callFunction;
  wx.switchTab=()=>{};
  let release:()=>void=()=>{},started:()=>void=()=>{};
  const entered=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
  let held=false;
  wx.cloud.callFunction=async(args:any)=>{
    if(!held && args.data.payload?.page?.view==='schedule') {held=true;started();await gate;}
    return invoke(args);
  };
  const loading=schedule.load();await entered;
  await home.navigate(event({target:'schedule',week:'8'}));
  await schedule.onShow();release();await loading;
  assert.equal(schedule.data.week,8);assert.equal(schedule.data.error,'');assert.equal(schedule.data.busy,false);
  assert.equal(f.calls.at(-1).payload.page.week,8);
}));
