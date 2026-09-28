import { detectBranchOutletCandidates } from './TeeDetector';

const segment = (x1, y1, x2, y2, pathId) => (
  ['line', x1, y1, x2, y2, '#000', 1, pathId]
);

test('marks the weld nearest the strongest main run as branch outlet OL side', () => {
  const vertices = [
    [94, 96], [97, 92], [103, 92],
    [106, 96], [103, 102], [97, 102]
  ];
  const vectors = vertices.map((point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return segment(point[0], point[1], next[0], next[1], 'hex');
  });
  vectors.push(
    segment(10, 101, 190, 101, 'main-a'),
    segment(20, 103, 180, 103, 'main-b'),
    segment(100, 20, 100, 96, 'branch')
  );

  const candidates = detectBranchOutletCandidates(vectors, {
    welds: [
      { id: 'branch-weld', center: { x: 100, y: 93 } },
      { id: 'main-weld', center: { x: 100, y: 102 } }
    ]
  });

  expect(candidates).toHaveLength(1);
  expect(candidates[0].branchOutlet).toBe(true);
  expect(candidates[0].mainConnectionWeldId).toBe('main-weld');
  expect(candidates[0].branchConnectionWeldId).toBe('branch-weld');
});

test('prefers the two-sided pipe run over a longer one-sided dimension line', () => {
  const vertices = [
    [94, 96], [97, 92], [103, 92],
    [106, 96], [103, 102], [97, 102]
  ];
  const vectors = vertices.map((point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return segment(point[0], point[1], next[0], next[1], 'hex');
  });
  vectors.push(
    segment(55, 101, 97, 101, 'main-left'),
    segment(103, 101, 145, 101, 'main-right'),
    // A long nearby construction/dimension line exists only on one side.
    segment(100, 96, 100, -260, 'dimension-distractor')
  );

  const candidates = detectBranchOutletCandidates(vectors, {
    welds: [
      { id: 'dimension-side-weld', center: { x: 100, y: 93 } },
      { id: 'main-weld', center: { x: 100, y: 101 } }
    ]
  });

  expect(candidates).toHaveLength(1);
  expect(candidates[0].mainConnectionWeldId).toBe('main-weld');
  expect(candidates[0].branchConnectionWeldId).toBe('dimension-side-weld');
});

test('accepts short pipe fragments beside a branch outlet on a large page', () => {
  const vertices = [
    [631.56, 516], [636, 505.8], [645, 505.8],
    [650.28, 516], [645, 527.4], [636, 527.4]
  ];
  const vectors = vertices.map((point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return segment(point[0], point[1], next[0], next[1], 'real-size-hex');
  });
  vectors.push(
    segment(640.92, 508.68, 668.64, 524.52, 'main-right'),
    segment(616.8, 494.76, 640.92, 508.68, 'main-left'),
    // Establish realistic full-page bounds without creating a nearby connector.
    segment(0, 0, 0, 1450, 'page-bound-left'),
    segment(0, 1450, 1450, 1450, 'page-bound-bottom')
  );

  const candidates = detectBranchOutletCandidates(vectors, {
    welds: [
      { id: 'upper-weld', center: { x: 640.95, y: 508.65 } },
      { id: 'lower-weld', center: { x: 640.95, y: 524.25 } }
    ]
  });

  expect(candidates).toHaveLength(1);
  expect(candidates[0].branchOutlet).toBe(true);
});

test('recognizes the seven-edge outlet returned by the remote PyMuPDF service', () => {
  const vectors = [
    segment(640.9, 508.7, 635.8, 505.8, 199),
    segment(635.8, 505.8, 631.6, 511.2, 199),
    segment(631.6, 511.2, 635.8, 521.4, 199),
    segment(635.8, 521.4, 646.0, 527.4, 199),
    segment(646.0, 527.4, 650.3, 522.0, 199),
    segment(650.3, 522.0, 646.0, 511.6, 199),
    segment(646.0, 511.6, 640.9, 508.7, 199),
    segment(668.6, 524.5, 640.9, 508.7, 197),
    segment(640.9, 508.7, 616.8, 494.8, 214),
    segment(0, 0, 1683.78, 0, 'page-width'),
    segment(0, 0, 0, 1190.55, 'page-height')
  ];

  const candidates = detectBranchOutletCandidates(vectors, {
    welds: [
      { id: 'upper', center: { x: 640.95, y: 508.65 } },
      { id: 'lower', center: { x: 640.95, y: 524.25 } }
    ]
  });

  expect(candidates).toHaveLength(1);
  expect(candidates[0].pathIds).toContain(199);
  expect(candidates[0].mainConnectionWeldId).toBe('upper');
  expect(candidates[0].branchConnectionWeldId).toBe('lower');
});

test('recovers an outlet from its close weld pair when the PDF splits the hexagon paths', () => {
  const vectors = [
    segment(20, 100, 100, 100, 'main-left'),
    segment(100, 100, 180, 100, 'main-right'),
    segment(100, 116, 100, 190, 'branch'),
    segment(0, 0, 200, 0, 'page-top'),
    segment(0, 0, 0, 200, 'page-left'),
    segment(200, 0, 200, 200, 'page-right')
  ];

  const candidates = detectBranchOutletCandidates(vectors, {
    welds: [
      { id: 'main-root', center: { x: 100, y: 100 } },
      { id: 'branch-side', center: { x: 100, y: 116 } }
    ]
  });

  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    recoveredFromWeldPair: true,
    mainConnectionWeldId: 'main-root',
    branchConnectionWeldId: 'branch-side'
  });
});
