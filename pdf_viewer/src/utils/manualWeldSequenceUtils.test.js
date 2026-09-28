import {
  assignCompactWeldNumbers,
  applyFixedManualWeldNumbers,
  bindPipelineToMatchingPages,
  buildCrossPageNumberingScopes,
  getPageScopedNumberingSegmentPatternKey,
  getOverlappingSegmentIndexes,
  insertManualWeldIntoSequence,
  moveWeldRangeInSequence,
  removeManualWeldFromSequence,
  removeWeldFromSequence,
  removeWeldsFromSequence,
  resolveManualInsertContext,
  resolvePipelineNumberConflicts,
  reserveManualInsertNumber
} from './manualWeldSequenceUtils';

const weld = (id, page, pipelineNumber, number) => ({
  id,
  page,
  pageNum: page,
  pipelineNumber,
  weldNumber: number,
  number,
  displayNumber: `F${number}`
});

describe('manual weld sequence', () => {
  const source = [
    weld('a1', 1, 'PIPE-A', 1),
    weld('a2', 1, 'PIPE-A', 2),
    weld('a3', 2, 'PIPE-A', 3),
    weld('a4', 2, 'PIPE-A', 4),
    weld('b1', 3, 'PIPE-B', 1),
    weld('b2', 3, 'PIPE-B', 2)
  ];

  test('insertion shifts only the same pipeline across later pages', () => {
    const result = insertManualWeldIntoSequence({
      welds: source,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 2,
      manualWeld: { id: 'manual-1', manualInsertId: 'manual-1', isManualInserted: true }
    });

    expect(result.welds.map(item => [item.id, item.weldNumber])).toEqual([
      ['a1', 1],
      ['manual-1', 2],
      ['a2', 3],
      ['a3', 4],
      ['a4', 5],
      ['b1', 1],
      ['b2', 2]
    ]);
    expect(result.welds.find(item => item.id === 'manual-1').displayNumber).toBe('F2');
  });

  test('insertion and rollback preserve every prefix and suffix character', () => {
    const prefixed = [
      { ...weld('a1', 1, 'PIPE-A', 11), displayNumber: 'AREA2-F11-R1' },
      { ...weld('a2', 1, 'PIPE-A', 12), displayNumber: 'AREA2-F12-R1' }
    ];
    const inserted = insertManualWeldIntoSequence({
      welds: prefixed,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 12,
      manualWeld: { id: 'manual-prefix', manualInsertId: 'manual-prefix', isManualInserted: true }
    });
    expect(inserted.welds.find(item => item.id === 'a2').displayNumber).toBe('AREA2-F13-R1');
    expect(inserted.welds.find(item => item.id === 'manual-prefix').displayNumber).toBe('AREA2-F12-R1');

    const rolledBack = removeManualWeldFromSequence({
      welds: inserted.welds,
      manualInsertId: 'manual-prefix'
    });
    expect(rolledBack.welds.find(item => item.id === 'a2').displayNumber).toBe('AREA2-F12-R1');
  });

  test('insertion shifts only welds with the same prefix and suffix', () => {
    const mixed = [
      { ...weld('f1', 1, 'PIPE-A', 1), displayNumber: 'F1-A' },
      { ...weld('f2', 1, 'PIPE-A', 2), displayNumber: 'F2-A' },
      { ...weld('e1', 1, 'PIPE-A', 1), displayNumber: 'E1' },
      { ...weld('e2', 1, 'PIPE-A', 2), displayNumber: 'E2' }
    ];
    const result = insertManualWeldIntoSequence({
      welds: mixed,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 2,
      manualWeld: {
        id: 'manual-f', manualInsertId: 'manual-f', isManualInserted: true,
        numberingAffixKey: '["F","-A"]', displayNumber: 'F1-A'
      }
    });
    expect(result.welds.find(item => item.id === 'f2').displayNumber).toBe('F3-A');
    expect(result.welds.find(item => item.id === 'manual-f').displayNumber).toBe('F2-A');
    expect(result.welds.find(item => item.id === 'e2').displayNumber).toBe('E2');
  });

  test('continuous insertion preserves click order and exact numbers', () => {
    const first = insertManualWeldIntoSequence({
      welds: source,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 2,
      manualWeld: { id: 'manual-1', manualInsertId: 'manual-1', isManualInserted: true }
    });
    const second = insertManualWeldIntoSequence({
      welds: first.welds,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 3,
      manualWeld: { id: 'manual-2', manualInsertId: 'manual-2', isManualInserted: true }
    });

    expect(second.welds.slice(0, 4).map(item => [item.id, item.weldNumber])).toEqual([
      ['a1', 1],
      ['manual-1', 2],
      ['manual-2', 3],
      ['a2', 4]
    ]);
  });

  test('rapid insertion reserves a new number before the rendered maximum catches up', () => {
    let cursor = 13;
    const reserved = Array.from({ length: 5 }, () => {
      const result = reserveManualInsertNumber({
        cursorValue: cursor,
        minNumber: 1,
        // 模拟界面仍停留在旧的最大序号 12。
        fallbackNumber: 13
      });
      cursor = result.nextCursorValue;
      return result.insertNumber;
    });

    expect(reserved).toEqual([13, 14, 15, 16, 17]);
    expect(cursor).toBe(18);
  });

  test('insertion may target a number before the current page range', () => {
    const currentPage = Array.from({ length: 7 }, (_, index) => (
      weld(`p1-${56 + index}`, 1, 'PIPE-A', 56 + index)
    ));
    const reserved = reserveManualInsertNumber({
      cursorValue: 47,
      minNumber: 1,
      fallbackNumber: 63
    });
    expect(reserved.insertNumber).toBe(47);

    const result = insertManualWeldIntoSequence({
      welds: currentPage,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: reserved.insertNumber,
      manualWeld: { id: 'manual-47', manualInsertId: 'manual-47', isManualInserted: true }
    });
    expect(result.welds.find(item => item.id === 'manual-47')).toEqual(expect.objectContaining({
      weldNumber: 47,
      manualRequestedNumber: 47
    }));
    expect(result.welds.find(item => item.id === 'p1-56').weldNumber).toBe(57);
    expect(result.welds.find(item => item.id === 'p1-62').weldNumber).toBe(63);
  });

  test('empty page inherits the same pipeline continuation and remains freely insertable', () => {
    const scoped = [
      { ...weld('a1', 1, 'PIPE-A', 1), numberingScopeKey: 'PIPE-A__PAGE_CHAIN_1' },
      { ...weld('a2', 1, 'PIPE-A', 2), numberingScopeKey: 'PIPE-A__PAGE_CHAIN_1' },
      { ...weld('a3', 3, 'PIPE-A', 3), numberingScopeKey: 'PIPE-A__PAGE_CHAIN_1' },
      { ...weld('b1', 4, 'PIPE-B', 1), numberingScopeKey: 'PIPE-B__PAGE_CHAIN_4' }
    ];
    const context = resolveManualInsertContext({
      welds: scoped,
      pageNum: 2,
      pipelineNumber: 'PIPE-A',
      fallbackStartNumber: 1
    });

    expect(context).toEqual(expect.objectContaining({
      pipelineNumber: 'PIPE-A',
      numberingScopeKey: 'PIPE-A__PAGE_CHAIN_1',
      suggestedNumber: 3
    }));

    const result = insertManualWeldIntoSequence({
      welds: scoped,
      pageNum: 2,
      pipelineNumber: context.pipelineNumber,
      numberingScopeKey: context.numberingScopeKey,
      insertNumber: 3,
      manualWeld: { id: 'manual-empty', manualInsertId: 'manual-empty', isManualInserted: true }
    });
    expect(result.welds.map(item => [item.id, item.page, item.weldNumber])).toEqual([
      ['a1', 1, 1],
      ['a2', 1, 2],
      ['manual-empty', 2, 3],
      ['a3', 3, 4],
      ['b1', 4, 1]
    ]);
  });

  test('empty page only infers a missing pipeline when both adjacent sides agree', () => {
    const samePipeline = [
      weld('a1', 1, 'PIPE-A', 5),
      weld('a2', 3, 'PIPE-A', 6)
    ];
    expect(resolveManualInsertContext({
      welds: samePipeline,
      pageNum: 2,
      pipelineNumber: ''
    })).toEqual(expect.objectContaining({
      pipelineNumber: 'PIPE-A',
      suggestedNumber: 6,
      inferredPipeline: true
    }));

    const differentPipelines = [
      weld('a1', 1, 'PIPE-A', 5),
      weld('b1', 3, 'PIPE-B', 1)
    ];
    expect(resolveManualInsertContext({
      welds: differentPipelines,
      pageNum: 2,
      pipelineNumber: '',
      fallbackStartNumber: 7
    })).toEqual(expect.objectContaining({
      pipelineNumber: '',
      suggestedNumber: 7,
      inferredPipeline: false
    }));
  });

  test('undo restores only the affected pipeline', () => {
    const inserted = insertManualWeldIntoSequence({
      welds: source,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 2,
      manualWeld: { id: 'manual-1', manualInsertId: 'manual-1', isManualInserted: true }
    });
    const removed = removeManualWeldFromSequence({
      welds: inserted.welds,
      manualInsertId: 'manual-1'
    });

    expect(removed.welds.map(item => [item.id, item.weldNumber])).toEqual(
      source.map(item => [item.id, item.weldNumber])
    );
  });

  test('deleting an existing weld shifts only later regular welds in the same pipeline', () => {
    const withSupport = [
      ...source,
      { ...weld('support', 2, 'PIPE-A', 601), isWeldedSupport: true, numberingScopeKey: '__SUPPORT_PIPE-A' }
    ];
    const result = removeWeldFromSequence({
      welds: withSupport,
      weldKey: 'a2',
      getWeldKey: item => item.id
    });

    expect(result.removedNumber).toBe(2);
    expect(result.welds.map(item => [item.id, item.weldNumber])).toEqual([
      ['a1', 1],
      ['a3', 2],
      ['a4', 3],
      ['b1', 1],
      ['b2', 2],
      ['support', 601]
    ]);
  });

  test('deleting an existing weld shifts only the matching affix sequence', () => {
    const mixed = [
      { ...weld('f1', 1, 'PIPE-A', 1), displayNumber: 'F1-A' },
      { ...weld('f2', 1, 'PIPE-A', 2), displayNumber: 'F2-A' },
      { ...weld('e1', 1, 'PIPE-A', 1), displayNumber: 'E1' },
      { ...weld('e2', 1, 'PIPE-A', 2), displayNumber: 'E2' }
    ];
    const result = removeWeldFromSequence({
      welds: mixed,
      weldKey: 'e1',
      getWeldKey: item => item.id
    });
    expect(result.welds.find(item => item.id === 'e2').displayNumber).toBe('E1');
    expect(result.welds.find(item => item.id === 'f2').displayNumber).toBe('F2-A');
  });

  test('support weld cannot be removed by the regular weld delete helper', () => {
    const support = { ...weld('support', 1, 'PIPE-A', 601), isWeldedSupport: true };
    const result = removeWeldFromSequence({
      welds: [support],
      weldKey: 'support',
      getWeldKey: item => item.id
    });
    expect(result.removedIndex).toBe(-1);
    expect(result.welds).toHaveLength(1);
  });

  test('batch deletion removes all selected welds and renumbers once from the original snapshot', () => {
    const result = removeWeldsFromSequence({
      welds: source,
      weldKeys: ['a2', 'a3'],
      getWeldKey: item => item.id
    });
    expect(result.removedNumbers).toEqual([2, 3]);
    expect(result.welds.map(item => [item.id, item.weldNumber])).toEqual([
      ['a1', 1],
      ['a4', 2],
      ['b1', 1],
      ['b2', 2]
    ]);
  });

  test('batch deletion keeps pipelines, affixes and support numbering independent', () => {
    const mixed = [
      { ...weld('f1', 1, 'PIPE-A', 1), displayNumber: 'F1-A' },
      { ...weld('f2', 1, 'PIPE-A', 2), displayNumber: 'F2-A' },
      { ...weld('f3', 2, 'PIPE-A', 3), displayNumber: 'F3-A' },
      { ...weld('e1', 1, 'PIPE-A', 1), displayNumber: 'E1' },
      { ...weld('e2', 2, 'PIPE-A', 2), displayNumber: 'E2' },
      { ...weld('b1', 3, 'PIPE-B', 1), displayNumber: 'F1-A' },
      { ...weld('support', 2, 'PIPE-A', 601), isWeldedSupport: true }
    ];
    const result = removeWeldsFromSequence({
      welds: mixed,
      weldKeys: ['f1', 'e1', 'support'],
      getWeldKey: item => item.id
    });
    expect(result.removedWelds.map(item => item.id)).toEqual(['f1', 'e1']);
    expect(result.welds.find(item => item.id === 'f2').displayNumber).toBe('F1-A');
    expect(result.welds.find(item => item.id === 'f3').displayNumber).toBe('F2-A');
    expect(result.welds.find(item => item.id === 'e2').displayNumber).toBe('E1');
    expect(result.welds.find(item => item.id === 'b1').displayNumber).toBe('F1-A');
    expect(result.welds.find(item => item.id === 'support').weldNumber).toBe(601);
  });

  test('unresolved pipeline insertion affects current page only', () => {
    const unresolved = [
      weld('u1', 1, '', 1),
      weld('u2', 1, '', 2),
      weld('v1', 2, '', 1),
      weld('v2', 2, '', 2)
    ];
    const result = insertManualWeldIntoSequence({
      welds: unresolved,
      pageNum: 1,
      pipelineNumber: '',
      insertNumber: 2,
      manualWeld: { id: 'manual-u', manualInsertId: 'manual-u', isManualInserted: true }
    });

    expect(result.welds.map(item => [item.id, item.weldNumber])).toEqual([
      ['u1', 1],
      ['manual-u', 2],
      ['u2', 3],
      ['v1', 1],
      ['v2', 2]
    ]);
  });

  test('manual number remains fixed even when correction order puts it last', () => {
    const original = Array.from({ length: 16 }, (_, index) => (
      weld(`w${index + 1}`, 1, 'PIPE-A', index + 1)
    ));
    const inserted = insertManualWeldIntoSequence({
      welds: original,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 5,
      manualWeld: {
        id: 'manual-5',
        manualInsertId: 'manual-5',
        isManualInserted: true
      }
    });
    const manualAtEnd = [
      ...inserted.welds.filter(item => !item.isManualInserted),
      inserted.welds.find(item => item.isManualInserted)
    ];
    const result = applyFixedManualWeldNumbers({
      orderedWelds: manualAtEnd,
      numberSlots: inserted.welds
    });

    expect(result).toHaveLength(17);
    expect(result[4].id).toBe('manual-5');
    expect(result[4].weldNumber).toBe(5);
    expect(result[result.length - 1].weldNumber).toBe(17);
  });

  test('moves a selected range before or after a target number', () => {
    const welds = [1, 2, 3, 4, 5].map(number => ({
      pathId: number,
      weldNumber: number
    }));
    const range = [welds[3], welds[4]];

    expect(moveWeldRangeInSequence({
      welds,
      rangeWelds: range,
      targetNumber: 2,
      position: 'before',
      getKey: item => item.pathId
    }).map(item => item.pathId)).toEqual([1, 4, 5, 2, 3]);

    expect(moveWeldRangeInSequence({
      welds,
      rangeWelds: range,
      targetNumber: 2,
      position: 'after',
      getKey: item => item.pathId
    }).map(item => item.pathId)).toEqual([1, 2, 4, 5, 3]);
  });

  test('detects overlapping correction segments on the same page', () => {
    const segments = [
      { page: 2, sourceRangeWelds: [{ pathId: 3 }, { pathId: 4 }] },
      { page: 3, sourceRangeWelds: [{ pathId: 4 }] }
    ];
    expect(getOverlappingSegmentIndexes({
      segments,
      rangeWelds: [{ pathId: 4 }, { pathId: 5 }],
      pageNum: 2,
      getKey: item => item.pathId
    })).toEqual([0]);
  });

  test('numberless segment fallback patterns are isolated by page', () => {
    const pageOneSegment = {
      page: 1,
      startOrderIndex: 1,
      endOrderIndex: 2,
      startPathId: 5,
      endPathId: 8
    };
    const pageTwoSamePositions = {
      ...pageOneSegment,
      page: 2
    };

    expect(getPageScopedNumberingSegmentPatternKey(pageOneSegment))
      .not.toBe(getPageScopedNumberingSegmentPatternKey(pageTwoSamePositions));
  });

  test('forces a segment start number and continues downward', () => {
    const sourceWelds = [1, 2, 3, 4, 5].map(pathId => ({
      pathId,
      page: 1,
      pipelineNumber: 'P-1',
      weldNumber: pathId,
      number: pathId
    }));

    const result = assignCompactWeldNumbers({
      welds: sourceWelds,
      startNumber: 1,
      forcedStarts: [{ key: 2, startNumber: 3 }],
      getKey: item => item.pathId,
      getScopeKey: item => item.pipelineNumber
    });

    expect(result.welds.map(item => item.number)).toEqual([1, 3, 4, 5, 6]);
  });

  test('numberless welds do not consume cross-page sequence slots', () => {
    const sourceWelds = [
      ...Array.from({ length: 15 }, (_, index) => ({
        pathId: `p1-${index + 1}`,
        page: 1,
        pipelineNumber: 'P-1'
      })),
      { pathId: 'p2-1', page: 2, pipelineNumber: 'P-1' }
    ];

    const result = assignCompactWeldNumbers({
      welds: sourceWelds,
      hiddenKeys: new Set(['p1-4', 'p1-9']),
      startNumber: 1,
      getKey: item => item.pathId,
      getScopeKey: item => item.pipelineNumber
    });

    expect(result.welds).toHaveLength(14);
    expect(result.welds.find(item => item.pathId === 'p2-1').number).toBe(14);
  });

  test('normal welds clear stale numberless preview flags during rebuild', () => {
    const result = assignCompactWeldNumbers({
      welds: [{
        pathId: 'normal-1',
        page: 1,
        pipelineNumber: 'P-1',
        isNumberless: true,
        number: '',
        weldNumber: null
      }],
      startNumber: 1,
      getKey: item => item.pathId,
      getScopeKey: item => item.pipelineNumber
    });

    expect(result.welds[0]).toEqual(expect.objectContaining({
      number: 1,
      weldNumber: 1,
      isNumberless: false
    }));
  });

  test('two numberless welds compress the next page from 11 to 9 for the same pipeline', () => {
    const sourceWelds = [
      ...Array.from({ length: 10 }, (_, index) => ({
        pathId: `p1-${index + 1}`,
        page: 1,
        pageNum: 1,
        pipelineNumber: 'PIPE-A',
        weldNumber: index + 1,
        number: index + 1
      })),
      {
        pathId: 'p2-1',
        page: 2,
        pageNum: 2,
        pipelineNumber: 'PIPE-A',
        weldNumber: 11,
        number: 11
      }
    ];
    const scopes = buildCrossPageNumberingScopes({
      welds: sourceWelds,
      explicitPipelineByPage: {
        1: 'PIPE-A',
        2: 'PIPE-A'
      }
    });
    const scopedWelds = sourceWelds.map(item => ({
      ...item,
      numberingScopeKey: scopes.get(item.page).scopeKey
    }));
    const result = assignCompactWeldNumbers({
      welds: scopedWelds,
      hiddenKeys: new Set(['p1-2', 'p1-7']),
      startNumber: 1,
      getKey: item => item.pathId,
      getScopeKey: item => item.numberingScopeKey
    });

    expect(scopes.get(1).scopeKey).toBe(scopes.get(2).scopeKey);
    expect(result.welds).toHaveLength(9);
    expect(result.welds.find(item => item.pathId === 'p2-1').number).toBe(9);
  });

  test('a different explicit pipeline starts a new numbering scope from the configured start', () => {
    const sourceWelds = [
      ...Array.from({ length: 10 }, (_, index) => weld(`a-${index + 1}`, 1, 'PIPE-A', index + 1)),
      weld('b-1', 2, 'PIPE-B', 11)
    ];
    const scopes = buildCrossPageNumberingScopes({
      welds: sourceWelds,
      explicitPipelineByPage: {
        1: 'PIPE-A',
        2: 'PIPE-B'
      }
    });
    const scopedWelds = sourceWelds.map(item => ({
      ...item,
      numberingScopeKey: scopes.get(item.page).scopeKey
    }));
    const result = assignCompactWeldNumbers({
      welds: scopedWelds,
      startNumber: 1,
      getKey: item => item.id,
      getScopeKey: item => item.numberingScopeKey,
      getScopeStartNumber: scopeKey => (
        scopeKey === scopes.get(2).scopeKey && scopes.get(2).resetToStartNumber
          ? 1
          : 1
      )
    });

    expect(scopes.get(1).scopeKey).not.toBe(scopes.get(2).scopeKey);
    expect(scopes.get(2).resetToStartNumber).toBe(true);
    expect(result.welds.find(item => item.id === 'b-1').number).toBe(1);
  });

  test('manual insertion overrides a corrected sequence and shifts every later page number', () => {
    const corrected = [
      weld('c1', 1, 'PIPE-A', 3),
      weld('c2', 1, 'PIPE-A', 4),
      weld('c3', 1, 'PIPE-A', 5),
      weld('c4', 2, 'PIPE-A', 6)
    ];
    const result = insertManualWeldIntoSequence({
      welds: corrected,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      insertNumber: 4,
      manualWeld: {
        id: 'manual-4',
        manualInsertId: 'manual-4',
        isManualInserted: true
      }
    });

    expect(result.welds.map(item => [item.id, item.number])).toEqual([
      ['c1', 3],
      ['manual-4', 4],
      ['c2', 5],
      ['c3', 6],
      ['c4', 7]
    ]);
  });

  test('same pipeline shifts across stale historical scope keys and rolls back after removal', () => {
    const historical = [
      { ...weld('p1-1', 1, 'PIPE-A', 1), numberingScopeKey: 'old-batch-page-1' },
      { ...weld('p2-2', 2, 'PIPE-A', 2), numberingScopeKey: 'old-batch-page-2' },
      { ...weld('p3-3', 3, 'PIPE-A', 3), numberingScopeKey: 'another-batch' },
      { ...weld('other-2', 3, 'PIPE-B', 2), numberingScopeKey: 'old-batch-page-2' },
      { ...weld('support', 3, 'PIPE-A', 601), numberingScopeKey: '__SUPPORT_PIPE-A', isWeldedSupport: true }
    ];
    const inserted = insertManualWeldIntoSequence({
      welds: historical,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      numberingScopeKey: 'old-batch-page-1',
      insertNumber: 2,
      manualWeld: { id: 'manual-2', manualInsertId: 'manual-2', isManualInserted: true }
    });

    expect(inserted.welds.find(item => item.id === 'p2-2').number).toBe(3);
    expect(inserted.welds.find(item => item.id === 'p3-3').number).toBe(4);
    expect(inserted.welds.find(item => item.id === 'other-2').number).toBe(2);
    expect(inserted.welds.find(item => item.id === 'support').number).toBe(601);

    const removed = removeManualWeldFromSequence({
      welds: inserted.welds,
      manualInsertId: 'manual-2'
    });
    expect(removed.welds.find(item => item.id === 'p2-2').number).toBe(2);
    expect(removed.welds.find(item => item.id === 'p3-3').number).toBe(3);
    expect(removed.welds.find(item => item.id === 'other-2').number).toBe(2);
    expect(removed.welds.find(item => item.id === 'support').number).toBe(601);
  });

  test('continuous pages inherit the same numbering scope when later pipeline OCR is missing', () => {
    const crossPage = [
      weld('p1-1', 1, 'PIPE-A', 1),
      weld('p1-2', 1, 'PIPE-A', 2),
      weld('p2-1', 2, '', 3),
      weld('p2-2', 2, '', 4),
      weld('p3-1', 3, '', 5)
    ];
    const scopes = buildCrossPageNumberingScopes({
      welds: crossPage,
      explicitPipelineByPage: { 1: 'PIPE-A', 2: '', 3: '' }
    });

    expect(scopes.get(1).scopeKey).toBe(scopes.get(2).scopeKey);
    expect(scopes.get(2).scopeKey).toBe(scopes.get(3).scopeKey);
    expect(scopes.get(2).pipelineNumber).toBe('PIPE-A');
  });

  test('manual insertion shifts continuous later pages through an inherited scope key', () => {
    const scoped = [
      { ...weld('p1-1', 1, 'PIPE-A', 1), numberingScopeKey: 'PIPE-A' },
      { ...weld('p1-2', 1, 'PIPE-A', 2), numberingScopeKey: 'PIPE-A' },
      { ...weld('p2-1', 2, '', 3), numberingScopeKey: 'PIPE-A' },
      { ...weld('p2-2', 2, '', 4), numberingScopeKey: 'PIPE-A' },
      { ...weld('p3-1', 3, '', 5), numberingScopeKey: 'PIPE-A' }
    ];
    const result = insertManualWeldIntoSequence({
      welds: scoped,
      pageNum: 2,
      pipelineNumber: '',
      numberingScopeKey: 'PIPE-A',
      insertNumber: 4,
      manualWeld: {
        id: 'manual-p2',
        manualInsertId: 'manual-p2',
        isManualInserted: true,
        numberingScopeKey: 'PIPE-A'
      }
    });

    expect(result.welds.map(item => [item.id, item.number])).toEqual([
      ['p1-1', 1],
      ['p1-2', 2],
      ['p2-1', 3],
      ['manual-p2', 4],
      ['p2-2', 5],
      ['p3-1', 6]
    ]);
  });

  test('recognized adjacent pipeline binds legacy welds before insertion shifts them', () => {
    const legacy = [
      { ...weld('previous-other', 137, 'PIPE-OLD', 63), numberingScopeKey: 'PIPE-OLD' },
      { ...weld('next-8', 139, '', 8), numberingScopeKey: '__PAGE_139' },
      { ...weld('next-9', 139, '', 9), numberingScopeKey: '__PAGE_139' },
      { ...weld('different', 140, 'PIPE-OTHER', 8), numberingScopeKey: 'PIPE-OTHER' }
    ];
    const bound = bindPipelineToMatchingPages({
      welds: legacy,
      pipelineNumber: 'PIPE-NEW',
      anchorPage: 138,
      matchedPages: [139],
      getPagePipeline: page => page === 139 ? 'PIPE-NEW' : ''
    });
    const result = insertManualWeldIntoSequence({
      welds: bound,
      pageNum: 138,
      pipelineNumber: 'PIPE-NEW',
      numberingScopeKey: 'PIPE-NEW',
      insertNumber: 8,
      manualWeld: { id: 'manual-8', manualInsertId: 'manual-8', isManualInserted: true }
    });

    expect(result.welds.map(item => [item.id, item.number])).toEqual([
      ['previous-other', 63],
      ['manual-8', 8],
      ['next-8', 9],
      ['next-9', 10],
      ['different', 8]
    ]);
    expect(result.welds.find(item => item.id === 'next-8').pipelineNumber).toBe('PIPE-NEW');
  });

  test('validated sheet pages bind trailing unrecognized pages before batch deletion', () => {
    const eightPageLine = Array.from({ length: 8 }, (_, index) => ({
      ...weld(`page-${index + 1}`, index + 1, index < 6 ? 'PIPE-A' : '', index + 1),
      numberingScopeKey: index < 6 ? 'PIPE-A' : `__PAGE_${index + 1}`
    }));
    const bound = bindPipelineToMatchingPages({
      welds: eightPageLine,
      pipelineNumber: 'PIPE-A',
      anchorPage: 2,
      matchedPages: [1, 2, 3, 4, 5, 6, 7, 8],
      getPagePipeline: page => page <= 6 ? 'PIPE-A' : ''
    });
    const result = removeWeldsFromSequence({
      welds: bound,
      weldKeys: ['page-2'],
      getWeldKey: item => item.id
    });

    expect(bound.filter(item => item.pipelineNumber === 'PIPE-A')).toHaveLength(8);
    expect(result.welds.find(item => item.id === 'page-7').weldNumber).toBe(6);
    expect(result.welds.find(item => item.id === 'page-8').weldNumber).toBe(7);
  });

  test('pipeline binding never overwrites a different explicit pipeline or support scope', () => {
    const explicit = { ...weld('explicit', 2, 'PIPE-B', 5), numberingScopeKey: 'PIPE-B' };
    const support = {
      ...weld('support', 2, '', 601),
      numberingScopeKey: '__SUPPORT_PIPE-A',
      isWeldedSupport: true
    };
    const result = bindPipelineToMatchingPages({
      welds: [explicit, support],
      pipelineNumber: 'PIPE-A',
      anchorPage: 2,
      matchedPages: [2],
      getPagePipeline: () => 'PIPE-A'
    });

    expect(result[0]).toEqual(explicit);
    expect(result[1]).toEqual(support);
  });

  test('a numbering reset starts a new fallback scope instead of joining unrelated pages', () => {
    const resetPages = [
      weld('a1', 1, '', 1),
      weld('a2', 1, '', 2),
      weld('b1', 2, '', 1),
      weld('b2', 2, '', 2)
    ];
    const scopes = buildCrossPageNumberingScopes({ welds: resetPages });

    expect(scopes.get(1).scopeKey).not.toBe(scopes.get(2).scopeKey);
  });

  test('edited numbers win and conflicting unedited welds move forward deterministically', () => {
    const sourceWelds = [
      { ...weld('ordinary-1', 1, 'PIPE-A', 1), numberingScopeKey: 'PIPE-A' },
      { ...weld('ordinary-2', 1, 'PIPE-A', 2), numberingScopeKey: 'PIPE-A' },
      { ...weld('ordinary-3', 1, 'PIPE-A', 3), numberingScopeKey: 'PIPE-A' },
      { ...weld('edited-3', 1, 'PIPE-A', 3), numberingScopeKey: 'PIPE-A', isNumberingEdited: true },
      { ...weld('edited-4', 1, 'PIPE-A', 4), numberingScopeKey: 'PIPE-A', isNumberingEdited: true },
      { ...weld('ordinary-4', 2, 'PIPE-A', 4), numberingScopeKey: 'PIPE-A' }
    ];
    const resolve = input => resolvePipelineNumberConflicts({
      welds: input,
      getKey: item => item.id,
      getScopeKey: item => item.numberingScopeKey
    });
    const first = resolve(sourceWelds);
    const second = resolve(sourceWelds);

    expect(first.map(item => [item.id, item.number])).toEqual([
      ['ordinary-1', 1],
      ['ordinary-2', 2],
      ['ordinary-3', 5],
      ['edited-3', 3],
      ['edited-4', 4],
      ['ordinary-4', 6]
    ]);
    expect(second.map(item => item.number)).toEqual(first.map(item => item.number));
  });

  test('same numbers in different pipelines and support numbers do not conflict', () => {
    const result = resolvePipelineNumberConflicts({
      welds: [
        weld('a-1', 1, 'PIPE-A', 1),
        weld('b-1', 1, 'PIPE-B', 1),
        { ...weld('support-a', 1, 'PIPE-A', 1), isWeldedSupport: true }
      ],
      getKey: item => item.id,
      getScopeKey: item => item.pipelineNumber
    });

    expect(result.map(item => item.number)).toEqual([1, 1, 1]);
  });
});
