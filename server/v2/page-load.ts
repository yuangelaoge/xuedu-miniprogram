import { canViewAllRecords } from '../../miniprogram/domain/capabilities';
import { Entity, PageResult, Query, Resource, Workspace } from '../../miniprogram/domain/v2/protocol';
import { LoadView, PageData, PageLoadRequest } from '../../miniprogram/domain/v2/page-data';
import { Semester } from '../../miniprogram/domain/types';
import { boundedWeek } from '../../miniprogram/domain/calendar';

interface Context {
  actor: Entity; workspace: Workspace; now: number;
  get(resource: Resource, id: string, required?: boolean): Promise<Entity | undefined>;
  page(resource: Resource, query?: Query): Promise<PageResult>;
  all(resource: Resource, query?: Query): Promise<Entity[]>;
  count(resource: Resource, query: Query): Promise<number>;
  list(kind: string, semester: Entity | null, week: number, cursor: string): Promise<PageResult>;
  clean(entity: Entity): Entity;
  fail(message: string, code?: string): never;
}
const views: LoadView[] = ['schedule','records','profile','manage','join','record','submission','availability','courses'];
const sections = ['members','applications','autoApproved','rebindings','classes','semesters','courses','audit'];

/** Fixed page shapes only: no arbitrary resource/action batching from the client. */
export async function readPageData(request: PageLoadRequest, c: Context): Promise<PageData> {
  const { actor, workspace, now, clean, fail } = c;
  const view = request.view;
  if (!views.includes(view)) fail('页面类型无效');
  const admin = actor.data.role === 'admin', manager = ['admin','leader'].includes(String(actor.data.role));
  const section = request.section || 'members';
  if (view === 'manage') {
    if (!manager) fail('无管理权限', 'FORBIDDEN');
    if (!sections.includes(section)) fail('管理分类无效');
    if (!admin && ['classes','semesters','courses','rebindings','autoApproved'].includes(section)) fail('此维护入口仅管理员可用', 'FORBIDDEN');
  }
  if (request.more && !['records','courses','manage'].includes(view)) fail('此页面不支持分页');
  if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 256)) fail('分页位置无效');
  if (request.semesterId !== undefined && (typeof request.semesterId !== 'string' || request.semesterId.length > 200)) fail('学期标识无效');
  if (request.more && request.selectionOwner && request.selectionOwner !== actor.id) fail('身份已变化，请刷新', 'IDENTITY_CHANGED');
  const selected = ['profile','join'].includes(view) || request.selectionOwner && request.selectionOwner !== actor.id
    ? workspace.activeSemesterId : request.semesterId || workspace.activeSemesterId;
  // Only picker pages need a semester list; pagination needs only the selected semester.
  const hasPicker = ['schedule','records','courses','manage'].includes(view);
  const [semester, semesters] = await Promise.all([
    selected ? c.get('semesters', selected) : Promise.resolve(undefined),
    hasPicker && !request.more ? c.page('semesters') : Promise.resolve(undefined),
  ]);
  const maximum = Number(semester?.data.weeks || 60);
  if (request.week !== undefined && (!Number.isInteger(request.week) || request.week < 1 || request.week > 60)) fail('周次无效');
  const current = semester ? boundedWeek(semester.data as unknown as Semester, new Date(now)) : 1;
  const week = Math.min(maximum, request.week ?? (selected === workspace.activeSemesterId ? current + (['schedule','availability'].includes(view) ? 1 : 0) : 1));
  const result: PageData = { semester: semester ? clean(semester) : null, week };
  if (!request.more) result.semesters = semesters
    ? { items: semesters.items.map(clean), cursor: semesters.cursor }
    : { items: semester ? [clean(semester)] : [], cursor: '' };

  if (view === 'profile') {
    const [schoolClass, pendingCount] = await Promise.all([
      actor.data.classId ? c.get('classes', String(actor.data.classId), false) : Promise.resolve(undefined),
      manager ? c.count('applications', {eq:{status:'pending'}}) : Promise.resolve(0),
    ]);
    result.profile = { className: schoolClass ? String(schoolClass.data.name) : '班级未设置', pendingCount };
  }
  const kind = view === 'manage' ? section : view === 'records' ? 'records' : view === 'courses' ? 'courses' : '';
  const filter: Query = {eq:{semesterId:selected, week}};
  const ownFilter: Query = {eq:{...filter.eq,memberId:actor.id}};
  const visibleFilter = (view === 'records' ? canViewAllRecords(actor.data.role) : manager) ? filter : ownFilter;
  const loadList = async () => {
    if (!kind) return;
    const [list, classes] = await Promise.all([
      ['courses','records'].includes(kind) && !semester ? Promise.resolve({items:[],cursor:''})
        : c.list(kind, semester || null, week, request.cursor || ''),
      !request.more && kind === 'courses' ? c.page('classes') : Promise.resolve(undefined),
    ]);
    result.list = list;
    if (classes) result.classes = {items:classes.items.map(clean),cursor:classes.cursor};
    if (admin && view === 'manage' && ['applications','autoApproved'].includes(kind) && !request.more) {
      const setting = workspace.autoApproval;
      result.autoApproval = {setting:setting || null,active:setting?.enabled === true && Date.parse(setting.expiresAt)>now,
        expired:setting?.enabled === true && Date.parse(setting.expiresAt)<=now,version:workspace.version,serverNow:now};
    }
  };
  const loadDetails = async () => {
    if (!semester || request.more) return;
    if (view === 'records') {
      const [total, submitted, plans] = await Promise.all([
        c.count('tasks', {...visibleFilter,in:{status:['confirmed','submitted','pendingAdjustment']}}),
        c.count('records', visibleFilter), c.all('plans',filter),
      ]);
      result.summary = {total,submitted,skipped:plans.filter(p=>['confirmed','skipped'].includes(String(p.data.status))).pop()?.data.status === 'skipped'};
    } else if (view === 'availability') {
      const own = (await c.page('availability', {...ownFilter,limit:1})).items[0];
      result.weekData = {semester:clean(semester),tasks:[],occurrences:[],availability:own ? clean(own) : null};
    } else if (view === 'schedule') {
      const [tasks, plans] = await Promise.all([c.all('tasks',visibleFilter),c.all('plans',filter)]);
      const draft = plans.find(p=>p.data.status === 'draft');
      result.weekData = {semester:clean(semester),tasks:tasks.map(clean),occurrences:[],
        plan:plans.filter(p=>['confirmed','skipped'].includes(String(p.data.status))).map(clean).pop(),
        draft:draft ? clean(draft) : undefined,uncovered:(draft?.data.uncovered || []) as {label:string;reason:string}[]};
    } else if (['record','submission'].includes(view) && request.targetId) {
      if (typeof request.targetId !== 'string' || request.targetId.length > 200) fail('对象标识无效');
      const entity = (await c.get(view === 'record' ? 'records' : 'tasks',request.targetId))!;
      if (entity.semesterId !== selected || !(view === 'record' ? canViewAllRecords(actor.data.role) : manager) && entity.memberId !== actor.id) fail('无权查看他人的资料或其他学期资料','FORBIDDEN');
      if (view === 'record') result.record = {record:clean(entity),canEdit:admin || entity.memberId === actor.id && now-Date.parse(String(entity.data.firstSubmittedAt))<86400000};
      else result.task = clean(entity);
    }
  };
  await Promise.all([loadList(),loadDetails()]);
  return result;
}
