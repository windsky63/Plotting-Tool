/**
 * 焊点智能排序工具
 * 基于管道拓扑关系的智能编号顺序
 */

/**
 * 排序策略枚举
 */
export const SortStrategy = {
  PIPELINE_NETWORK: 'pipeline_network',     // 按管道网络拓扑遍历（推荐）
  NEAREST_NEIGHBOR: 'nearest_neighbor',     // 最近邻遍历（类似TSP）
  PIPELINE_GROUP: 'pipeline_group',         // 按管道分组排序
  LEFT_TO_RIGHT: 'left_to_right',           // 简单从左到右
  TOP_TO_BOTTOM: 'top_to_bottom'            // 从上到下排序
};

import { sortWeldsByPipelineNetwork } from './PipelineNetworkTraversal';
import { buildCompletePipelinePaths, sortWeldsByCompletePaths } from './PipelinePathBuilder';

/**
 * 焊点智能排序器
 */
export class WeldSmartSorter {
  constructor(welds, pipelines = null, flowArrows = null) {
    this.welds = welds || [];
    this.pipelines = pipelines || [];
    this.flowArrows = flowArrows || [];
  }

  /**
   * 执行排序
   * @param {string} strategy - 排序策略
   * @param {Object} options - 额外选项
   * @returns {Array} - 排序后的焊点列表
   */
  sort(strategy = SortStrategy.LEFT_TO_RIGHT, options = {}) {
    if (!this.welds || this.welds.length === 0) {
      return [];
    }

    console.log(`🔢 开始智能排序: 策略=${strategy}, 焊点数=${this.welds.length}`);

    switch (strategy) {
      case SortStrategy.PIPELINE_NETWORK:
        return this.sortByPipelineNetwork(options);
      
      case SortStrategy.NEAREST_NEIGHBOR:
        return this.sortByNearestNeighbor(options);
      
      case SortStrategy.PIPELINE_GROUP:
        return this.sortByPipelineGroup(options);
      
      case SortStrategy.LEFT_TO_RIGHT:
        return this.sortLeftToRight();
      
      case SortStrategy.TOP_TO_BOTTOM:
        return this.sortTopToBottom();
      
      default:
        console.warn(`⚠️ 未知排序策略: ${strategy}, 使用默认策略`);
        return this.sortByNearestNeighbor(options);
    }
  }

  /**
   * 策略1: 简单从左到右排序（当前方案）
   */
  sortLeftToRight() {
    return [...this.welds].sort((a, b) => {
      return this.getWeldX(a) - this.getWeldX(b);
    });
  }

  /**
   * 策略2: 从上到下排序
   */
  sortTopToBottom() {
    return [...this.welds].sort((a, b) => {
      return this.getWeldY(a) - this.getWeldY(b);
    });
  }


  /**
   * 策略1: 按管道网络拓扑遍历
   * 将分段管道连接成完整路径，从起点开始沿路径遍历
   * 支持流向箭头识别
   */
  sortByPipelineNetwork(options = {}) {
    const { 
      fallbackStrategy = 'nearest_neighbor',
      useCompletePaths = true  // 默认使用完整路径
    } = options;

    if (!this.pipelines || this.pipelines.length === 0) {
      console.warn('  ⚠️ 没有管道数据，使用备用策略');
      return this.sort(fallbackStrategy, options);
    }

    // 使用完整路径模式
    if (useCompletePaths) {
      console.log('  🔗 使用完整路径模式');
      
      // 1. 构建完整管道路径
      const completePaths = buildCompletePipelinePaths(
        this.pipelines,
        this.flowArrows,
        {
          connectionThreshold: options.connectionThreshold || 30,
          minPathLength: options.minPathLength || 1
        }
      );

      if (completePaths.length === 0) {
        console.warn('  ⚠️ 无法构建完整路径，使用备用策略');
        return this.sort(fallbackStrategy, options);
      }

      // 2. 沿完整路径排序焊点
      return sortWeldsByCompletePaths(this.welds, completePaths, options);
    }

    // 使用原有的网络遍历模式
    return sortWeldsByPipelineNetwork(
      this.welds, 
      this.pipelines, 
      this.flowArrows,
      options
    );
  }

