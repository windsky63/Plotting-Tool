import { calculateWeldLayout } from '../WeldLayoutEngine';

const CIRCLE_RADIUS = 56.7 / 2;

const createWeld = (pathId, x, y, extras = {}) => ({
  pathId,
  center: { x, y },
  boundingBox: {
    minX: x - 5,
    minY: y - 5,
    maxX: x + 5,
    maxY: y + 5,
    width: 10,
    height: 10
  },
  ...extras
});

const createRelatedSegment = (pathId, x1, y1, x2, y2) => ({
  pathId,
  angle: Math.atan2(y2 - y1, x2 - x1),
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  segment: {
    type: 'line',
    x1,
    y1,
    x2,
    y2,
    p1: { x: x1, y: y1 },
    p2: { x: x2, y: y2 }
  },
  bbox: {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2)
  },
  pipeline: {
    pathId,
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
    ],
    bbox: {
      minX: Math.min(x1, x2),
      minY: Math.min(y1, y2),
      maxX: Math.max(x1, x2),
      maxY: Math.max(y1, y2)
    }
  }
});

const distance = (a, b) => Math.sqrt((a.endX - b.endX) ** 2 + (a.endY - b.endY) ** 2);
const lineLength = (item) => Math.sqrt((item.endX - item.startX) ** 2 + (item.endY - item.startY) ** 2);
const HARD_LEADER_LABEL_MIN_GAP = 8;
const HARD_LEADER_LEADER_MIN_GAP = 18;

const circleTouchesRect = (circle, rect) => {
  const closestX = Math.max(rect.minX, Math.min(circle.endX, rect.maxX));
  const closestY = Math.max(rect.minY, Math.min(circle.endY, rect.maxY));
  const dx = circle.endX - closestX;
  const dy = circle.endY - closestY;
  return Math.sqrt(dx * dx + dy * dy) < CIRCLE_RADIUS;
};

const getLabelRect = (item) => ({
  minX: item.endX - CIRCLE_RADIUS,
  minY: item.endY - CIRCLE_RADIUS,
  maxX: item.endX + CIRCLE_RADIUS,
  maxY: item.endY + CIRCLE_RADIUS
});

const withPageBounds = (regions, maxX = 600, maxY = 600) => {
  const result = [...regions];
  result.__pageBounds = { minX: 0, minY: 0, maxX, maxY };
  return result;
};

const getDistancePointToSegment = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  const projectionX = x1 + t * dx;
  const projectionY = y1 + t * dy;

  return Math.sqrt((px - projectionX) ** 2 + (py - projectionY) ** 2);
};

const getSegmentToSegmentMinDist = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) => Math.min(
  getDistancePointToSegment(ax1, ay1, bx1, by1, bx2, by2),
  getDistancePointToSegment(ax2, ay2, bx1, by1, bx2, by2),
  getDistancePointToSegment(bx1, by1, ax1, ay1, ax2, ay2),
  getDistancePointToSegment(bx2, by2, ax1, ay1, ax2, ay2)
);

const doSegmentsIntersect = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) => {
  const dax = ax2 - ax1;
  const day = ay2 - ay1;
  const dbx = bx2 - bx1;
  const dby = by2 - by1;
  const cross = dax * dby - day * dbx;

  if (Math.abs(cross) < 1e-10) {
    return false;
  }

  const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / cross;
  const u = ((bx1 - ax1) * day - (by1 - ay1) * dax) / cross;

  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
};

const pointInsideRect = (x, y, rect) => (
  x > rect.minX && x < rect.maxX && y > rect.minY && y < rect.maxY
);

