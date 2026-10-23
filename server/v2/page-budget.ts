import { PageResult } from '../../miniprogram/domain/v2/protocol';

export const PAGE_BYTE_BUDGET = 384 * 1024;

/** Preserve whole entities and a resumable cursor; never truncate record fields. */
export function boundedPage(result: PageResult): PageResult {
  let bytes = 2, count = 0;
  for (const item of result.items) {
    const next = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (count > 0 && bytes + next > PAGE_BYTE_BUDGET) break;
    bytes += next;
    count++;
  }
  return count < result.items.length
    ? {items:result.items.slice(0,count),cursor:result.items[count-1].id}
    : result;
}
