import {
  buildConfirmedWeldLabels,
  fuseRuleAndAiWelds,
  getConfirmedJointType,
  getConfirmedPipelineInfo,
  getConfirmedWeldNumber,
  getAiMergeDistance,
  isTrainableWeldAnnotation,
  resolveLeaderPipeEnd,
  summarizeConfirmedWeldLabels
} from './weldAiFusion';

describe('weldAiFusion', () => {
  test.each([
    [0, 0, true], [4.99, 0, true], [5, 0, true], [3, 4, true],
    [5.01, 0, false], [4, 4, false],
  ])('default circular hit radius: dx=%s dy=%s matched=%s', (dx, dy, matched) => {
    for (const pageInfo of [{ width: 600, height: 800 }, { width: 20000, height: 20000 }]) {
      const rule = { id: 'rule', center: { x: 100, y: 100 }, weldNumber: 12 };
      const result = fuseRuleAndAiWelds({
        pageInfo, ruleWelds: [rule],
        aiDetections: [{ id: 'ai', center: { x: 100 + dx, y: 100 + dy } }],
      });
      expect(result.diagnostics.mergeDistance).toBe(5);
      expect(result.diagnostics.matchedCount).toBe(matched ? 1 : 0);
      expect(result.reviewCandidates).toHaveLength(matched ? 0 : 1);
      expect(result.welds).toHaveLength(1);
      expect(result.welds[0].center).toEqual(rule.center);
      expect(result.welds[0].weldNumber).toBe(12);
    }
  });

  test('one AI point cannot match two nearby rule welds', () => {
    const result = fuseRuleAndAiWelds({
      ruleWelds: [{ center: { x: 100, y: 100 } }, { center: { x: 101, y: 100 } }],
      aiDetections: [{ center: { x: 102, y: 100 } }],
    });
    expect(result.diagnostics.matchedCount).toBe(1);
    expect(result.welds).toHaveLength(2);
  });

  test.each([
    ['1"BW', 'BW'], ['6"SW', 'SW'], ['1"OL', 'OL'], ['0.5"RR', 'RR'],
    ['1/2"BW', 'BW'], ['1 1/2"SW', 'SW'], ['6BW', 'BW'], ['AW', 'AW'],
    ['6″BW', 'BW'], ['"BW6', 'BW'], ['2"承插焊', '承插焊'], ['6"bw', 'bw'],
  ])('recovers legacy split-circle joint text %s', (topText, expected) => {
    expect(getConfirmedJointType({ borderShape: 'split-circle', topText })).toBe(expected);
  });

  test.each(['L=200', '6', '6"', '', 'SEE DETAIL A', 'BW/SW?', '6"BW备注'])('does not guess a joint from %s', topText => {
    expect(getConfirmedJointType({ borderShape: 'split-circle', topText })).toBeUndefined();
  });

  test('explicit joint remains authoritative; other shapes do not interpret topText', () => {
    expect(getConfirmedJointType({ borderShape: 'split-circle', topText: '6"BW', jointTypeText: 'RR' })).toBe('RR');
    expect(getConfirmedJointType({ borderShape: 'circle', topText: '6"BW' })).toBeUndefined();
  });

  test('keeps every rule weld and marks nearby AI agreement', () => {
    const result = fuseRuleAndAiWelds({
      pageNum: 2,
      pageInfo: { width: 1000, height: 800 },
      mergeDistance: 12,
      ruleWelds: [
        { id: 'rule-1', center: { x: 100, y: 100 } },
        { id: 'rule-2', center: { x: 400, y: 400 } }
      ],
      aiDetections: [
        { id: 'ai-1', center: { x: 106, y: 104 }, confidence: 0.98 },
        { id: 'ai-2', center: { x: 700, y: 500 }, confidence: 0.72 }
      ]
    });

    expect(result.welds).toHaveLength(2);
    expect(result.welds[0].recognitionSource).toBe('rule+ai');
    expect(result.welds[1].recognitionSource).toBe('rule');
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.reviewCandidates[0].reviewReason).toBe('ai_only');
  });

  test('uses a page-size-aware but bounded merge distance', () => {
    expect(getAiMergeDistance({ width: 100, height: 100 })).toBe(10);
    expect(getAiMergeDistance({ width: 20000, height: 20000 })).toBe(30);
  });

  test('exports weld centers but excludes non-weld and support annotations', () => {
    const annotations = [
      { id: 'w1', page: 1, borderShape: 'split-circle', hasLeaderLine: true, startX: 10, startY: 20, endX: 50, endY: 60 },
      { id: 'p1', page: 1, borderShape: 'pipe-tag', startX: 30, startY: 40 },
      { id: 's1', page: 1, borderShape: 'circle', startX: 50, startY: 60, isScaffoldAnnotation: true }
    ];
    expect(isTrainableWeldAnnotation(annotations[0])).toBe(true);
    expect(buildConfirmedWeldLabels(annotations)).toEqual([
      expect.objectContaining({
        annotationId: 'w1',
        page: 1,
        center: { x: 25, y: 30 },
        leaderPipeEnd: { x: 5, y: 10 }
      })
    ]);
  });

  test('uses the pipe-side leader endpoint instead of the annotation circle or embedded center', () => {
    const labels = buildConfirmedWeldLabels([{
      id: 'leader-weld',
      page: 3,
      borderShape: 'split-circle',
      hasLeaderLine: true,
      startX: 240,
      startY: 360,
      endX: 900,
      endY: 700,
      weldData: { center: { x: 999, y: 888 } }
    }]);

    expect(labels).toEqual([expect.objectContaining({
      annotationId: 'leader-weld',
      center: { x: 450, y: 350 },
      leaderPipeEnd: { x: 120, y: 180 }
    })]);
  });

  test('keeps the complete visible weld number without stripping affixes or separators', () => {
    const labels = buildConfirmedWeldLabels([{
      id: 'numbered-weld',
      page: 4,
      text: ' AREA2-F12-R1 ',
      jointTypeText: ' BW ',
      borderShape: 'split-circle',
      hasLeaderLine: true,
      startX: 100,
      startY: 120,
      endX: 300,
      endY: 320,
      weldData: { weldNumber: 12, displayNumber: 'STALE-12' }
    }]);

    expect(labels[0].weldNumber).toBe('AREA2-F12-R1');
    expect(labels[0].jointType).toBe('BW');
    expect(labels[0].leaderPipeEnd).toEqual({ x: 50, y: 60 });
  });

  test('keeps each weld own pipeline including slash and leading zero', () => {
    const base = { page: 1, borderShape: 'split-circle', hasLeaderLine: true,
      startX: 100, startY: 120, endX: 300, endY: 320 };
    const labels = buildConfirmedWeldLabels([
      { ...base, id: 'a', text: '1', pipelineNumber: ' 001-p/a-01 ', pipelineNumberSource: 'user_confirmed' },
      { ...base, id: 'b', text: '1', pipelineNumber: '002-P/B-01', pipelineNumberSource: 'business_data' }
    ]);
    expect(labels.map(label => label.pipelineNumber)).toEqual(['001-P/A-01', '002-P/B-01']);
    expect(labels.map(label => label.pipelineNumberSource)).toEqual(['user_confirmed', 'business_data']);
    expect(labels[0].pipelineNumberRaw).toBe('001-p/a-01');
  });

  test('omits missing pipeline instead of copying another weld or guessing from number', () => {
    const info = getConfirmedPipelineInfo({ text: '1', page: 2 });
    expect(info).toBeNull();
    expect(getConfirmedPipelineInfo({ pipelineNumber: '001' })).toBeNull();
    const summary = summarizeConfirmedWeldLabels([{
      id: 'missing-pipeline', text: '1', page: 2, jointTypeText: 'BW',
      borderShape: 'split-circle', hasLeaderLine: true,
      startX: 10, startY: 10, endX: 100, endY: 100
    }]);
    expect(summary).toMatchObject({ pipelineCount: 0, fullyQualifiedCount: 0, missingPipelinePages: [2] });
  });

  test('reuses the saved single pipeline-region result for annotations missing pipeline metadata', () => {
    const base = {
      id: 'region-fallback', text: 'F1', page: 7, jointTypeText: 'BW',
      borderShape: 'split-circle', hasLeaderLine: true,
      startX: 10, startY: 10, endX: 100, endY: 100
    };
    const [fallback] = buildConfirmedWeldLabels([base], {
      pipelineNumberByPage: {
        7: { pipelineNumber: ' 001-p/a-07 ', pipelineNumberRaw: '001-p/a-07', pipelineNumberSource: 'inferred' }
      }
    });
    const [owned] = buildConfirmedWeldLabels([{ ...base, pipelineNumber: 'OWN-P-07' }], {
      pipelineNumberByPage: { 7: { pipelineNumber: 'PAGE-P-07' } }
    });
    expect(fallback).toMatchObject({
      pipelineNumber: '001-P/A-07', pipelineNumberRaw: '001-p/a-07', pipelineNumberSource: 'inferred'
    });
    expect(owned.pipelineNumber).toBe('OWN-P-07');
  });

  test('keeps each weld own pipeline including slash and leading zero', () => {
    const base = { page: 1, borderShape: 'split-circle', hasLeaderLine: true,
      startX: 100, startY: 120, endX: 300, endY: 320 };
    const labels = buildConfirmedWeldLabels([
      { ...base, id: 'a', text: '1', pipelineNumber: ' 001-p/a-01 ', pipelineNumberSource: 'user_confirmed' },
      { ...base, id: 'b', text: '1', pipelineNumber: '002-P/B-01', pipelineNumberSource: 'business_data' }
    ]);
    expect(labels.map(label => label.pipelineNumber)).toEqual(['001-P/A-01', '002-P/B-01']);
    expect(labels.map(label => label.pipelineNumberSource)).toEqual(['user_confirmed', 'business_data']);
    expect(labels[0].pipelineNumberRaw).toBe('001-p/a-01');
  });

  test('omits missing pipeline instead of copying another weld or guessing from number', () => {
    const info = getConfirmedPipelineInfo({ text: '1', page: 2 });
    expect(info).toBeNull();
    const summary = summarizeConfirmedWeldLabels([{
      id: 'missing-pipeline', text: '1', page: 2, jointTypeText: 'BW',
      borderShape: 'split-circle', hasLeaderLine: true,
      startX: 10, startY: 10, endX: 100, endY: 100
    }]);
    expect(summary).toMatchObject({ pipelineCount: 0, fullyQualifiedCount: 0, missingPipelinePages: [2] });
  });

  test('omits unavailable or over-limit text fields instead of sending an empty guess', () => {
    expect(getConfirmedWeldNumber({ text: '   ' })).toBeUndefined();
    expect(getConfirmedWeldNumber({ text: 'X'.repeat(121) })).toBeUndefined();
    expect(getConfirmedJointType({ jointTypeText: '   ' })).toBeUndefined();
    expect(getConfirmedJointType({ jointTypeText: 'X'.repeat(121) })).toBeUndefined();
  });

  test('reports number, joint type and complete three-element counts', () => {
    const summary = summarizeConfirmedWeldLabels([
      { id: 'complete', page: 1, text: 'F1-A', jointTypeText: 'BW', borderShape: 'circle', hasLeaderLine: true, startX: 10, startY: 10, endX: 100, endY: 100 },
      { id: 'number-only', page: 1, text: 'F2-A', borderShape: 'circle', hasLeaderLine: true, startX: 20, startY: 20, endX: 120, endY: 120 },
      { id: 'joint-only', page: 1, jointTypeText: 'RR', borderShape: 'circle', hasLeaderLine: true, startX: 30, startY: 30, endX: 130, endY: 130 }
    ]);
    expect(summary).toMatchObject({
      validCount: 3,
      numberedCount: 2,
      jointTypeCount: 2,
      completeCount: 1
    });
  });

  test('does not fall back to the circle when a leader has no valid pipe endpoint', () => {
    expect(buildConfirmedWeldLabels([{
      id: 'broken-leader',
      page: 1,
      borderShape: 'split-circle',
      hasLeaderLine: true,
      weldData: { center: { x: 500, y: 600 } },
      endX: 900,
      endY: 800
    }])).toEqual([]);
  });

  test('resolves a reversed stored polyline by distance from the circle', () => {
    const result = resolveLeaderPipeEnd({
      hasLeaderLine: true,
      endX: 200,
      endY: 200,
      leaderPoints: [{ x: 200, y: 200 }, { x: 160, y: 180 }, { x: 80, y: 120 }]
    });
    expect(result.valid).toBe(true);
    expect(result.leaderPipeEnd).toEqual({ x: 40, y: 60 });
    expect(result.leaderPoints).toHaveLength(3);
  });

  test('reports no-leader and ambiguous annotations instead of submitting them', () => {
    const summary = summarizeConfirmedWeldLabels([
      { id: 'no-line', page: 2, borderShape: 'circle', hasLeaderLine: false, startX: 20, startY: 20, endX: 20, endY: 20 },
      { id: 'too-short', page: 3, borderShape: 'circle', hasLeaderLine: true, startX: 20, startY: 20, endX: 21, endY: 21 }
    ]);
    expect(summary.validCount).toBe(0);
    expect(summary.rejected.map(item => item.reason)).toEqual(['missing_leader', 'ambiguous_endpoints']);
  });
});