  /**
   * 策略4: 按管道分组排序
   * 同一根管道上的焊点连续编号
   */
  sortByPipelineGroup(options = {}) {
    const { fallbackStrategy = 'left_to_right' } = options;

    if (!this.pipelines || this.pipelines.length === 0) {
      console.warn('  ⚠️ 没有管道数据，使用备用策略');
      return this.sort(fallbackStrategy);
    }

    // 按管道分组
    const pipelineGroups = new Map(); // pipelineId -> welds[]
    const unassignedWelds = []; // 未关联到管道的焊点

    this.welds.forEach(weld => {
      if (weld.relatedPipelineId) {
        if (!pipelineGroups.has(weld.relatedPipelineId)) {
          pipelineGroups.set(weld.relatedPipelineId, []);
        }
        pipelineGroups.get(weld.relatedPipelineId).push(weld);
      } else {
        unassignedWelds.push(weld);
      }
    });

    console.log(`  📊 管道分组: ${pipelineGroups.size} 根管道, ${unassignedWelds.length} 个未关联焊点`);

    // 对每个管道组内的焊点排序（沿管道方向）
    const sortedGroups = [];
    pipelineGroups.forEach((welds, pipelineId) => {
      const pipeline = this.pipelines.find(p => p.pathId === pipelineId);
      const sorted = this.sortWeldsAlongPipeline(welds, pipeline);
      sortedGroups.push({ pipelineId, welds: sorted, pipeline });
    });

    // 对管道组排序（按第一个焊点的位置）
    sortedGroups.sort((a, b) => {
      const aFirst = a.welds[0];
      const bFirst = b.welds[0];
      // 先按Y坐标（上下），再按X坐标（左右）
      const yDiff = this.getWeldY(aFirst) - this.getWeldY(bFirst);
      if (Math.abs(yDiff) > 50) return yDiff;
      return this.getWeldX(aFirst) - this.getWeldX(bFirst);
    });

    // 合并结果
    const result = [];
    sortedGroups.forEach(group => {
      console.log(`    管道 ${group.pipelineId}: ${group.welds.length} 个焊点`);
      result.push(...group.welds);
    });

    // 添加未关联的焊点（按左到右排序）
    if (unassignedWelds.length > 0) {
      const sortedUnassigned = unassignedWelds.sort((a, b) => 
        this.getWeldX(a) - this.getWeldX(b)
      );
      console.log(`    未关联焊点: ${sortedUnassigned.length} 个`);
      result.push(...sortedUnassigned);
    }

    return result;
  }


  /**
   * 策略6: 最近邻遍历排序（类似TSP旅行商问题）
   * 从起点开始，每次选择最近的未访问焊点
   */
  sortByNearestNeighbor(options = {}) {
    const { startPosition = 'top-left' } = options;

    if (this.welds.length === 0) return [];
    if (this.welds.length === 1) return [...this.welds];

    // 确定起点
    let current = this.selectStartWeld(startPosition);
    const sorted = [current];
    const remaining = new Set(this.welds.filter(w => w !== current));

    console.log(`  📊 最近邻遍历: 起点=${startPosition}, 总数=${this.welds.length}`);
    console.log(`  📍 起点坐标: (${this.getWeldX(current).toFixed(1)}, ${this.getWeldY(current).toFixed(1)})`);

    // 贪心算法：每次选择最近的未访问焊点
    let iteration = 0;
    while (remaining.size > 0) {
      let nearest = null;
      let minDistance = Infinity;

      remaining.forEach(weld => {
        const dist = this.getDistance(current, weld);
        if (dist < minDistance) {
          minDistance = dist;
          nearest = weld;
        }
      });

      if (nearest) {
        sorted.push(nearest);
        remaining.delete(nearest);
        
        // 输出调试信息（前10个和最后10个）
        iteration++;
        if (iteration <= 10 || remaining.size <= 10) {
          console.log(`    ${iteration}. (${this.getWeldX(nearest).toFixed(1)}, ${this.getWeldY(nearest).toFixed(1)}) - 距离: ${minDistance.toFixed(1)}`);
        } else if (iteration === 11) {
          console.log(`    ... (省略中间 ${this.welds.length - 20} 个焊点)`);
        }
        
        current = nearest;
      } else {
        break; // 安全退出
      }
    }

    console.log(`  ✅ 最近邻遍历完成，共 ${sorted.length} 个焊点`);

    return sorted;
  }

  /**
   * 辅助：沿管道方向排序焊点
   */
  sortWeldsAlongPipeline(welds, pipeline) {
    if (!pipeline || welds.length <= 1) {
      return welds;
    }

    // 计算管道的主方向（最长线段的方向）
    const mainDirection = this.getPipelineMainDirection(pipeline);
    
    if (!mainDirection) {
      // 如果无法确定方向，按X坐标排序
      return welds.sort((a, b) => this.getWeldX(a) - this.getWeldX(b));
    }

    // 沿主方向投影并排序
    return welds.sort((a, b) => {
      const projA = this.projectOnDirection(a, mainDirection);
      const projB = this.projectOnDirection(b, mainDirection);
      return projA - projB;
    });
  }

