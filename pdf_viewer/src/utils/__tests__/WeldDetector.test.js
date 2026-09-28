import { groupVectorsIntoPathsStructured, ruleShenyuanWeld } from '../WeldDetector';

describe('WeldDetector grouping compatibility', () => {
  test('type=0 的原始矢量在焊点识别分组中仍保持 curve 语义', () => {
    const paths = groupVectorsIntoPathsStructured([
      [0, 10, 10, 20, 10, 0, 1, 'curve-like-path']
    ]);

    expect(paths).toHaveLength(1);
    expect(paths[0].segments).toHaveLength(1);
    expect(paths[0].segments[0].type).toBe('curve');
    expect(paths[0].segments[0].rawType).toBe(0);
  });
});

describe('申远焊口规则', () => {
  const buildCirclePath = ({ count = 24, radius = 3.25, type = 'line' } = {}) => {
    const points = Array.from({ length: count }, (_, index) => {
      const angle = index / count * Math.PI * 2;
      return { x: 100 + Math.cos(angle) * radius, y: 100 + Math.sin(angle) * radius };
    });
    return {
      id: 'shenyuan-sample',
      segments: points.map((point, index) => ({
        type,
        p1: point,
        p2: points[(index + 1) % count],
        x1: point.x,
        y1: point.y,
        x2: points[(index + 1) % count].x,
        y2: points[(index + 1) % count].y
      }))
    };
  };

  test('接受24条均匀短直线组成的6.5尺寸闭合圆', () => {
    expect(ruleShenyuanWeld(buildCirclePath())).toBe(true);
  });

  test('接受远端矢量接口使用type=0表示的24段直线焊口', () => {
    const path = buildCirclePath();
    const rawVectors = path.segments.map(segment => ([
      0,
      segment.x1,
      segment.y1,
      segment.x2,
      segment.y2,
      0,
      1,
      'remote-shenyuan-weld'
    ]));
    const [groupedPath] = groupVectorsIntoPathsStructured(rawVectors);
    expect(ruleShenyuanWeld(groupedPath)).toBe(true);
  });

  test('拒绝段数、线型或尺寸不同的普通图形', () => {
    expect(ruleShenyuanWeld(buildCirclePath({ count: 23 }))).toBe(false);
    expect(ruleShenyuanWeld(buildCirclePath({ type: 'curve' }))).toBe(false);
    expect(ruleShenyuanWeld(buildCirclePath({ radius: 5 }))).toBe(false);
  });
});
