import { detectElbowCandidates } from '../ElbowDetector';

const line = (x1, y1, x2, y2, pathId) => [
  1, x1, y1, x2, y2, 0, 0.72, pathId
];

const weld = (x, y, pathId) => ({
  pathId,
  center: { x, y },
  boundingBox: { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 }
});

describe('sharp-line elbow detection', () => {
  const vectors = [
    line(204.7, 552.8, 189.3, 561.6, 2404),
    line(189.3, 544, 204.7, 552.8, 2377)
  ];

  test('accepts a sharp elbow when both ends have weld evidence', () => {
    const result = detectElbowCandidates(vectors, {
      includeSharpElbows: true,
      welds: [
        weld(189.3, 561.6, 'w1'),
        weld(189.3, 544, 'w2')
      ],
      sharpElbowMinArmLength: 12,
      sharpElbowMaxArmLength: 22
    });
    const elbow = result.find(item => item.type === 'sharp-line-elbow');
    expect(elbow).toBeTruthy();
    expect(elbow.weldEvidenceCount).toBe(2);
    expect(elbow.confidence).toBe('high');
    expect(elbow.missingWeldEndpoint).toBeNull();
    expect(elbow.nominalAngle).toBe(90);
  });

  test('keeps a low-confidence candidate when one end weld was missed', () => {
    const result = detectElbowCandidates(vectors, {
      includeSharpElbows: true,
      welds: [weld(189.3, 561.6, 'w1')],
      sharpElbowMinArmLength: 12,
      sharpElbowMaxArmLength: 22
    });
    const elbow = result.find(item => item.type === 'sharp-line-elbow');
    expect(elbow).toBeTruthy();
    expect(elbow.weldEvidenceCount).toBe(1);
    expect(elbow.confidence).toBe('low');
    expect(elbow.missingWeldEndpoint).toBe('second');
  });

  test('rejects the same sharp corner without weld evidence', () => {
    const result = detectElbowCandidates(vectors, {
      includeSharpElbows: true,
      welds: [],
      sharpElbowMinArmLength: 12,
      sharpElbowMaxArmLength: 22
    });
    expect(result.some(item => item.type === 'sharp-line-elbow')).toBe(false);
  });

  test('rejects a weld that is nearby but not connected at its center', () => {
    const result = detectElbowCandidates(vectors, {
      includeSharpElbows: true,
      welds: [weld(185.3, 561.6, 'nearby-weld')],
      sharpElbowMinArmLength: 12,
      sharpElbowMaxArmLength: 22,
      sharpElbowWeldCenterTolerance: 1.5
    });
    expect(result.some(item => item.type === 'sharp-line-elbow')).toBe(false);
  });

  test('uses sharp and round geometry rules exclusively', () => {
    const sharpResult = detectElbowCandidates(vectors, {
      includeSharpElbows: true,
      elbowGeometryMode: 'auto-exclusive',
      welds: [weld(189.3, 561.6, 'w1')],
      sharpElbowMinArmLength: 12,
      sharpElbowMaxArmLength: 22
    });
    expect(sharpResult.length).toBeGreaterThan(0);
    expect(sharpResult.every(item =>
      item.type === 'sharp-line-elbow' &&
      item.geometryRuleMode === 'sharp'
    )).toBe(true);

    const roundResult = detectElbowCandidates(vectors, {
      includeSharpElbows: true,
      elbowGeometryMode: 'round',
      welds: [weld(189.3, 561.6, 'w1')],
      sharpElbowMinArmLength: 12,
      sharpElbowMaxArmLength: 22
    });
    expect(roundResult.some(item => item.type === 'sharp-line-elbow')).toBe(false);
    expect(roundResult.every(item => item.geometryRuleMode === 'round')).toBe(true);
  });

  test('classifies both new sample pairs as 45-degree elbows', () => {
    const newSamples = [
      line(322.5, 497, 313.7, 512.4, 2233),
      line(337.9, 488.2, 322.5, 497, 2199),
      line(273.1, 582.8, 257.7, 591.6, 2322),
      line(281.9, 567.4, 273.1, 582.8, 2247)
    ];
    const result = detectElbowCandidates(newSamples, {
      includeSharpElbows: true,
      welds: [
        weld(313.7, 512.4, 'sample-1-weld'),
        weld(257.7, 591.6, 'sample-2-weld')
      ],
      sharpElbowMinArmLength: 12,
      sharpElbowMaxArmLength: 22
    });
    const elbows = result.filter(item => item.type === 'sharp-line-elbow');
    expect(elbows).toHaveLength(2);
    expect(elbows.every(item => item.nominalAngle === 45)).toBe(true);
    expect(elbows.every(item => item.weldEvidenceCount >= 1)).toBe(true);
  });
});