  /**
   * 辅助：获取管道主方向
   */
  getPipelineMainDirection(pipeline) {
    if (!pipeline.segments || pipeline.segments.length === 0) {
      return null;
    }

    // 找到最长的线段作为主方向
    let maxLength = 0;
    let mainSegment = null;

    pipeline.segments.forEach(seg => {
      const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
      const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
      const length = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
      
      if (length > maxLength) {
        maxLength = length;
        mainSegment = { p1, p2 };
      }
    });

    if (!mainSegment) return null;

    // 计算方向向量（归一化）
    const dx = mainSegment.p2.x - mainSegment.p1.x;
    const dy = mainSegment.p2.y - mainSegment.p1.y;
    const length = Math.sqrt(dx * dx + dy * dy);

    return {
      x: dx / length,
      y: dy / length,
      angle: Math.atan2(dy, dx)
    };
  }

  /**
   * 辅助：将焊点投影到方向向量上
   */
  projectOnDirection(weld, direction) {
    const x = this.getWeldX(weld);
    const y = this.getWeldY(weld);
    return x * direction.x + y * direction.y;
  }


  /**
   * 辅助：选择起点焊点
   * 使用更智能的起点选择策略
   */
  selectStartWeld(position) {
    if (this.welds.length === 0) return null;
    if (this.welds.length === 1) return this.welds[0];

    switch (position) {
      case 'top-left':
        // 左上角：X + Y 最小
        return this.welds.reduce((best, weld) => {
          const score = this.getWeldX(weld) + this.getWeldY(weld);
          const bestScore = this.getWeldX(best) + this.getWeldY(best);
          return score < bestScore ? weld : best;
        });
      
      case 'top-right':
        // 右上角：-X + Y 最小（即X大Y小）
        return this.welds.reduce((best, weld) => {
          const score = -this.getWeldX(weld) + this.getWeldY(weld);
          const bestScore = -this.getWeldX(best) + this.getWeldY(best);
          return score < bestScore ? weld : best;
        });
      
      case 'bottom-left':
        // 左下角：X - Y 最小（即X小Y大）
        return this.welds.reduce((best, weld) => {
          const score = this.getWeldX(weld) - this.getWeldY(weld);
          const bestScore = this.getWeldX(best) - this.getWeldY(best);
          return score < bestScore ? weld : best;
        });
      
      case 'bottom-right':
        // 右下角：-X - Y 最小（即X大Y大）
        return this.welds.reduce((best, weld) => {
          const score = -this.getWeldX(weld) - this.getWeldY(weld);
          const bestScore = -this.getWeldX(best) - this.getWeldY(best);
          return score < bestScore ? weld : best;
        });
      
      case 'auto':
        // 自动选择：找到最左上角的焊点作为起点
        return this.selectStartWeld('top-left');
      
      default:
        // 默认使用左上角
        return this.selectStartWeld('top-left');
    }
  }

  /**
   * 辅助：计算两个焊点之间的距离
   */
  getDistance(weld1, weld2) {
    const x1 = this.getWeldX(weld1);
    const y1 = this.getWeldY(weld1);
    const x2 = this.getWeldX(weld2);
    const y2 = this.getWeldY(weld2);
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }

  /**
   * 辅助：获取焊点X坐标
   */
  getWeldX(weld) {
    return weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width / 2);
  }

  /**
   * 辅助：获取焊点Y坐标
   */
  getWeldY(weld) {
    return weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height / 2);
  }
}

/**
 * 快速排序函数（导出供外部使用）
 * @param {Array} welds - 焊点列表
 * @param {Array} pipelines - 管道列表（可选）
 * @param {Array} flowArrows - 流向箭头列表（可选）
 * @param {string} strategy - 排序策略
 * @param {Object} options - 额外选项
 * @returns {Array} - 排序后的焊点列表
 */
export function sortWelds(welds, pipelines = null, flowArrows = null, strategy = SortStrategy.LEFT_TO_RIGHT, options = {}) {
  const sorter = new WeldSmartSorter(welds, pipelines, flowArrows);
  return sorter.sort(strategy, options);
}

function getWeldCoordinatePart(weld) {
  if (weld?.center && Number.isFinite(weld.center.x) && Number.isFinite(weld.center.y)) {
    return `${weld.center.x}_${weld.center.y}`;
  }

  if (weld?.boundingBox) {
    const {
      minX = 0,
      minY = 0,
      width = 0,
      height = 0
    } = weld.boundingBox;
    return `${minX}_${minY}_${width}_${height}`;
  }

  return `${weld?.x ?? 0}_${weld?.y ?? 0}`;
}

