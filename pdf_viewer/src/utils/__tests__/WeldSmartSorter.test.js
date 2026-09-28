/**
 * 焊点智能排序器测试
 */

import {
  WeldSmartSorter,
  SortStrategy,
  sortWelds,
  getRecommendedStrategy,
  buildPathIdNumberingSequence,
  buildWeldSegmentSequence,
  getWeldSelectionKey
} from '../WeldSmartSorter';

describe('WeldSmartSorter', () => {
  // 测试数据：5个焊点
  const mockWelds = [
    { pathId: 30, center: { x: 300, y: 100 }, boundingBox: { minX: 295, minY: 95, maxX: 305, maxY: 105, width: 10, height: 10 } },
    { pathId: 10, center: { x: 100, y: 100 }, boundingBox: { minX: 95, minY: 95, maxX: 105, maxY: 105, width: 10, height: 10 } },
    { pathId: 20, center: { x: 200, y: 200 }, boundingBox: { minX: 195, minY: 195, maxX: 205, maxY: 205, width: 10, height: 10 } },
    { pathId: 40, center: { x: 150, y: 300 }, boundingBox: { minX: 145, minY: 295, maxX: 155, maxY: 305, width: 10, height: 10 } },
    { pathId: 25, center: { x: 250, y: 100 }, boundingBox: { minX: 245, minY: 95, maxX: 255, maxY: 105, width: 10, height: 10 } }
  ];

  // 测试数据：2根管道
  const mockPipelines = [
    {
      pathId: 'pipe_1',
      segments: [
        { x1: 95, y1: 100, x2: 305, y2: 100, width: 1.0 },
        { x1: 305, y1: 100, x2: 305, y2: 102, width: 1.0 },
        { x1: 305, y1: 102, x2: 95, y2: 102, width: 1.0 },
        { x1: 95, y1: 102, x2: 95, y2: 100, width: 1.0 }
      ],
      bbox: { minX: 95, minY: 100, maxX: 305, maxY: 102, width: 210, height: 2 }
    },
    {
      pathId: 'pipe_2',
      segments: [
        { x1: 145, y1: 200, x2: 155, y2: 300, width: 1.0 },
        { x1: 155, y1: 300, x2: 157, y2: 300, width: 1.0 },
        { x1: 157, y1: 300, x2: 147, y2: 200, width: 1.0 },
        { x1: 147, y1: 200, x2: 145, y2: 200, width: 1.0 }
      ],
      bbox: { minX: 145, minY: 200, maxX: 157, maxY: 300, width: 12, height: 100 }
    }
  ];

  describe('基础排序策略', () => {
    test('从左到右排序', () => {
      const sorter = new WeldSmartSorter(mockWelds);
      const sorted = sorter.sort(SortStrategy.LEFT_TO_RIGHT);
      
      expect(sorted.length).toBe(5);
      expect(sorted[0].center.x).toBe(100); // 最左边
      expect(sorted[4].center.x).toBe(300); // 最右边
      
      // 验证X坐标递增
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].center.x).toBeGreaterThanOrEqual(sorted[i-1].center.x);
      }
    });

    test('从上到下排序', () => {
      const sorter = new WeldSmartSorter(mockWelds);
      const sorted = sorter.sort(SortStrategy.TOP_TO_BOTTOM);
      
      expect(sorted.length).toBe(5);
      
      // 验证Y坐标递增
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].center.y).toBeGreaterThanOrEqual(sorted[i-1].center.y);
      }
    });
  });

  describe('高级排序策略', () => {
    test('按管道分组排序', () => {
      // 关联焊点到管道
      const weldsWithPipeline = mockWelds.map((weld, index) => {
        if (index < 3) {
          // 前3个焊点关联到pipe_1
          return {
            ...weld,
            relatedPipelineId: 'pipe_1',
            relatedPipeline: mockPipelines[0]
          };
        } else if (index === 3) {
          // 第4个焊点关联到pipe_2
          return {
            ...weld,
            relatedPipelineId: 'pipe_2',
            relatedPipeline: mockPipelines[1]
          };
        } else {
          // 第5个焊点未关联
          return weld;
        }
      });

      const sorter = new WeldSmartSorter(weldsWithPipeline, mockPipelines);
      const sorted = sorter.sort(SortStrategy.PIPELINE_GROUP);
      
      expect(sorted.length).toBe(5);
      
      // 验证同一管道的焊点连续
      const pipe1Welds = sorted.filter(w => w.relatedPipelineId === 'pipe_1');
      const pipe2Welds = sorted.filter(w => w.relatedPipelineId === 'pipe_2');
      const unassigned = sorted.filter(w => !w.relatedPipelineId);
      
      expect(pipe1Welds.length).toBe(3);
      expect(pipe2Welds.length).toBe(1);
      expect(unassigned.length).toBe(1);
    });

    test('最近邻遍历排序', () => {
      const sorter = new WeldSmartSorter(mockWelds);
      const sorted = sorter.sort(SortStrategy.NEAREST_NEIGHBOR, { startPosition: 'top-left' });
      
      expect(sorted.length).toBe(5);
      
      // 第一个应该是左上角的焊点（X+Y最小）
      const firstWeld = sorted[0];
      expect(firstWeld.center.x + firstWeld.center.y).toBeLessThanOrEqual(
        mockWelds[1].center.x + mockWelds[1].center.y
      );
    });
  });

  describe('快速排序函数', () => {
    test('sortWelds 函数', () => {
      const sorted = sortWelds(mockWelds, null, null, SortStrategy.LEFT_TO_RIGHT);
      
      expect(sorted.length).toBe(5);
      expect(sorted[0].center.x).toBe(100);
    });
  });

  describe('自动推荐策略', () => {
    test('无管道数据时推荐最近邻', () => {
      const strategy = getRecommendedStrategy(mockWelds, null);
      expect(strategy).toBe(SortStrategy.NEAREST_NEIGHBOR);
    });

    test('焊点数量少时推荐最近邻', () => {
      const fewWelds = mockWelds.slice(0, 3);
      const strategy = getRecommendedStrategy(fewWelds, null);
      expect(strategy).toBe(SortStrategy.NEAREST_NEIGHBOR);
    });

    test('管道关联率高时推荐管道网络遍历', () => {
      // 所有焊点都关联到管道
      const weldsWithPipeline = mockWelds.map(weld => ({
        ...weld,
        relatedPipelineId: 'pipe_1',
        relatedPipeline: mockPipelines[0]
      }));

      const strategy = getRecommendedStrategy(weldsWithPipeline, mockPipelines);
      expect(strategy).toBe(SortStrategy.PIPELINE_NETWORK);
    });
  });

  describe('PathID 编号顺序', () => {
    test('选择最小 pathId 并往大 ID 编号', () => {
      const sorted = buildPathIdNumberingSequence(mockWelds, 10, 'asc');
      expect(sorted.map(w => w.pathId)).toEqual([10, 20, 25, 30, 40]);
    });

    test('选择最大 pathId 并往小 ID 编号', () => {
      const sorted = buildPathIdNumberingSequence(mockWelds, 40, 'desc');
      expect(sorted.map(w => w.pathId)).toEqual([40, 30, 25, 20, 10]);
    });

    test('选择中间 pathId 并往大 ID 编号时回卷', () => {
      const sorted = buildPathIdNumberingSequence(mockWelds, 25, 'asc');
      expect(sorted.map(w => w.pathId)).toEqual([25, 30, 40, 10, 20]);
    });

    test('选择中间 pathId 并往小 ID 编号时回卷', () => {
      const sorted = buildPathIdNumberingSequence(mockWelds, 25, 'desc');
      expect(sorted.map(w => w.pathId)).toEqual([25, 20, 10, 40, 30]);
    });

    test('单个焊点时直接返回', () => {
      const sorted = buildPathIdNumberingSequence([mockWelds[0]], 30, 'asc');
      expect(sorted).toEqual([mockWelds[0]]);
    });

    test('空数组返回空', () => {
      expect(buildPathIdNumberingSequence([], 10, 'asc')).toEqual([]);
    });

    test('起点 pathId 不存在时返回空', () => {
      expect(buildPathIdNumberingSequence(mockWelds, 999, 'asc')).toEqual([]);
    });
  });

  describe('起终点区间提取', () => {
    test('起点在终点前时返回升序闭区间', () => {
      const sorted = buildWeldSegmentSequence(
        mockWelds,
        getWeldSelectionKey(mockWelds[1]),
        getWeldSelectionKey(mockWelds[0])
      );
      expect(sorted.map(w => w.pathId)).toEqual([10, 20, 25, 30]);
    });

    test('起点在终点后时返回降序闭区间', () => {
      const sorted = buildWeldSegmentSequence(
        mockWelds,
        getWeldSelectionKey(mockWelds[0]),
        getWeldSelectionKey(mockWelds[1])
      );
      expect(sorted.map(w => w.pathId)).toEqual([30, 25, 20, 10]);
    });

    test('起点等于终点时返回单个焊点', () => {
      const key = getWeldSelectionKey(mockWelds[2]);
      const sorted = buildWeldSegmentSequence(mockWelds, key, key);
      expect(sorted).toEqual([mockWelds[2]]);
    });

    test('起点不存在时返回空数组', () => {
      const sorted = buildWeldSegmentSequence(mockWelds, 'missing', getWeldSelectionKey(mockWelds[2]));
      expect(sorted).toEqual([]);
    });

    test('使用实例键而非仅 pathId 进行精确命中', () => {
      const duplicatedPathIdWelds = [
        { id: 'weld-a', pathId: 10, center: { x: 100, y: 100 }, boundingBox: { minX: 95, minY: 95, width: 10, height: 10 } },
        { id: 'weld-b', pathId: 10, center: { x: 110, y: 110 }, boundingBox: { minX: 105, minY: 105, width: 10, height: 10 } },
        { id: 'weld-c', pathId: 20, center: { x: 200, y: 200 }, boundingBox: { minX: 195, minY: 195, width: 10, height: 10 } }
      ];

      const sorted = buildWeldSegmentSequence(
        duplicatedPathIdWelds,
        getWeldSelectionKey(duplicatedPathIdWelds[1]),
        getWeldSelectionKey(duplicatedPathIdWelds[2])
      );

      expect(sorted.map(w => w.id)).toEqual(['weld-b', 'weld-c']);
    });
  });

  describe('边界情况', () => {
    test('空焊点列表', () => {
      const sorter = new WeldSmartSorter([]);
      const sorted = sorter.sort(SortStrategy.LEFT_TO_RIGHT);
      expect(sorted).toEqual([]);
    });

    test('单个焊点', () => {
      const sorter = new WeldSmartSorter([mockWelds[0]]);
      const sorted = sorter.sort(SortStrategy.LEFT_TO_RIGHT);
      expect(sorted.length).toBe(1);
      expect(sorted[0]).toEqual(mockWelds[0]);
    });

    test('未知策略使用默认策略', () => {
      const sorter = new WeldSmartSorter(mockWelds);
      const sorted = sorter.sort('unknown_strategy');
      
      // 应该回退到从左到右
      expect(sorted.length).toBe(5);
      expect(sorted[0].center.x).toBe(100);
    });
  });

  describe('辅助函数', () => {
    test('getWeldX 获取X坐标', () => {
      const sorter = new WeldSmartSorter(mockWelds);
      const x = sorter.getWeldX(mockWelds[0]);
      expect(x).toBe(300);
    });

    test('getWeldY 获取Y坐标', () => {
      const sorter = new WeldSmartSorter(mockWelds);
      const y = sorter.getWeldY(mockWelds[0]);
      expect(y).toBe(100);
    });

    test('getDistance 计算距离', () => {
      const sorter = new WeldSmartSorter(mockWelds);
      const dist = sorter.getDistance(mockWelds[0], mockWelds[1]);
      
      // (300,100) 到 (100,100) 的距离应该是 200
      expect(dist).toBe(200);
    });
  });
});

