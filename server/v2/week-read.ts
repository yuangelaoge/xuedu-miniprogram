import { Entity, Query, Resource } from '../../miniprogram/domain/v2/protocol';

export const EFFECTIVE_TASK_STATUSES = ['confirmed', 'submitted', 'pendingAdjustment'];
export const CURRENT_PLAN_STATUSES = ['confirmed', 'skipped', 'draft'];

type ReadAll = (resource: Resource, query?: Query) => Promise<Entity[]>;

/** Filter before paging/tracking versions: superseded drafts are history, not page data. */
export async function readCurrentWeekTasks(all: ReadAll, filter: Query, plans: Entity[], includeDraft = true): Promise<Entity[]> {
  const draft = includeDraft ? plans.find(plan => plan.data.status === 'draft') : undefined;
  const [effective, proposed] = await Promise.all([
    all('tasks', {...filter, in: {...filter.in, status: EFFECTIVE_TASK_STATUSES}}),
    draft ? all('tasks', {...filter, eq: {...filter.eq, status: 'draft', parentId: draft.id}}) : Promise.resolve([]),
  ]);
  // Match the repository's ID ordering after merging the two disjoint queries.
  return [...effective, ...proposed].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
