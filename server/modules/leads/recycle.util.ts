/** 回收时需要释放负载的线索行：仅关心线索 id 与原经纪人 */
export interface RecyclableLead {
  id: string;
  assigneeId: string | null;
}

/**
 * 聚合回收时应释放的经纪人负载：每条被回收的 assigned 线索
 * 只在原经纪人名下计一次，按经纪人汇总为释放数量。
 * 无经纪人的线索不产生负载。
 */
export function computeRecycleLoadDeltas(
  rows: RecyclableLead[],
): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const row of rows) {
    if (!row.assigneeId) continue;
    deltas.set(row.assigneeId, (deltas.get(row.assigneeId) ?? 0) + 1);
  }
  return deltas;
}