const leaderHitsForeignLabel = (leader, rect) => {
  if (pointInsideRect(leader.startX, leader.startY, rect) || pointInsideRect(leader.connectionX, leader.connectionY, rect)) {
    return true;
  }

  const edges = [
    [rect.minX, rect.minY, rect.maxX, rect.minY],
    [rect.maxX, rect.minY, rect.maxX, rect.maxY],
    [rect.maxX, rect.maxY, rect.minX, rect.maxY],
    [rect.minX, rect.maxY, rect.minX, rect.minY]
  ];

  return edges.some(([x1, y1, x2, y2]) => (
    doSegmentsIntersect(leader.startX, leader.startY, leader.connectionX, leader.connectionY, x1, y1, x2, y2)
  ));
};

describe('WeldLayoutEngine', () => {
  test('numberless weld keeps its frame layout but never receives a fallback number', () => {
    const result = calculateWeldLayout(
      [createWeld(1, 200, 200, {
        number: '',
        weldNumber: null,
        displayNumber: '42',
        isNumberless: true
      })],
      2,
      'KEEP_ORDER'
    );

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe('');
    expect(result[0].isNumberless).toBe(true);
    expect(result[0].startX).toEqual(expect.any(Number));
    expect(result[0].endX).toEqual(expect.any(Number));
  });

  test('KEEP_ORDER 模式保持输入顺序', () => {
    const welds = [
      createWeld(30, 320, 120),
      createWeld(10, 120, 120),
      createWeld(20, 220, 200)
    ];

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER');

    expect(layout.map((item) => item.pathId)).toEqual([30, 10, 20]);
    expect(layout[0].layoutDiagnostics).toEqual(expect.objectContaining({
      selectionStage: expect.any(String),
      lineLength: expect.any(Number),
      hardCollisionCount: expect.any(Number),
      leaderIntersectionCount: 0
    }));
  });

  test('密集焊点的标注圆不会互相重叠', () => {
    const welds = [
      createWeld(1, 160, 180),
      createWeld(2, 190, 180),
      createWeld(3, 220, 180),
      createWeld(4, 250, 180)
    ];

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER');

    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        expect(distance(layout[i], layout[j])).toBeGreaterThan(CIRCLE_RADIUS * 2 - 1);
      }
    }
  });

  test('有合法垂直解时优先选择垂直解', () => {
    const relatedSegment = createRelatedSegment('seg-1', 80, 200, 360, 200);

    const welds = [
      createWeld(1, 180, 200, {
        relatedSegmentId: 'seg-1',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'seg-1',
        relatedPipeline: relatedSegment.pipeline
      }),
      createWeld(2, 260, 200, {
        relatedSegmentId: 'seg-1',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'seg-1',
        relatedPipeline: relatedSegment.pipeline
      })
    ];

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline]);

    layout.forEach((item) => {
      expect(Math.abs(item.endY - item.startY)).toBeGreaterThan(100);
      expect(Math.abs(item.endX - item.startX)).toBeLessThan(0.001);
    });
  });

  test('垂直短引线非法时会选择更长的垂直解', () => {
    const relatedSegment = createRelatedSegment('seg-longer', 80, 200, 360, 200);
    const welds = [
      createWeld(1, 200, 200, {
        relatedSegmentId: 'seg-longer',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'seg-longer',
        relatedPipeline: relatedSegment.pipeline
      })
    ];
    const textRegions = withPageBounds([
      { minX: 160, minY: 45, maxX: 240, maxY: 95 },
      { minX: 160, minY: 305, maxX: 240, maxY: 355 }
    ], 500, 500);

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline], null, textRegions);

    expect(Math.abs(layout[0].endY - layout[0].startY)).toBeGreaterThan(150);
    expect(Math.abs(layout[0].endX - layout[0].startX)).toBeLessThan(0.001);
    expect(lineLength(layout[0])).toBeGreaterThan(140.5);
  });

  test('存在多个零碰撞候选时优先选择最短引线', () => {
    const relatedSegment = createRelatedSegment('seg-shortest', 120, 80, 120, 360);
    const welds = [
      createWeld(1, 120, 220, {
        relatedSegmentId: 'seg-shortest',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'seg-shortest',
        relatedPipeline: relatedSegment.pipeline
      })
    ];

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline]);

    expect(lineLength(layout[0])).toBeCloseTo(140, 5);
  });

  test('非垂直阶段存在多个合法候选时仍优先选择最短引线', () => {
    const relatedSegment = createRelatedSegment('seg-3', 80, 80, 200, 200);
    const welds = [
      createWeld(1, 140, 140, {
        relatedSegmentId: 'seg-3',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'seg-3',
        relatedPipeline: relatedSegment.pipeline
      })
    ];

    const textRegions = withPageBounds([
      { minX: 120, minY: 0, maxX: 160, maxY: 80 },
      { minX: 120, minY: 200, maxX: 160, maxY: 320 }
    ], 500, 500);

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline], null, textRegions);

    expect(Math.abs(layout[0].endX - layout[0].startX)).toBeGreaterThan(0.001);
    expect(lineLength(layout[0])).toBeCloseTo(140, 5);
  });

  test('上方有 OCR 文字区域时标注圆不会落入文字区域', () => {
    const welds = [createWeld(1, 200, 220)];
    const textRegions = [
      {
        minX: 120,
        minY: 20,
        maxX: 280,
        maxY: 180
      }
    ];

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', null, null, withPageBounds(textRegions, 500, 500));

    expect(circleTouchesRect(layout[0], textRegions[0])).toBe(false);
  });

  test('leader may cross an OCR text box while the annotation circle stays outside', () => {
    const relatedSegment = createRelatedSegment('text-crossing-pipe', 80, 250, 420, 250);
    const textRegion = { minX: 230, minY: 285, maxX: 270, maxY: 345 };
    const welds = [createWeld(1, 250, 250, {
      relatedSegmentId: relatedSegment.pathId,
      relatedSegment,
      relatedSegmentAngle: relatedSegment.angle,
      relatedPipelineId: relatedSegment.pathId,
      relatedPipeline: relatedSegment.pipeline
    })];
    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      [relatedSegment.pipeline],
      null,
      withPageBounds([textRegion], 500, 500)
    );

    expect(layout[0].endY).toBeGreaterThan(layout[0].startY);
    expect(circleTouchesRect(layout[0], textRegion)).toBe(false);
    expect(
      getDistancePointToSegment(
        250,
        315,
        layout[0].startX,
        layout[0].startY,
        layout[0].connectionX,
        layout[0].connectionY
      )
    ).toBeLessThan(1);
  });

  test('OCR 碰撞会淘汰非法候选', () => {
    const relatedSegment = createRelatedSegment('pipe-text', 100, 120, 100, 360);
    const welds = [
      createWeld(1, 100, 220, {
        relatedSegmentId: 'pipe-text',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-text',
        relatedPipeline: relatedSegment.pipeline
      })
    ];
    const textRegions = withPageBounds([
      { minX: 220, minY: 160, maxX: 260, maxY: 280 },
      { minX: -60, minY: 160, maxX: -20, maxY: 280 }
    ], 500, 500);

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline], null, textRegions);

    expect(circleTouchesRect(layout[0], textRegions[0])).toBe(false);
    expect(circleTouchesRect(layout[0], textRegions[1])).toBe(false);
  });

  test('垂直解因页面越界无效时会回退到非垂直方向', () => {
    const relatedSegment = createRelatedSegment('pipe-relaxed', 100, 120, 100, 360);
    const welds = [
      createWeld(1, 100, 220, {
        relatedSegmentId: 'pipe-relaxed',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-relaxed',
        relatedPipeline: relatedSegment.pipeline
      })
    ];
    const textRegions = withPageBounds([], 210, 260);

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline], null, textRegions);

    expect(Math.abs(layout[0].endY - layout[0].startY)).toBeGreaterThan(0.001);
    expect(lineLength(layout[0])).toBeCloseTo(140, 5);
  });

  test('密集同管线焊点会避免引线相交、接触及穿过其他标注框', () => {
    const relatedSegment = createRelatedSegment('pipe-safe', 100, 120, 100, 360);
    const welds = [
      createWeld(1, 100, 180, {
        relatedSegmentId: 'pipe-safe',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-safe',
        relatedPipeline: relatedSegment.pipeline
      }),
      createWeld(2, 100, 215, {
        relatedSegmentId: 'pipe-safe',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-safe',
        relatedPipeline: relatedSegment.pipeline
      }),
      createWeld(3, 100, 250, {
        relatedSegmentId: 'pipe-safe',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-safe',
        relatedPipeline: relatedSegment.pipeline
      })
    ];

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline]);

    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        const a = layout[i];
        const b = layout[j];

        expect(distance(a, b)).toBeGreaterThan(CIRCLE_RADIUS * 2);
        expect(
          doSegmentsIntersect(a.startX, a.startY, a.connectionX, a.connectionY, b.startX, b.startY, b.connectionX, b.connectionY)
        ).toBe(false);
        expect(
          getSegmentToSegmentMinDist(a.startX, a.startY, a.connectionX, a.connectionY, b.startX, b.startY, b.connectionX, b.connectionY)
        ).toBeGreaterThanOrEqual(HARD_LEADER_LEADER_MIN_GAP);
        expect(leaderHitsForeignLabel(a, getLabelRect(b))).toBe(false);
        expect(leaderHitsForeignLabel(b, getLabelRect(a))).toBe(false);
        expect(
          getDistancePointToSegment(b.endX, b.endY, a.startX, a.startY, a.connectionX, a.connectionY)
        ).toBeGreaterThanOrEqual(CIRCLE_RADIUS + HARD_LEADER_LABEL_MIN_GAP);
        expect(
          getDistancePointToSegment(a.endX, a.endY, b.startX, b.startY, b.connectionX, b.connectionY)
        ).toBeGreaterThanOrEqual(CIRCLE_RADIUS + HARD_LEADER_LABEL_MIN_GAP);
      }
    }
  });

  test('密集场景下必要时会扩展到更长引线或兜底', () => {
    const relatedSegment = createRelatedSegment('pipe-expand', 100, 120, 100, 360);
    const welds = [
      createWeld(1, 100, 190, {
        relatedSegmentId: 'pipe-expand',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-expand',
        relatedPipeline: relatedSegment.pipeline
      }),
      createWeld(2, 100, 200, {
        relatedSegmentId: 'pipe-expand',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-expand',
        relatedPipeline: relatedSegment.pipeline
      }),
      createWeld(3, 100, 210, {
        relatedSegmentId: 'pipe-expand',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-expand',
        relatedPipeline: relatedSegment.pipeline
      })
    ];

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline]);

    expect(layout.some((item) => lineLength(item) > 140.5)).toBe(true);
  });

  test('管网两端的标注分别朝焊点群外侧布置', () => {
    const relatedSegments = [
      createRelatedSegment('pipe-outward-1', 160, 200, 240, 200),
      createRelatedSegment('pipe-outward-2', 260, 300, 340, 300),
      createRelatedSegment('pipe-outward-3', 360, 400, 440, 400)
    ];
    const welds = [
      createWeld(1, 200, 200, {
        relatedSegmentId: 'pipe-outward-1',
        relatedSegment: relatedSegments[0],
        relatedSegmentAngle: relatedSegments[0].angle,
        relatedPipelineId: 'pipe-outward-1',
        relatedPipeline: relatedSegments[0].pipeline
      }),
      createWeld(2, 300, 300, {
        relatedSegmentId: 'pipe-outward-2',
        relatedSegment: relatedSegments[1],
        relatedSegmentAngle: relatedSegments[1].angle,
        relatedPipelineId: 'pipe-outward-2',
        relatedPipeline: relatedSegments[1].pipeline
      }),
      createWeld(3, 400, 400, {
        relatedSegmentId: 'pipe-outward-3',
        relatedSegment: relatedSegments[2],
        relatedSegmentAngle: relatedSegments[2].angle,
        relatedPipelineId: 'pipe-outward-3',
        relatedPipeline: relatedSegments[2].pipeline
      })
    ];

    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      relatedSegments.map(segment => segment.pipeline),
      null,
      withPageBounds([], 600, 600)
    );
    const center = { x: 300, y: 300 };

    [layout[0], layout[2]].forEach((item) => {
      const outward = {
        x: item.startX - center.x,
        y: item.startY - center.y
      };
      const leader = {
        x: item.endX - item.startX,
        y: item.endY - item.startY
      };
      expect(outward.x * leader.x + outward.y * leader.y).toBeGreaterThan(0);
    });
  });

  test('焊点较多时会按空白情况混合使用不同长度引线', () => {
    const coordinates = [100, 300, 500];
    const welds = coordinates.flatMap((y, row) => (
      coordinates.map((x, column) => createWeld(row * 3 + column + 1, x, y))
    ));

    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 700, 700)
    );
    expect(layout.some(item => lineLength(item) > 140.5)).toBe(true);
  });

  test('圆圈整体保持在焊点识别区域内', () => {
    const coordinates = [150, 300, 450];
    const welds = coordinates.flatMap((y, row) => (
      coordinates.map((x, column) => createWeld(row * 3 + column + 1, x, y))
    ));
    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 600, 600),
      {
        normalizedPlacementArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        allowLeaderThroughGraphics: true
      }
    );

    layout.forEach((item) => {
      expect(item.endX - CIRCLE_RADIUS).toBeGreaterThanOrEqual(60);
      expect(item.endY - CIRCLE_RADIUS).toBeGreaterThanOrEqual(60);
      expect(item.endX + CIRCLE_RADIUS).toBeLessThanOrEqual(540);
      expect(item.endY + CIRCLE_RADIUS).toBeLessThanOrEqual(540);
    });
  });

  test('焊点较多时优先使用斜向标注，水平引线只作为少量兜底', () => {
    const coordinates = [150, 300, 450];
    const welds = coordinates.flatMap((y, row) => (
      coordinates.map((x, column) => createWeld(row * 3 + column + 1, x, y))
    ));
    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 600, 600),
      {
        normalizedPlacementArea: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: true
      }
    );
    const horizontalCount = layout.filter(
      item => Math.abs(item.endY - item.startY) < 0.001
    ).length;
    const diagonalCount = layout.filter(item => (
      Math.abs(item.endX - item.startX) >= 0.001 &&
      Math.abs(item.endY - item.startY) >= 0.001
    )).length;

    expect(horizontalCount).toBeLessThanOrEqual(2);
    expect(diagonalCount).toBeGreaterThan(horizontalCount);
    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        expect(
          doSegmentsIntersect(
            layout[i].startX,
            layout[i].startY,
            layout[i].connectionX,
            layout[i].connectionY,
            layout[j].startX,
            layout[j].startY,
            layout[j].connectionX,
            layout[j].connectionY
          )
        ).toBe(false);
      }
    }
  });

  test('自定义较大圆圈尺寸时仍保证整个圆圈不越出焊点区域', () => {
    const customDiameter = 100;
    const customRadius = customDiameter / 2;
    const welds = [
      createWeld(1, 90, 90),
      createWeld(2, 510, 90),
      createWeld(3, 90, 510),
      createWeld(4, 510, 510),
      createWeld(5, 300, 300),
      createWeld(6, 240, 240),
      createWeld(7, 360, 240),
      createWeld(8, 240, 360)
    ];
    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 600, 600),
      {
        normalizedPlacementArea: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
        circleDiameter: customDiameter,
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: true
      }
    );

    layout.forEach((item) => {
      expect(item.endX - customRadius).toBeGreaterThanOrEqual(30);
      expect(item.endY - customRadius).toBeGreaterThanOrEqual(30);
      expect(item.endX + customRadius).toBeLessThanOrEqual(570);
      expect(item.endY + customRadius).toBeLessThanOrEqual(570);
    });
  });

  test('周边布局有可行解时标注圈、引线之间互不相交', () => {
    const welds = [
      createWeld(1, 220, 220),
      createWeld(2, 500, 180),
      createWeld(3, 780, 220),
      createWeld(4, 820, 500),
      createWeld(5, 780, 780),
      createWeld(6, 500, 820),
      createWeld(7, 220, 780),
      createWeld(8, 180, 500)
    ];
    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 1000, 1000),
      {
        normalizedPlacementArea: { x: 0.04, y: 0.04, width: 0.92, height: 0.92 },
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false
      }
    );

    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        const a = layout[i];
        const b = layout[j];
        expect(distance(a, b)).toBeGreaterThan(CIRCLE_RADIUS * 2);
        expect(
          doSegmentsIntersect(
            a.startX,
            a.startY,
            a.connectionX,
            a.connectionY,
            b.startX,
            b.startY,
            b.connectionX,
            b.connectionY
          )
        ).toBe(false);
        expect(leaderHitsForeignLabel(a, getLabelRect(b))).toBe(false);
        expect(leaderHitsForeignLabel(b, getLabelRect(a))).toBe(false);
      }
    }
  });

  test('引线可以穿过图形，但圆圈不会覆盖图形', () => {
    const welds = [
      createWeld(1, 300, 300),
      createWeld(2, 280, 280),
      createWeld(3, 320, 280),
      createWeld(4, 280, 320),
      createWeld(5, 320, 320),
      createWeld(6, 260, 300),
      createWeld(7, 340, 300),
      createWeld(8, 300, 260)
    ];
    const blockingGraphicX = 440;
    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 700, 700),
      {
        graphicVectors: [[0, blockingGraphicX, 200, blockingGraphicX, 400]],
        allowLeaderThroughGraphics: true
      }
    );

    layout.forEach((item) => {
      const distanceToGraphic = Math.abs(item.endX - blockingGraphicX);
      const circleVerticallyOverlapsGraphic = (
        item.endY + CIRCLE_RADIUS > 200 &&
        item.endY - CIRCLE_RADIUS < 400
      );
      expect(
        circleVerticallyOverlapsGraphic && distanceToGraphic < CIRCLE_RADIUS + 8
      ).toBe(false);
    });
  });

  test('多焊点优先沿局部管线两侧就近排布标注', () => {
    const relatedSegment = createRelatedSegment('diagonal-pipe', 140, 220, 860, 580);
    const segmentAngle = relatedSegment.angle;
    const tangentX = Math.cos(segmentAngle);
    const tangentY = Math.sin(segmentAngle);
    const normalX = -tangentY;
    const normalY = tangentX;
    const welds = Array.from({ length: 8 }, (_, index) => {
      const ratio = (index + 1) / 9;
      const x = 140 + (860 - 140) * ratio;
      const y = 220 + (580 - 220) * ratio;
      return createWeld(index + 1, x, y, {
        relatedSegmentId: relatedSegment.pathId,
        relatedSegment,
        relatedSegmentAngle: segmentAngle,
        relatedPipelineId: relatedSegment.pathId,
        relatedPipeline: relatedSegment.pipeline
      });
    });

    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      [relatedSegment.pipeline],
      null,
      withPageBounds([], 1000, 800),
      {
        normalizedPlacementArea: { x: 0.04, y: 0.04, width: 0.92, height: 0.92 },
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false
      }
    );

    const localNormalCount = layout.filter((item) => {
      const dx = item.endX - item.startX;
      const dy = item.endY - item.startY;
      const tangentProjection = Math.abs(dx * tangentX + dy * tangentY);
      const normalProjection = Math.abs(dx * normalX + dy * normalY);
      return normalProjection > tangentProjection;
    }).length;
    const sortedLengths = layout.map(lineLength).sort((a, b) => a - b);
    const medianLength = sortedLengths[Math.floor(sortedLengths.length / 2)];

    expect(localNormalCount).toBeGreaterThanOrEqual(6);
    expect(medianLength).toBeLessThanOrEqual(230);
  });

  test('放宽方向后仍无零碰撞解时保留兜底最优解', () => {
    const relatedSegment = createRelatedSegment('pipe-fallback', 100, 120, 100, 360);
    const welds = Array.from({ length: 13 }, (_, index) => createWeld(index + 1, 100, 220, {
      relatedSegmentId: 'pipe-fallback',
      relatedSegment,
      relatedSegmentAngle: relatedSegment.angle,
      relatedPipelineId: 'pipe-fallback',
      relatedPipeline: relatedSegment.pipeline
    }));

    const layout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline]);
    let hardConflictCount = 0;

    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        const a = layout[i];
        const b = layout[j];

        if (distance(a, b) < CIRCLE_RADIUS * 2 - 1) {
          hardConflictCount += 1;
        }

        if (
          doSegmentsIntersect(a.startX, a.startY, a.connectionX, a.connectionY, b.startX, b.startY, b.connectionX, b.connectionY) ||
          leaderHitsForeignLabel(a, getLabelRect(b)) ||
          leaderHitsForeignLabel(b, getLabelRect(a))
        ) {
          hardConflictCount += 1;
        }

        expect(
          doSegmentsIntersect(
            a.startX,
            a.startY,
            a.connectionX,
            a.connectionY,
            b.startX,
            b.startY,
            b.connectionX,
            b.connectionY
          )
        ).toBe(false);
      }
    }

    expect(layout).toHaveLength(13);
    expect(hardConflictCount).toBeGreaterThan(0);
    expect(
      layout.some(item => item.layoutDiagnostics.source === 'leader-suppressed-to-prevent-crossing')
    ).toBe(false);
  });

  test('相同输入在不同入口复用时布局结果一致', () => {
    const relatedSegment = createRelatedSegment('pipe-2', 100, 120, 100, 360);

    const welds = [
      createWeld(1, 100, 170, {
        relatedSegmentId: 'pipe-2',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-2',
        relatedPipeline: relatedSegment.pipeline
      }),
      createWeld(2, 100, 250, {
        relatedSegmentId: 'pipe-2',
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: 'pipe-2',
        relatedPipeline: relatedSegment.pipeline
      })
    ];

    const textRegions = [{ minX: 140, minY: 120, maxX: 230, maxY: 210 }];

    const singlePageLayout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline], null, textRegions);
    const multiPageLayout = calculateWeldLayout(welds, 1, 'KEEP_ORDER', [relatedSegment.pipeline], null, textRegions);

    expect(multiPageLayout).toEqual(singlePageLayout);
  });

  test('dense perimeter layout keeps leaders away from foreign labels', () => {
    const relatedSegment = createRelatedSegment('dense-diagonal-pipe', 140, 260, 860, 540);
    const welds = Array.from({ length: 18 }, (_, index) => {
      const ratio = (index + 1) / 19;
      const x = 140 + (860 - 140) * ratio;
      const y = 260 + (540 - 260) * ratio;
      return createWeld(index + 1, x, y, {
        relatedSegmentId: relatedSegment.pathId,
        relatedSegment,
        relatedSegmentAngle: relatedSegment.angle,
        relatedPipelineId: relatedSegment.pathId,
        relatedPipeline: relatedSegment.pipeline
      });
    });

    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      [relatedSegment.pipeline],
      null,
      withPageBounds([], 1000, 800),
      {
        normalizedPlacementArea: { x: 0.04, y: 0.04, width: 0.92, height: 0.92 },
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false
      }
    );

    expect(layout).toHaveLength(18);
    layout.forEach((item) => {
      expect(item.layoutDiagnostics.hardCollisionSummary.leaderIntersection).toBe(0);
      expect(item.layoutDiagnostics.hardCollisionSummary.leaderLabel).toBe(0);
    });

    const localCount = layout.filter(
      item => /^(local-pipe-band|long-pipe-group)/.test(String(item.layoutDiagnostics.source || ''))
    ).length;
    const sortedLengths = layout.map(lineLength).sort((a, b) => a - b);
    const medianLength = sortedLengths[Math.floor(sortedLengths.length / 2)];
    expect(localCount).toBeGreaterThanOrEqual(12);
    expect(medianLength).toBeLessThanOrEqual(240);
  });

  test('long straight pipe welds use ordered near-perpendicular group lanes', () => {
    const relatedSegment = createRelatedSegment('clean-long-pipe', 120, 620, 900, 260);
    const angle = relatedSegment.angle;
    const tangentX = Math.cos(angle);
    const tangentY = Math.sin(angle);
    const welds = Array.from({ length: 14 }, (_, index) => {
      const ratio = (index + 1) / 15;
      return createWeld(
        index + 1,
        120 + (900 - 120) * ratio,
        620 + (260 - 620) * ratio,
        {
          relatedSegmentId: relatedSegment.pathId,
          relatedSegment,
          relatedSegmentAngle: angle,
          relatedPipelineId: `${relatedSegment.pathId}-${index % 2}`,
          relatedPipeline: relatedSegment.pipeline
        }
      );
    });

    const layout = calculateWeldLayout(
      welds,
      1,
      'KEEP_ORDER',
      [relatedSegment.pipeline],
      null,
      withPageBounds([], 1040, 820),
      {
        normalizedPlacementArea: { x: 0.04, y: 0.04, width: 0.92, height: 0.92 },
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false
      }
    );

    const grouped = layout.filter(item => item.layoutDiagnostics.source === 'long-pipe-group');
    expect(grouped.length).toBeGreaterThanOrEqual(12);
    expect(new Set(grouped.map(item => item.layoutDiagnostics.longPipeGroupId)).size).toBe(1);
    expect(Math.max(...grouped.map(
      item => item.layoutDiagnostics.perpendicularDeviationDegrees
    ))).toBeLessThanOrEqual(8);

    const projections = grouped.map(item => item.endX * tangentX + item.endY * tangentY);
    for (let index = 1; index < projections.length; index += 1) {
      expect(projections[index]).toBeGreaterThan(projections[index - 1]);
    }
    for (let i = 0; i < grouped.length; i += 1) {
      for (let j = i + 1; j < grouped.length; j += 1) {
        expect(doSegmentsIntersect(
          grouped[i].startX,
          grouped[i].startY,
          grouped[i].connectionX,
          grouped[i].connectionY,
          grouped[j].startX,
          grouped[j].startY,
          grouped[j].connectionX,
          grouped[j].connectionY
        )).toBe(false);
      }
    }
  });

  test('incremental layout keeps existing positions while placing a new weld', () => {
    const originalWelds = [
      createWeld(1, 140, 180),
      createWeld(2, 300, 180),
      createWeld(3, 460, 180)
    ];
    const originalLayout = calculateWeldLayout(
      originalWelds,
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 600, 500)
    );
    const nextLayout = calculateWeldLayout(
      [...originalWelds, createWeld(4, 300, 320)],
      1,
      'KEEP_ORDER',
      null,
      null,
      withPageBounds([], 600, 500),
      { fixedLayouts: originalLayout }
    );

    expect(nextLayout).toHaveLength(4);
    originalLayout.forEach((item, index) => {
      expect(nextLayout[index].startX).toBe(item.startX);
      expect(nextLayout[index].startY).toBe(item.startY);
      expect(nextLayout[index].endX).toBe(item.endX);
      expect(nextLayout[index].endY).toBe(item.endY);
    });
    expect(Number.isFinite(nextLayout[3].endX)).toBe(true);
    expect(Number.isFinite(nextLayout[3].endY)).toBe(true);
  });
});