export function getWeldSelectionKey(weld) {
  if (!weld) {
    return null;
  }

  if (weld.id !== undefined && weld.id !== null && weld.id !== '') {
    return String(weld.id);
  }

  const pathId = weld.pathId !== undefined && weld.pathId !== null ? weld.pathId : 'no-path';
  return `${pathId}:${getWeldCoordinatePart(weld)}`;
}

function getWeldCenterPoint(weld) {
  if (weld?.center && Number.isFinite(weld.center.x) && Number.isFinite(weld.center.y)) {
    return weld.center;
  }

  if (weld?.boundingBox) {
    return {
      x: weld.boundingBox.minX + weld.boundingBox.width / 2,
      y: weld.boundingBox.minY + weld.boundingBox.height / 2
    };
  }

  return {
    x: Number(weld?.x) || 0,
    y: Number(weld?.y) || 0
  };
}

function getWeldSegmentId(weld) {
  const id = weld?.relatedSegmentId ?? weld?.relatedSegment?.pathId ?? weld?.relatedPipelineId ?? weld?.relatedPipeline?.pathId ?? weld?.pathId;
  return id === undefined || id === null || id === '' ? null : String(id);
}

function normalizePoint(point, fallbackX, fallbackY) {
  return {
    x: Number.isFinite(point?.x) ? point.x : Number(fallbackX),
    y: Number.isFinite(point?.y) ? point.y : Number(fallbackY)
  };
}

function getSegmentLineLength(segment) {
  const start = segment.p1 || segment.start || { x: segment.x1, y: segment.y1 };
  const end = segment.p2 || segment.end || { x: segment.x2, y: segment.y2 };
  const p1 = normalizePoint(start, segment.x1, segment.y1);
  const p2 = normalizePoint(end, segment.x2, segment.y2);
  if (!Number.isFinite(p1.x) || !Number.isFinite(p1.y) || !Number.isFinite(p2.x) || !Number.isFinite(p2.y)) {
    return 0;
  }
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}

function buildGeometryFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return null;
  }

  const lineSegments = segments.filter(segment => !segment.type || segment.type === 'line');
  if (lineSegments.length === 0) {
    return null;
  }

  const sortedSegments = [...lineSegments];
  const first = sortedSegments[0];
  const last = sortedSegments[sortedSegments.length - 1];
  const start = normalizePoint(first.p1 || first.start, first.x1, first.y1);
  const end = normalizePoint(last.p2 || last.end, last.x2, last.y2);
  if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) {
    return null;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const directLength = Math.sqrt(dx * dx + dy * dy);
  const totalLength = sortedSegments.reduce((sum, segment) => sum + getSegmentLineLength(segment), 0);
  if (directLength <= 0 || totalLength <= 0) {
    return null;
  }

  return {
    start,
    end,
    length: totalLength,
    directLength,
    unit: {
      x: dx / directLength,
      y: dy / directLength
    },
    segmentCount: sortedSegments.length
  };
}

function getWeldSegmentGeometry(weld) {
  if (Array.isArray(weld?.relatedPipeline?.segments) && weld.relatedPipeline.segments.length > 1) {
    const geometry = buildGeometryFromSegments(weld.relatedPipeline.segments);
    if (geometry) {
      return geometry;
    }
  }

  const segment = weld?.relatedSegment?.segment || weld?.relatedSegment || weld?.relatedPipeline?.segments?.[0];
  if (!segment && Array.isArray(weld?.segments)) {
    return buildGeometryFromSegments(weld.segments);
  }

  if (!segment) {
    return null;
  }

  const start = segment.p1 || segment.start || { x: segment.x1, y: segment.y1 };
  const end = segment.p2 || segment.end || { x: segment.x2, y: segment.y2 };
  if (
    !Number.isFinite(start?.x) ||
    !Number.isFinite(start?.y) ||
    !Number.isFinite(end?.x) ||
    !Number.isFinite(end?.y)
  ) {
    return null;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= 0) {
    return null;
  }

  return {
    start,
    end,
    length,
    unit: {
      x: dx / length,
      y: dy / length
    }
  };
}

function distanceBetweenPoints(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function pointToSegmentDistance(point, segment) {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) {
    return distanceBetweenPoints(point, segment.start);
  }

  const t = Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSquared));
  const projection = {
    x: segment.start.x + t * dx,
    y: segment.start.y + t * dy
  };
  return distanceBetweenPoints(point, projection);
}

function getSegmentProjection(weld, segment, reversed = false) {
  const point = getWeldCenterPoint(weld);
  const dx = point.x - segment.start.x;
  const dy = point.y - segment.start.y;
  const projection = dx * segment.unit.x + dy * segment.unit.y;
  return reversed ? segment.length - projection : projection;
}

