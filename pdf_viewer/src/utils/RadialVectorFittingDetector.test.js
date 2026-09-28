import {
  detectRadialVectorFittingCandidates,
  mergeRadialVectorFittingCandidates
} from './RadialVectorFittingDetector';

const pageInfo = { width: 1000, height: 1000 };

test('infers an elbow from a vector turn, a radius and two circle intersections', () => {
  const vectors = [
    [0, 0, 0, 20, 0, 0, 1, 'right'],
    [0, 0, 0, 0, 20, 0, 1, 'down']
  ];
  const welds = [{ id: 'w1', center: { x: 10, y: 0 } }];
  const candidates = detectRadialVectorFittingCandidates(vectors, welds, pageInfo);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    type: 'radial-vector-elbow',
    radialIntersectionCount: 2,
    radialMatchedWeldCount: 1
  });
  expect(candidates[0].connectionPoints).toEqual(expect.arrayContaining([
    { x: 10, y: 0 }, { x: 0, y: 10 }
  ]));
});

test('infers a tee from three vector directions and three radial intersections', () => {
  const vectors = [
    [0, 0, 0, 20, 0, 0, 1, 'right'],
    [0, 0, 0, -20, 0, 0, 1, 'left'],
    [0, 0, 0, 0, 20, 0, 1, 'branch']
  ];
  const welds = [{ id: 'w1', center: { x: 10, y: 0 } }];
  const candidates = detectRadialVectorFittingCandidates(vectors, welds, pageInfo);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    type: 'tee-fitting',
    radialIntersectionCount: 3,
    radialMatchedWeldCount: 1
  });
});

test('does not classify a straight continuation as an elbow', () => {
  const vectors = [
    [0, 0, 0, 20, 0, 0, 1, 'right'],
    [0, 0, 0, -20, 0, 0, 1, 'left']
  ];
  expect(detectRadialVectorFittingCandidates(
    vectors,
    [{ center: { x: 10, y: 0 } }],
    pageInfo
  )).toEqual([]);
});

test('radial validation enriches an existing vector fitting instead of duplicating it', () => {
  const existing = [{ type: 'sharp-line-elbow', center: { x: 1, y: 1 }, score: 0.7 }];
  const radial = [{
    type: 'radial-vector-elbow', center: { x: 0, y: 0 }, score: 0.9,
    radialVectorInferred: true, radialReferenceRadius: 10,
    radialIntersectionCount: 2, radialMatchedWeldCount: 1,
    connectionPoints: [{ x: 10, y: 0 }, { x: 0, y: 10 }]
  }];
  const merged = mergeRadialVectorFittingCandidates(existing, radial, pageInfo);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ radialVectorInferred: true, score: 0.9 });
});
