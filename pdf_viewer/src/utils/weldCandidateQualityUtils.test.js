import {
  applySharedWeldCandidateFilters,
  filterTextLikeWeldRows,
  selectDominantWeldRuleCandidates,
  splitWeldsByConnectionConfidence
} from './weldCandidateQualityUtils';

const candidate = (id, x, y, ruleId = '6_segment_closed_path') => ({
  id,
  ruleId,
  center: { x, y },
  boundingBox: { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 }
});

test('shared filtering removes a row of text-like symbol candidates', () => {
  const row = Array.from({ length: 6 }, (_, index) => candidate(`row-${index}`, index * 10, 20));
  const isolated = [candidate('real-1', 15, 80), candidate('real-2', 70, 110)];
  const result = filterTextLikeWeldRows([...row, ...isolated]);
  expect(result.removed).toHaveLength(6);
  expect(result.welds.map(item => item.id)).toEqual(['real-1', 'real-2']);
});

test('auto-exclusive profile keeps the clearly dominant project rule', () => {
  const result = selectDominantWeldRuleCandidates([
    candidate('a', 0, 0, 'project-a'),
    candidate('b', 10, 0, 'project-a'),
    candidate('c', 20, 0, 'project-a'),
    candidate('d', 30, 0, 'project-b')
  ]);
  expect(result.applied).toBe(true);
  expect(result.ruleId).toBe('project-a');
  expect(result.welds).toHaveLength(3);
});

test('connection confidence excludes low candidates only when association works reliably', () => {
  const connected = [0, 1, 2].map(index => ({
    ...candidate(`connected-${index}`, index * 10, 0),
    relatedSegment: { pathId: `pipe-${index}` },
    relatedSegmentDistance: index + 0.5
  }));
  const low = candidate('review', 80, 80);
  const result = splitWeldsByConnectionConfidence([...connected, low]);
  expect(result.enforced).toBe(true);
  expect(result.welds).toHaveLength(3);
  expect(result.review.map(item => item.id)).toEqual(['review']);

  const unavailable = splitWeldsByConnectionConfidence([
    connected[0],
    candidate('keep-1', 20, 20),
    candidate('keep-2', 30, 30),
    candidate('keep-3', 40, 40)
  ]);
  expect(unavailable.enforced).toBe(false);
  expect(unavailable.welds).toHaveLength(4);
  expect(unavailable.review).toHaveLength(0);
});

test('combined shared filter reports stable diagnostics', () => {
  const source = Array.from({ length: 4 }, (_, index) => candidate(`a-${index}`, index * 20, index * 20, 'project-a'));
  const first = applySharedWeldCandidateFilters(source);
  const second = applySharedWeldCandidateFilters(source);
  expect(second.diagnostics).toEqual(first.diagnostics);
  expect(second.welds.map(item => item.id)).toEqual(first.welds.map(item => item.id));
});