function getConnectionInfo(segmentA, segmentB) {
  const pairs = [
    { from: 'end', to: 'start', distance: distanceBetweenPoints(segmentA.end, segmentB.start) },
    { from: 'end', to: 'end', distance: distanceBetweenPoints(segmentA.end, segmentB.end) },
    { from: 'start', to: 'start', distance: distanceBetweenPoints(segmentA.start, segmentB.start) },
    { from: 'start', to: 'end', distance: distanceBetweenPoints(segmentA.start, segmentB.end) }
  ];

  return pairs.reduce((best, item) => (item.distance < best.distance ? item : best), pairs[0]);
}

function getUndirectedAnglePenalty(segmentA, segmentB) {
  const dot = Math.abs(segmentA.unit.x * segmentB.unit.x + segmentA.unit.y * segmentB.unit.y);
  const clamped = Math.max(-1, Math.min(1, dot));
  const angleDegrees = Math.acos(clamped) * 180 / Math.PI;

  if (angleDegrees <= 18) return 0;
  if (angleDegrees <= 35) return 8;
  if (angleDegrees <= 55) return 28;
  if (angleDegrees <= 75) return 70;
  return 140;
}

function getDirectionFromWelds(startWeld, endWeld) {
  const start = getWeldCenterPoint(startWeld);
  const end = getWeldCenterPoint(endWeld);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= 0) {
    return null;
  }
  return {
    x: dx / length,
    y: dy / length
  };
}

function getMainDirectionPenalty(segment, mainDirection) {
  if (!mainDirection) {
    return 0;
  }

  const dot = Math.abs(segment.unit.x * mainDirection.x + segment.unit.y * mainDirection.y);
  const clamped = Math.max(-1, Math.min(1, dot));
  const angleDegrees = Math.acos(clamped) * 180 / Math.PI;

  if (angleDegrees <= 18) return 0;
  if (angleDegrees <= 30) return 18;
  if (angleDegrees <= 45) return 60;
  if (angleDegrees <= 60) return 130;
  return 260;
}

function getMainAxisOffsetPenalty(segment, startWeld, endWeld, mainDirection) {
  if (!mainDirection) {
    return 0;
  }

  const start = getWeldCenterPoint(startWeld);
  const end = getWeldCenterPoint(endWeld);
  const normal = { x: -mainDirection.y, y: mainDirection.x };
  const startOffset = Math.abs((segment.start.x - start.x) * normal.x + (segment.start.y - start.y) * normal.y);
  const endOffset = Math.abs((segment.end.x - start.x) * normal.x + (segment.end.y - start.y) * normal.y);
  const weldOffset = Math.abs((end.x - start.x) * normal.x + (end.y - start.y) * normal.y);
  const allowedOffset = Math.max(18, weldOffset + 20);
  const excess = Math.max(0, Math.min(startOffset, endOffset) - allowedOffset);
  return excess * 0.8;
}

function getSegmentMainRunPenalty(segment, mainDirection, startWeld, endWeld) {
  if (!segment) {
    return 0;
  }

  const directionPenalty = getMainDirectionPenalty(segment, mainDirection);
  const axisPenalty = getMainAxisOffsetPenalty(segment, startWeld, endWeld, mainDirection);
  const lengthCredit = mainDirection && directionPenalty <= 18 ? Math.min(segment.length / 80, 8) : 0;
  return directionPenalty + axisPenalty - lengthCredit;
}

function buildSegmentGraph(segmentMap, connectionThreshold, mainDirection = null, startWeld = null, endWeld = null) {
  const segments = Array.from(segmentMap.values());
  const graph = new Map(segments.map(segment => [segment.id, []]));

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const a = segments[i];
      const b = segments[j];
      const connection = getConnectionInfo(a, b);
      if (connection.distance > connectionThreshold) {
        continue;
      }

      const anglePenalty = getUndirectedAnglePenalty(a, b);
      const aMainPenalty = getSegmentMainRunPenalty(a, mainDirection, startWeld, endWeld);
      const bMainPenalty = getSegmentMainRunPenalty(b, mainDirection, startWeld, endWeld);
      const costAB = connection.distance + anglePenalty + Math.max(0, bMainPenalty);
      const costBA = connection.distance + anglePenalty + Math.max(0, aMainPenalty);
      graph.get(a.id).push({ id: b.id, cost: costAB, connection, anglePenalty });
      graph.get(b.id).push({ id: a.id, cost: costBA, connection: { ...connection, from: connection.to, to: connection.from }, anglePenalty });
    }
  }

  return graph;
}

