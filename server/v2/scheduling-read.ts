import { Entity, PageResult, Query, Resource, Workspace } from '../../miniprogram/domain/v2/protocol';

/** Request-local, server-only read set. Never persisted or returned to the client.
 * Complete only for the selected semester/week (records also include the prior week),
 * its participating classes, and current-epoch members. Used only by the two draft commands.
 */
export interface SchedulingRead {
  workspace: Workspace;
  rows: Partial<Record<Resource, Entity[]>>;
  memberPage?: PageResult;
}
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function schedulingPage(rows: Entity[], q: Query): PageResult {
  const limit = q.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_QUERY');
  const matching = rows.filter(row => {
    const fields: Record<string, unknown> = {...row, status: row.data.status};
    return (!q.after || row.id > q.after) &&
      (!q.dateFrom || !!row.date && row.date >= q.dateFrom) && (!q.dateTo || !!row.date && row.date <= q.dateTo) &&
      Object.entries(q.eq || {}).every(([k,v]) => fields[k] === v) &&
      Object.entries(q.in || {}).every(([k,v]) => v!.some(item => fields[k] === item));
  }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {items: copy(matching.slice(0,limit)), cursor: matching.length > limit ? matching[limit-1].id : ''};
}
