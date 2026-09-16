import { computeRecycleLoadDeltas } from '../../server/modules/leads/recycle.util';

describe('computeRecycleLoadDeltas（回收负载释放聚合）', () => {
  it('单个经纪人多条线索按条数聚合', () => {
    const deltas = computeRecycleLoadDeltas([
      { id: 'l1', assigneeId: 'a' },
      { id: 'l2', assigneeId: 'a' },
    ]);
    expect(deltas.get('a')).toBe(2);
    expect(deltas.size).toBe(1);
  });

  it('多个经纪人分别聚合', () => {
    const deltas = computeRecycleLoadDeltas([
      { id: 'l1', assigneeId: 'a' },
      { id: 'l2', assigneeId: 'a' },
      { id: 'l3', assigneeId: 'b' },
    ]);
    expect(deltas.get('a')).toBe(2);
    expect(deltas.get('b')).toBe(1);
    expect(deltas.size).toBe(2);
  });

  it('无经纪人的线索不产生负载', () => {
    const deltas = computeRecycleLoadDeltas([
      { id: 'l1', assigneeId: null },
      { id: 'l2', assigneeId: null },
    ]);
    expect(deltas.size).toBe(0);
  });

  it('空列表返回空结果', () => {
    expect(computeRecycleLoadDeltas([]).size).toBe(0);
  });
});