function findLowestCostSegmentPath(graph, startId, endId) {
  if (!graph.has(startId) || !graph.has(endId)) {
    return [];
  }

  if (startId === endId) {
    return [startId];
  }

  const distances = new Map();
  const previous = new Map();
  const unvisited = new Set(graph.keys());
  graph.forEach((_, id) => distances.set(id, Infinity));
  distances.set(startId, 0);

  while (unvisited.size > 0) {
    let current = null;
    let bestDistance = Infinity;
    unvisited.forEach(id => {
      const distance = distances.get(id);
      if (distance < bestDistance) {
        bestDistance = distance;
        current = id;
      }
    });

    if (current === null || bestDistance === Infinity) {
      break;
    }

    unvisited.delete(current);
    if (current === endId) {
      break;
    }

    (graph.get(current) || []).forEach(edge => {
      if (!unvisited.has(edge.id)) {
        return;
      }
      const nextDistance = bestDistance + edge.cost;
      if (nextDistance < distances.get(edge.id)) {
        distances.set(edge.id, nextDistance);
        previous.set(edge.id, current);
      }
    });
  }

  if (!previous.has(endId)) {
    return [];
  }

  const path = [endId];
  let cursor = endId;
  while (previous.has(cursor)) {
    cursor = previous.get(cursor);
    path.unshift(cursor);
  }

  return path[0] === startId ? path : [];
}

function buildSegmentDirectionMap(segmentPath, segmentMap, startWeld, endWeld) {
  const directionMap = new Map();
  if (!segmentPath.length) {
    return directionMap;
  }

  segmentPath.forEach((id, index) => {
    const segment = segmentMap.get(id);
    if (!segment) {
      return;
    }

    let targetPoint = null;
    if (index < segmentPath.length - 1) {
      const nextSegment = segmentMap.get(segmentPath[index + 1]);
      const connection = nextSegment ? getConnectionInfo(segment, nextSegment) : null;
      if (connection) {
        targetPoint = connection.from === 'start' ? segment.start : segment.end;
      }
    } else {
      targetPoint = getWeldCenterPoint(endWeld);
    }

    if (!targetPoint && index === 0) {
      targetPoint = getWeldCenterPoint(endWeld);
    }

    const distanceToStart = distanceBetweenPoints(targetPoint, segment.start);
    const distanceToEnd = distanceBetweenPoints(targetPoint, segment.end);
    directionMap.set(id, {
      reversed: distanceToStart < distanceToEnd
    });
  });

  return directionMap;
}

/**
 * Build a weld numbering sequence using vector connectivity when possible.
 *
 * The selected start/end still define the range. Within that range, welds on
 * connected same-direction segments are treated as the main run first. Sharp
 * angled branches are kept after the main run. If the vector relation is
 * incomplete, callers should keep the original Path ID sequence.
 */
