import {
  buildReopenedAnnotationRule,
  buildReopenedWeldSequence,
  findReopenedWeldTemplate,
  repairReopenedPageNumberingContinuity,
  isRecoverableWeldAnnotation,
  resolvePipelineFromWeldAnnotations
} from './reopenedWeldSequenceUtils';

const annotation = (id, page, number, pipeline = 'PIPE-A', batchRunId = 'batch-a') => ({
  id,
  page,
  text: `F${number}`,
  topText: '4',
  jointTypeText: 'BW',
  borderShape: 'split-circle',
  batchRunId,
  pipelineNumber: pipeline,
  weldData: {
    stableKey: `path:${id}`,
    pathId: id,
    center: { x: number * 10, y: page * 20 },
    weldNumber: number,
    pageNum: page,
    pipelineNumber: pipeline
  }
});

describe('reopened PDF weld sequence', () => {
  test('rebuilds numbered welds from embedded annotation metadata', () => {
    const result = buildReopenedWeldSequence([
      annotation('a1', 1, 1),
      annotation('a2', 1, 2),
      annotation('a3', 2, 3),
      { id: 'plain-text', page: 1, text: 'NOTE' }
    ], 1);
    expect(result.welds.map(weld => [weld.sourceAnnotationId, weld.weldNumber])).toEqual([
      ['a1', 1], ['a2', 2], ['a3', 3]
    ]);
    expect(result.pageRange).toEqual({ startPage: 1, endPage: 2 });
    expect(result.batchRunId).toBe('batch-a');
  });

  test('does not treat an annotation without an original weld center as recoverable', () => {
    expect(isRecoverableWeldAnnotation({ text: 'F12', weldData: { weldNumber: 12 } })).toBe(false);
  });

  test('recovers a legacy visible weld annotation without weldData', () => {
    const legacy = {
      id: 'legacy-1', page: 3, text: 'F7', startX: 120, startY: 240,
      endX: 160, endY: 240, borderShape: 'split-circle', hasLeaderLine: true,
      pipelineNumber: 'PIPE-A', frameSize: 56.7
    };
    expect(isRecoverableWeldAnnotation(legacy)).toBe(true);
    const result = buildReopenedWeldSequence([legacy], 3);
    expect(result.welds[0]).toMatchObject({
      sourceAnnotationId: 'legacy-1', weldNumber: 7, center: { x: 60, y: 120 }
    });
  });

  test('recovers diamond welds but excludes non-weld frames, empty frames, and supports', () => {
    const base = {
      page: 1, text: 'F8A', startX: 100, startY: 120,
      endX: 140, endY: 120, hasLeaderLine: true, pipelineNumber: 'PIPE-A'
    };
    expect(isRecoverableWeldAnnotation({ ...base, id: 'diamond', borderShape: 'diamond' })).toBe(true);
    expect(isRecoverableWeldAnnotation({ ...base, id: 'pipe-tag', borderShape: 'pipe-tag' })).toBe(false);
    expect(isRecoverableWeldAnnotation({ ...base, id: 'rectangle', borderShape: 'text-rectangle' })).toBe(false);
    expect(isRecoverableWeldAnnotation({ ...base, id: 'none', borderShape: 'none' })).toBe(false);
    expect(isRecoverableWeldAnnotation({ ...base, id: 'pipe-tag-meta', borderShape: 'pipe-tag', weldData: { weldNumber: 8 } })).toBe(false);
    expect(isRecoverableWeldAnnotation({ ...base, id: 'empty', text: '', borderShape: 'circle', weldData: { weldNumber: 8 } })).toBe(false);
    expect(isRecoverableWeldAnnotation({ ...base, id: 'support', borderShape: 'circle', isWeldedSupport: true })).toBe(false);
  });

  test('uses the visible leader start instead of stale embedded center', () => {
    const visible = annotation('a1', 1, 1);
    visible.startX = 400;
    visible.startY = 600;
    visible.weldData.center = { x: 999, y: 999 };
    const result = buildReopenedWeldSequence([visible], 1);
    expect(result.welds[0].center).toEqual({ x: 200, y: 300 });
  });

  test('uses a leaderless weld frame itself as the blue-circle selection position', () => {
    const leaderless = {
      id: 'plain-circle', page: 2, text: 'F8', startX: 100, startY: 120,
      endX: 180, endY: 220, borderShape: 'circle', hasLeaderLine: false
    };
    expect(isRecoverableWeldAnnotation(leaderless)).toBe(true);
    const result = buildReopenedWeldSequence([leaderless], 2);
    expect(result.welds[0].center).toEqual({ x: 90, y: 110 });
  });

  test('recovers all historical batches so a pipeline numbering chain is not truncated', () => {
    const result = buildReopenedWeldSequence([
      annotation('a1', 1, 1, 'PIPE-A', 'batch-a'),
      annotation('a2', 1, 2, 'PIPE-A', 'batch-a'),
      annotation('b1', 8, 1, 'PIPE-B', 'batch-b')
    ], 8);
    expect(result.batchRunId).toBe('batch-b');
    expect(result.welds).toHaveLength(3);
    expect(result.welds.map(weld => weld.sourceAnnotationId)).toEqual(['a1', 'a2', 'b1']);
    expect(result.skippedBatchCount).toBe(0);
  });

  test('reuses display and split-circle content for the supplemental point', () => {
    const sequence = buildReopenedWeldSequence([annotation('a1', 1, 1)], 1).welds;
    const rule = buildReopenedAnnotationRule(sequence, 1);
    expect(rule.prefix).toBe('F');
    expect(rule.borderShape).toBe('split-circle');
    expect(rule.batchContent.manualDiameter).toBe('4');
    expect(rule.batchContent.manualJointType).toBe('BW');
    expect(findReopenedWeldTemplate(sequence, 1, 'PIPE-A', 2)?.sourceAnnotationId).toBe('a1');
  });

  test('finds the nearest same-pipeline template when the insert page has no weld', () => {
    const sequence = buildReopenedWeldSequence([
      annotation('a1', 10, 7, 'PIPE-A'),
      annotation('a2', 12, 9, 'PIPE-A'),
      annotation('b1', 11, 1, 'PIPE-B')
    ], 11).welds;
    expect(findReopenedWeldTemplate(sequence, 11, 'PIPE-A', 8)?.sourceAnnotationId).toBe('a1');
  });

  test('uses the spatially nearest same-page label as the insertion affix template', () => {
    const f = { ...annotation('f', 5, 5, 'PIPE-A'), text: 'F5', frameSize: 48, weldData: { ...annotation('f', 5, 5, 'PIPE-A').weldData, center: { x: 20, y: 20 } } };
    const e = { ...annotation('e', 5, 5, 'PIPE-A'), text: 'E5', frameSize: 64, weldData: { ...annotation('e', 5, 5, 'PIPE-A').weldData, center: { x: 200, y: 200 } } };
    const sequence = buildReopenedWeldSequence([f, e], 5).welds;
    const template = findReopenedWeldTemplate(sequence, 5, 'PIPE-A', 5, { x: 190, y: 190 });
    expect(template?.displayNumber).toBe('E5');
    expect(template?.annotationFrameSize).toBe(64);
  });

  test('continues only overlapping page ranges of the same pipeline', () => {
    const result = repairReopenedPageNumberingContinuity([
      { page: 1, pipelineNumber: 'PIPE-A', weldNumber: 1, number: 1, displayNumber: 'F1' },
      { page: 1, pipelineNumber: 'PIPE-A', weldNumber: 3, number: 3, displayNumber: 'F3' },
      { page: 2, pipelineNumber: 'PIPE-A', weldNumber: 1, number: 1, displayNumber: 'F1' },
      { page: 2, pipelineNumber: 'PIPE-A', weldNumber: 2, number: 2, displayNumber: 'F2' },
      { page: 3, pipelineNumber: 'PIPE-A', weldNumber: 52, number: 52, displayNumber: 'F52' },
      { page: 2, pipelineNumber: 'PIPE-B', weldNumber: 1, number: 1, displayNumber: 'F1' }
    ]);
    expect(result.welds.map(weld => weld.weldNumber)).toEqual([1, 3, 4, 5, 52, 1]);
    expect(result.welds[2].displayNumber).toBe('F4');
    expect(result.adjustedCount).toBe(2);
  });

  test('uses embedded annotation pipeline metadata across more than three pages', () => {
    const welds = [
      { page: 10, pipelineNumber: 'PIPE-A', weldNumber: 1 },
      { page: 11, pipelineNumber: 'PIPE-A', weldNumber: 2 },
      { page: 14, pipelineNumber: 'PIPE-A', weldNumber: 5 },
      { page: 15, pipelineNumber: 'PIPE-A', weldNumber: 6 },
      { page: 16, pipelineNumber: 'PIPE-B', weldNumber: 1 }
    ];
    const result = resolvePipelineFromWeldAnnotations({
      welds,
      currentPage: 12,
      currentPipelineNumber: 'PIPE-A'
    });

    expect(result.status).toBe('resolved');
    expect(result.pipelineNumber).toBe('PIPE-A');
    expect(result.matchedPages).toEqual([10, 11, 14, 15]);
  });

  test('infers an empty page only when nearest annotation pages agree', () => {
    const same = resolvePipelineFromWeldAnnotations({
      welds: [
        { page: 4, pipelineNumber: 'PIPE-A', weldNumber: 8 },
        { page: 6, pipelineNumber: '', weldNumber: 9 },
        { page: 7, pipelineNumber: '', weldNumber: 10 },
        { page: 9, pipelineNumber: 'PIPE-A', weldNumber: 12 }
      ],
      currentPage: 7
    });
    const conflict = resolvePipelineFromWeldAnnotations({
      welds: [
        { page: 4, pipelineNumber: 'PIPE-A', weldNumber: 8 },
        { page: 9, pipelineNumber: 'PIPE-B', weldNumber: 1 }
      ],
      currentPage: 7
    });

    expect(same).toMatchObject({ status: 'resolved', pipelineNumber: 'PIPE-A', matchedPages: [4, 6, 7, 9] });
    expect(conflict.status).toBe('unresolved');
    expect(conflict.candidates).toEqual(['PIPE-A', 'PIPE-B']);
  });

  test('fills welds missing pipeline metadata on a page with a confirmed annotation pipeline', () => {
    const result = resolvePipelineFromWeldAnnotations({
      welds: [
        { page: 20, pipelineNumber: 'PIPE-A', weldNumber: 1 },
        { page: 20, pipelineNumber: '', weldNumber: 2 },
        { page: 21, pipelineNumber: 'PIPE-A', weldNumber: 3 }
      ],
      currentPage: 20
    });

    expect(result).toMatchObject({
      status: 'resolved',
      pipelineNumber: 'PIPE-A',
      matchedPages: [20, 21]
    });
  });
});
