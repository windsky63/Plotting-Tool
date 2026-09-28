import {
  extractSingleSegmentPaths,
  associateWeldsWithSingleSegmentVectors
} from '../PipelineNetworkUtils';

const createLinePath = (id, x1, y1, x2, y2) => ({
  id,
  segments: [
    {
      type: 'line',
      x1,
      y1,
      x2,
      y2,
      p1: { x: x1, y: y1 },
      p2: { x: x2, y: y2 }
    }
  ]
});

const createCurvePath = (id) => ({
  id,
  segments: [
    {
      type: 'curve',
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 10,
      p1: { x: 0, y: 0 },
      p2: { x: 10, y: 10 }
    }
  ]
});

const createWeld = (pathId, x, y) => ({
  pathId,
  center: { x, y },
  boundingBox: {
    minX: x - 5,
    minY: y - 5,
    maxX: x + 5,
    maxY: y + 5,
    width: 10,
    height: 10
  }
});

describe('PipelineNetworkUtils single segment matching', () => {
  test('只提取单段直线路径作为候选', () => {
    const candidates = extractSingleSegmentPaths([
      createLinePath('line-1', 10, 10, 110, 10),
      {
        id: 'multi-1',
        segments: [
          { type: 'line', x1: 0, y1: 0, x2: 10, y2: 0, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
          { type: 'line', x1: 10, y1: 0, x2: 20, y2: 0, p1: { x: 10, y: 0 }, p2: { x: 20, y: 0 } }
        ]
      },
      createCurvePath('curve-1')
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].pathId).toBe('line-1');
    expect(candidates[0].length).toBe(100);
  });

  test('原始 vector 输入中的 type=0 直线也能提取为候选线段', () => {
    const candidates = extractSingleSegmentPaths([
      [0, 10, 20, 110, 20, 0, 1, 'raw-line'],
      [0, 0, 0, 10, 10, 0, 1, 'multi-path'],
      [0, 10, 10, 20, 20, 0, 1, 'multi-path']
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].pathId).toBe('raw-line');
    expect(candidates[0].segment.type).toBe('line');
  });

  test('优先匹配投影在线段内部且垂距最小的线段', () => {
    const welds = [createWeld('w-1', 120, 104)];
    const paths = [
      createLinePath('horizontal', 60, 100, 180, 100),
      createLinePath('vertical', 110, 40, 110, 160)
    ];

    associateWeldsWithSingleSegmentVectors(welds, paths, 15);

    expect(welds[0].relatedSegmentId).toBe('horizontal');
    expect(welds[0].relatedSegment.pathId).toBe('horizontal');
    expect(welds[0].relatedPipelineId).toBe('horizontal');
  });

  test('没有内部投影命中时退回最近端点', () => {
    const welds = [createWeld('w-2', 206, 205)];
    const paths = [
      createLinePath('line-end', 100, 100, 200, 200)
    ];

    associateWeldsWithSingleSegmentVectors(welds, paths, 15);

    expect(welds[0].relatedSegmentId).toBe('line-end');
  });

  test('超出阈值时不建立关联', () => {
    const welds = [createWeld('w-3', 300, 300)];
    const paths = [
      createLinePath('far-line', 10, 10, 110, 10)
    ];

    associateWeldsWithSingleSegmentVectors(welds, paths, 15);

    expect(welds[0].relatedSegment).toBeNull();
    expect(welds[0].relatedPipeline).toBeNull();
  });
});