export function buildVectorAwareWeldSegmentSequence(welds, startWeld, endWeld, options = {}) {
  if (!Array.isArray(welds) || welds.length <= 2 || !startWeld || !endWeld) {
    return welds || [];
  }

  if (getWeldSelectionKey(startWeld) === getWeldSelectionKey(endWeld)) {
    return [startWeld];
  }

  const connectionThreshold = options.connectionThreshold || 22;
  const includeOnlyConnectedRange = options.includeOnlyConnectedRange || false;
  const branchDistanceThreshold = options.branchDistanceThreshold || 45;
  const segmentMap = new Map();
  const weldGroups = new Map();

  welds.forEach((weld) => {
    const segmentId = getWeldSegmentId(weld);
    const geometry = getWeldSegmentGeometry(weld);
    if (!segmentId || !geometry) {
      return;
    }

    if (!segmentMap.has(segmentId)) {
      segmentMap.set(segmentId, {
        id: segmentId,
        ...geometry
      });
    }

    if (!weldGroups.has(segmentId)) {
      weldGroups.set(segmentId, []);
    }
    weldGroups.get(segmentId).push(weld);
  });

  const startSegmentId = getWeldSegmentId(startWeld);
  const endSegmentId = getWeldSegmentId(endWeld);
  if (!startSegmentId || !endSegmentId || !segmentMap.has(startSegmentId) || !segmentMap.has(endSegmentId)) {
    return welds;
  }

  const mainDirection = getDirectionFromWelds(startWeld, endWeld);
  const graph = buildSegmentGraph(segmentMap, connectionThreshold, mainDirection, startWeld, endWeld);
  const segmentPath = findLowestCostSegmentPath(graph, startSegmentId, endSegmentId);
  if (segmentPath.length === 0) {
    return welds;
  }

  const directionMap = buildSegmentDirectionMap(segmentPath, segmentMap, startWeld, endWeld);
  const seen = new Set();
  const ordered = [];
  const appendWeld = (weld) => {
    const key = getWeldSelectionKey(weld);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    ordered.push(weld);
  };

  segmentPath.forEach((segmentId) => {
    const segment = segmentMap.get(segmentId);
    const weldsOnSegment = [...(weldGroups.get(segmentId) || [])];
    const reversed = directionMap.get(segmentId)?.reversed || false;
    weldsOnSegment
      .sort((a, b) => getSegmentProjection(a, segment, reversed) - getSegmentProjection(b, segment, reversed))
      .forEach(appendWeld);
  });

  const mainSegmentOrder = new Map(segmentPath.map((id, index) => [id, index]));
  const remainingWelds = welds
    .filter(weld => {
      const key = getWeldSelectionKey(weld);
      if (!key || seen.has(key)) {
        return false;
      }

      if (!includeOnlyConnectedRange) {
        return true;
      }

      const center = getWeldCenterPoint(weld);
      const nearest = segmentPath.reduce((best, id) => {
        const mainSegment = segmentMap.get(id);
        const distance = mainSegment ? pointToSegmentDistance(center, mainSegment) : Infinity;
        return Math.min(best, distance);
      }, Infinity);
      return nearest <= branchDistanceThreshold;
    });

  remainingWelds
    .sort((a, b) => {
      const segmentA = segmentMap.get(getWeldSegmentId(a));
      const segmentB = segmentMap.get(getWeldSegmentId(b));
      const centerA = getWeldCenterPoint(a);
      const centerB = getWeldCenterPoint(b);
      const nearestA = segmentPath.reduce((best, id, index) => {
        const mainSegment = segmentMap.get(id);
        const distance = mainSegment ? pointToSegmentDistance(centerA, mainSegment) : Infinity;
        return distance < best.distance ? { index, distance } : best;
      }, { index: Number.MAX_SAFE_INTEGER, distance: Infinity });
      const nearestB = segmentPath.reduce((best, id, index) => {
        const mainSegment = segmentMap.get(id);
        const distance = mainSegment ? pointToSegmentDistance(centerB, mainSegment) : Infinity;
        return distance < best.distance ? { index, distance } : best;
      }, { index: Number.MAX_SAFE_INTEGER, distance: Infinity });

      if (nearestA.index !== nearestB.index) {
        return nearestA.index - nearestB.index;
      }
      if (Math.abs(nearestA.distance - nearestB.distance) > 0.001) {
        return nearestA.distance - nearestB.distance;
      }

      const orderA = mainSegmentOrder.get(getWeldSegmentId(a)) ?? Number.MAX_SAFE_INTEGER;
      const orderB = mainSegmentOrder.get(getWeldSegmentId(b)) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) {
        return orderA - orderB;
      }

      if (mainDirection) {
        const startPoint = getWeldCenterPoint(startWeld);
        const projA = (centerA.x - startPoint.x) * mainDirection.x + (centerA.y - startPoint.y) * mainDirection.y;
        const projB = (centerB.x - startPoint.x) * mainDirection.x + (centerB.y - startPoint.y) * mainDirection.y;
        if (Math.abs(projA - projB) > 0.001) {
          return projA - projB;
        }
      }

      return Number(a?.pathId || 0) - Number(b?.pathId || 0);
    })
    .forEach(appendWeld);

  if (includeOnlyConnectedRange) {
    return ordered;
  }

  return ordered.length === welds.length ? ordered : welds;
}

function normalizeWeldsByPathId(welds) {
  const normalizedWelds = welds
    .map((weld, index) => ({
      weld,
      originalIndex: index,
      pathId: Number(weld?.pathId),
      selectionKey: getWeldSelectionKey(weld)
    }))
    .filter(item => Number.isFinite(item.pathId) && item.selectionKey);

  if (normalizedWelds.length !== welds.length) {
    return [];
  }

  return [...normalizedWelds].sort((a, b) => {
    if (a.pathId !== b.pathId) {
      return a.pathId - b.pathId;
    }
    return a.originalIndex - b.originalIndex;
  });
}

/**
 * 按焊点 pathId 生成单页编号顺序
 * 规则：
 * 1. 先按 pathId 升序建立基准序列
 * 2. 从选中的起点开始，按指定方向遍历
 * 3. 到达一端后回卷继续，直到覆盖全部焊点
 * @param {Array} welds - 当前页焊点列表
 * @param {number|string} startPathId - 起点焊点的 pathId
 * @param {'asc'|'desc'} direction - 编号方向
 * @returns {Array} - 重排后的焊点列表
 */
