import {
  buildWeldAdjustmentDelta,
  buildDirectWeldAdjustmentPlan,
  compactReplacementSourceIds,
  prepareWeldAdjustmentPreview
} from './weldAdjustmentDeltaUtils';

const weld = (id, page, pipeline, number, extra = {}) => ({
  id, sourceAnnotationId: id, page, pageNum: page, pipelineNumber: pipeline,
  weldNumber: number, number, ...extra
});

describe('weld adjustment delta', () => {
  test('stores cumulative deleted source IDs on only one carrier weld', () => {
    const result = compactReplacementSourceIds([
      { ...weld('a1', 1, 'PIPE-A', 1), replacementSourceAnnotationIds: ['old-1'] },
      { ...weld('a2', 1, 'PIPE-A', 2), replacementSourceAnnotationIds: ['old-1'] },
      weld('a3', 1, 'PIPE-A', 3)
    ], ['old-2']);
    expect(result[0].replacementSourceAnnotationIds).toEqual(['old-1', 'old-2']);
    expect(result[1].replacementSourceAnnotationIds).toBeUndefined();
    expect(result[2].replacementSourceAnnotationIds).toBeUndefined();
  });
  test('uses all pages for calculation but submits only new and renumbered welds', () => {
    const original = [
      weld('a1', 1, 'PIPE-A', 1), weld('a2', 2, 'PIPE-A', 2),
      weld('b1', 50, 'PIPE-B', 1), weld('c1', 100, 'PIPE-C', 1)
    ];
    const current = [
      original[0],
      { id: 'manual', manualInsertId: 'manual', isManualInserted: true, page: 1, pipelineNumber: 'PIPE-A', weldNumber: 2 },
      { ...original[1], weldNumber: 3, number: 3 },
      original[2], original[3]
    ];
    const result = buildWeldAdjustmentDelta({ originalWelds: original, currentWelds: current });
    expect(result.welds.map(item => item.id)).toEqual(['manual', 'a2']);
    expect(result.manualInsertedCount).toBe(1);
    expect(result.changedExistingCount).toBe(1);
  });

  test('carries an exact deleted id even when no later weld changes', () => {
    const original = [weld('a1', 1, 'PIPE-A', 1), weld('a2', 1, 'PIPE-A', 2)];
    const current = [{ ...original[0], replacementSourceAnnotationIds: ['a2'] }];
    const result = buildWeldAdjustmentDelta({ originalWelds: original, currentWelds: current });
    expect(result.welds).toHaveLength(1);
    expect(result.welds[0].replacementSourceAnnotationIds).toEqual(['a2']);
  });

  test('preview replaces the old source visually while retaining its geometry', () => {
    const existing = [{ id: 'old', text: '8', startX: 10, startY: 20, frameSize: 56.7 }];
    const incoming = [{ id: 'preview', text: '9', startX: 999, startY: 999, weldData: { sourceAnnotationId: 'old' } }];
    const result = prepareWeldAdjustmentPreview(existing, incoming);
    expect(result.annotations[0]).toMatchObject({ text: '9', startX: 10, startY: 20, frameSize: 56.7 });
    expect(result.replacedIds.has('old')).toBe(true);
  });

  test('commits existing welds in place, deletes exact sources, and adds only manual welds', () => {
    const existing = [
      { id: 'a1', text: 'F1', startX: 10, weldData: { weldNumber: 1, center: { x: 5, y: 5 } } },
      { id: 'a2', text: 'F2', startX: 20, weldData: { weldNumber: 2 } }
    ];
    const incoming = [
      {
        id: 'preview-a1', text: 'F2', replacementSourceAnnotationIds: ['a2'],
        weldData: { sourceAnnotationId: 'a1', weldNumber: 2, pipelineNumber: 'PIPE-A' }
      },
      {
        id: 'manual-1', text: 'F1', startX: 99,
        weldData: { isManualInserted: true, manualInsertId: 'manual-1', weldNumber: 1 }
      }
    ];
    const result = buildDirectWeldAdjustmentPlan(existing, incoming);
    expect(result.deletedIds).toEqual(['a2']);
    expect(result.additions.map(item => item.id)).toEqual(['manual-1']);
    expect(result.updatesById.a1).toMatchObject({ text: 'F2', weldNumber: 2 });
    expect(result.updatesById.a1).not.toHaveProperty('startX');
    expect(result.updatesById.a1.weldData.center).toEqual({ x: 5, y: 5 });
  });

  test('updates a previously saved manual weld instead of adding it again', () => {
    const existing = [{
      id: 'saved-manual', text: 'F7',
      weldData: { isManualInserted: true, manualInsertId: 'old-manual', weldNumber: 7 }
    }];
    const incoming = [{
      id: 'preview', text: 'F8',
      weldData: {
        sourceAnnotationId: 'saved-manual', isManualInserted: true,
        manualInsertId: 'old-manual', weldNumber: 8
      }
    }];
    const result = buildDirectWeldAdjustmentPlan(existing, incoming);
    expect(result.additions).toEqual([]);
    expect(result.updatesById['saved-manual']).toMatchObject({ text: 'F8', weldNumber: 8 });
  });
});
