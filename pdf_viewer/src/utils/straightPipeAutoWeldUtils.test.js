import {
  resolveStraightPipeMaterialPlan,
  resolveSingleDirectionPipeRun,
  planStraightPipeAutoWelds
} from './straightPipeAutoWeldUtils';

const pipeRow = (overrides = {}) => ({
  category: 'PIPE',
  description: 'A106 CARBON STEEL SMLS PIPE',
  specification: '150',
  quantity: '25',
  ...overrides
});

const rectangleVectors = (pathId, x1, y1, x2, y2, width = 1.5) => [
  [1, x1, y1, x2, y1, '#000000', 0.5, pathId],
  [1, x2, y1, x2, y2, '#000000', 0.5, pathId],
  [1, x2, y2, x1, y2, '#000000', 0.5, pathId],
  [1, x1, y2, x1, y1, '#000000', 0.5, pathId]
];

describe('straight pipe material-length auto welds', () => {
  test('uses the carbon steel 3-8 inch reference length', () => {
    expect(resolveStraightPipeMaterialPlan([pipeRow()])).toMatchObject({
      eligible: true,
      steelClass: 'carbon',
      diameterInch: 6,
      totalLengthM: 25,
      referenceLengthM: 10,
      weldCount: 2
    });
  });

  test('rejects pages containing different pipe sizes', () => {
    expect(resolveStraightPipeMaterialPlan([
      pipeRow(),
      pipeRow({ specification: '100' })
    ])).toMatchObject({ eligible: false, reason: '存在多种直管规格' });
  });

  test('keeps the calculated values when the weld count exceeds the safety limit', () => {
    const material = resolveStraightPipeMaterialPlan([
      pipeRow({ quantity: '1200M' })
    ]);
    expect(material).toMatchObject({
      eligible: false,
      rawQuantityValues: ['1200M'],
      parsedLengthsM: [1200],
      totalLengthM: 1200,
      referenceLengthM: 10,
      weldCount: 119,
      safetyLimit: 100,
      pipeRowCount: 1
    });
    expect(material.reason).toContain('119');
    expect(material.reason).toContain('100');
  });

  test('recovers a shifted QTY with an M unit instead of using a repeated item code', () => {
    const material = resolveStraightPipeMaterialPlan([
      pipeRow({
        quantity: '01328069781',
        rawLogicalRow: ['1', '01328069781', '100', '', 'PIPE A312 TP304L SMLS', '221.2 M'],
        description: 'PIPE A312 TP304L SMLS'
      })
    ]);

    expect(material).toMatchObject({
      eligible: true,
      steelClass: 'stainless',
      rawQuantityValues: ['221.2 M'],
      quantitySources: ['rawLogicalRow[5]'],
      totalLengthM: 221.2,
      referenceLengthM: 8,
      weldCount: 27
    });
  });

  test('rejects a long item code when no real QTY can be recovered', () => {
    const material = resolveStraightPipeMaterialPlan([
      pipeRow({
        quantity: '01328069781',
        rawLogicalRow: ['1', '01328069781', '150', '', 'PIPE A106 CARBON STEEL SMLS']
      })
    ]);

    expect(material).toMatchObject({
      eligible: false,
      rawQuantityValues: [''],
      quantitySources: ['unresolved']
    });
    expect(material.reason).toContain('QTY');
  });

  test('ignores a lone PIPE section header before validating QTY', () => {
    const material = resolveStraightPipeMaterialPlan([
      {
        description: 'PIPE',
        specification: '',
        quantity: '',
        rawLogicalRow: ['', 'PIPE', '', '', '', '3035002-WW-306']
      },
      pipeRow({ quantity: '90.4 M' })
    ]);

    expect(material).toMatchObject({
      eligible: true,
      rawQuantityValues: ['90.4 M'],
      totalLengthM: 90.4,
      pipeRowCount: 1
    });
  });

  test('uses a manual page QTY after recognition leaves the pipeline in the QTY column', () => {
    const material = resolveStraightPipeMaterialPlan([
      pipeRow({
        quantity: '3035002-WW-306',
        rawLogicalRow: ['1', 'DI 328069781', '150', '', 'PIPE A106 CARBON STEEL SMLS', '3035002-WW-306']
      })
    ], { manualQuantity: '90.4 M' });

    expect(material).toMatchObject({
      eligible: true,
      rawQuantityValues: ['90.4 M'],
      quantitySources: ['manual'],
      totalLengthM: 90.4,
      weldCount: 9
    });
  });

  test('passes safety-limit diagnostics through to the page result for logging', () => {
    const result = planStraightPipeAutoWelds({
      pageNum: 7,
      materialRows: [pipeRow({ quantity: '1200M' })],
      vectors: [],
      existingWelds: []
    });
    expect(result).toMatchObject({
      status: 'skipped',
      pageNum: 7,
      material: {
        rawQuantityValues: ['1200M'],
        totalLengthM: 1200,
        weldCount: 119,
        safetyLimit: 100
      }
    });
  });

  test('recognizes a single straight direction and rejects multiple directions', () => {
    const horizontal = rectangleVectors('pipe-a', 100, 100, 300, 101.5);
    expect(resolveSingleDirectionPipeRun({ vectors: horizontal })).toMatchObject({ eligible: true });

    const mixed = [
      ...horizontal,
      ...rectangleVectors('pipe-b', 350, 80, 351.5, 240)
    ];
    expect(resolveSingleDirectionPipeRun({ vectors: mixed })).toMatchObject({
      eligible: false,
      reason: '单线图存在多个管道方向'
    });
  });

  test('rejects a short vector that cannot represent the page total pipe length', () => {
    const result = resolveSingleDirectionPipeRun({
      vectors: rectangleVectors('pipe-short', 100, 100, 300, 101.5),
      pageInfo: { page_width: 2000, page_height: 1400 }
    });

    expect(result).toMatchObject({ eligible: false });
    expect(result.reason).toContain('矢量过短');
    expect(result.recognizedLength).toBeLessThan(result.minimumLength);
  });

  test('accepts a pipe vector with a meaningful span on the page', () => {
    const result = resolveSingleDirectionPipeRun({
      vectors: rectangleVectors('pipe-long', 100, 100, 900, 101.5),
      pageInfo: { page_width: 2000, page_height: 1400 }
    });

    expect(result).toMatchObject({ eligible: true });
    expect(result.length).toBeGreaterThanOrEqual(result.minimumLength);
  });

  test('combines endpoint-connected collinear vectors into one long pipe run', () => {
    const vectors = [
      [1, 100, 300, 400, 300, '#000000', 0.5, 'part-a'],
      [1, 400, 300, 700, 300, '#000000', 0.5, 'part-b'],
      [1, 700, 300, 1000, 300, '#000000', 0.5, 'part-c']
    ];
    const result = resolveSingleDirectionPipeRun({
      vectors,
      existingWelds: [{ id: 'known-weld', center: { x: 100, y: 300 } }],
      pageInfo: { page_width: 2000, page_height: 1400 }
    });

    expect(result).toMatchObject({ eligible: true });
    expect(result.length).toBeCloseTo(900, 1);
    expect(result.pathCount).toBe(1);
  });

  test('uses a sufficiently long connected vector group even when the page has no recognized weld', () => {
    const vectors = [
      [1, 100, 300, 500, 300, '#000000', 0.5, 'pipe-a'],
      [1, 500, 300, 1000, 300, '#000000', 0.5, 'pipe-b']
    ];
    const result = resolveSingleDirectionPipeRun({
      vectors,
      existingWelds: [],
      pageInfo: { page_width: 2000, page_height: 1400 }
    });

    expect(result).toMatchObject({ eligible: true });
    expect(result.length).toBeCloseTo(900, 1);
  });

  test('still rejects a short connected vector group when no weld confirms it', () => {
    const result = resolveSingleDirectionPipeRun({
      vectors: [
        [1, 100, 300, 250, 300, '#000000', 0.5, 'short-a'],
        [1, 250, 300, 400, 300, '#000000', 0.5, 'short-b']
      ],
      existingWelds: [],
      pageInfo: { page_width: 2000, page_height: 1400 }
    });

    expect(result).toMatchObject({ eligible: false });
  });

  test('adds evenly spaced points and gives them a pipe direction', () => {
    const result = planStraightPipeAutoWelds({
      pageNum: 3,
      materialRows: [pipeRow()],
      vectors: rectangleVectors('pipe-a', 100, 100, 400, 101.5),
      existingWelds: []
    });
    expect(result.status).toBe('applied');
    expect(result.addedWelds).toHaveLength(2);
    expect(result.addedWelds.map(weld => Math.round(weld.center.x))).toEqual([200, 300]);
    expect(result.addedWelds.every(weld => weld.relatedSegmentAngle === 0)).toBe(true);
  });

  test('prefers a straight line already connected to a recognized weld', () => {
    const relatedSegment = {
      pathId: 'confirmed-line',
      start: { x: 50, y: 80 },
      end: { x: 350, y: 80 },
      segment: { type: 'line', x1: 50, y1: 80, x2: 350, y2: 80 }
    };
    const result = planStraightPipeAutoWelds({
      pageNum: 4,
      materialRows: [pipeRow()],
      vectors: [[1, 50, 80, 350, 80, '#000000', 0.5, 'confirmed-line']],
      existingWelds: [{ id: 'known-weld', center: { x: 50, y: 80 }, relatedSegment }]
    });
    expect(result.status).toBe('applied');
    expect(result.addedWelds.map(weld => Math.round(weld.center.x))).toEqual([150, 250]);
  });
});