export function buildPathIdNumberingSequence(welds, startPathId, direction) {
  if (!Array.isArray(welds) || welds.length === 0) {
    return [];
  }

  if (welds.length === 1) {
    return [...welds];
  }

  if (direction !== 'asc' && direction !== 'desc') {
    return [];
  }

  const normalizedStartPathId = Number(startPathId);
  if (!Number.isFinite(normalizedStartPathId)) {
    return [];
  }

  const sorted = normalizeWeldsByPathId(welds);
  if (sorted.length !== welds.length) {
    return [];
  }

  const startIndex = sorted.findIndex(item => item.pathId === normalizedStartPathId);
  if (startIndex === -1) {
    return [];
  }

  if (direction === 'asc') {
    return [
      ...sorted.slice(startIndex),
      ...sorted.slice(0, startIndex)
    ].map(item => item.weld);
  }

  return [
    ...sorted.slice(0, startIndex + 1).reverse(),
    ...sorted.slice(startIndex + 1).reverse()
  ].map(item => item.weld);
}

/**
 * 按起点/终点焊点提取单个编号区间
 * 规则：
 * 1. 先按 pathId 升序建立基准序列
 * 2. 找到起点和终点后，返回闭区间
 * 3. 若起点在终点前，返回升序；否则返回降序
 * @param {Array} welds - 当前页焊点列表
 * @param {string} startWeldKey - 起点焊点选择键
 * @param {string} endWeldKey - 终点焊点选择键
 * @returns {Array} - 当前区间内的焊点列表
 */
export function buildWeldSegmentSequence(welds, startWeldKey, endWeldKey) {
  if (!Array.isArray(welds) || welds.length === 0) {
    return [];
  }

  if (!startWeldKey || !endWeldKey) {
    return [];
  }

  const sorted = normalizeWeldsByPathId(welds);
  if (sorted.length !== welds.length) {
    return [];
  }

  const startIndex = sorted.findIndex(item => item.selectionKey === String(startWeldKey));
  const endIndex = sorted.findIndex(item => item.selectionKey === String(endWeldKey));

  if (startIndex === -1 || endIndex === -1) {
    return [];
  }

  if (startIndex === endIndex) {
    return [sorted[startIndex].weld];
  }

  if (startIndex < endIndex) {
    return sorted.slice(startIndex, endIndex + 1).map(item => item.weld);
  }

  return sorted.slice(endIndex, startIndex + 1).reverse().map(item => item.weld);
}

/**
 * 获取推荐的排序策略
 * 根据焊点和管道的情况自动选择最佳策略
 */
export function getRecommendedStrategy(welds, pipelines) {
  if (!welds || welds.length === 0) {
    return SortStrategy.NEAREST_NEIGHBOR;
  }

  // 如果有管道数据且大部分焊点已关联到管道
  if (pipelines && pipelines.length > 0) {
    const associatedCount = welds.filter(w => w.relatedPipelineId).length;
    const associationRate = associatedCount / welds.length;

    if (associationRate > 0.5) {
      // 50%以上的焊点关联到管道，使用管道网络拓扑遍历
      console.log(`  ✅ 管道关联率 ${(associationRate * 100).toFixed(0)}%，推荐使用管道网络遍历`);
      return SortStrategy.PIPELINE_NETWORK;
    }
  }

  // 默认使用最近邻遍历（最符合"依次选择最近焊点"的需求）
  return SortStrategy.NEAREST_NEIGHBOR;
}

/**
 * 导出策略描述（用于UI显示）
 */
export const StrategyDescriptions = {
  [SortStrategy.PIPELINE_NETWORK]: {
    name: '完整管道路径遍历',
    description: '将分段管道连接成完整连续路径，从起点到终点依次编号，支持流向箭头（强烈推荐）',
    icon: '🛤️',
    requiresPipeline: true,
    recommended: true,
    supportsFlowArrow: true  // 支持流向箭头
  },
  [SortStrategy.NEAREST_NEIGHBOR]: {
    name: '最近邻遍历',
    description: '从起点开始，依次选择距离最近的焊点进行编号',
    icon: '🔄',
    recommended: true
  },
  [SortStrategy.PIPELINE_GROUP]: {
    name: '按管道分组',
    description: '同一根管道上的焊点连续编号',
    icon: '🔗',
    requiresPipeline: true
  },
  [SortStrategy.LEFT_TO_RIGHT]: {
    name: '从左到右',
    description: '按X坐标从小到大排序',
    icon: '→'
  },
  [SortStrategy.TOP_TO_BOTTOM]: {
    name: '从上到下',
    description: '按Y坐标从小到大排序',
    icon: '↓'
  }
};
