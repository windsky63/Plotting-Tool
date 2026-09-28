/**
 * 管道路径构建器
 * 将分段的管道连接成完整的连续路径
 */

/**
 * 构建完整的管道路径
 * 将所有分段管道连接成连续的路径
 * 
 * @param {Array} pipelines - 分段管道列表
 * @param {Array} flowArrows - 流向箭头列表（可选）
 * @param {Object} options - 选项
 * @returns {Array} - 完整的管道路径列表
 */
export function buildCompletePipelinePaths(pipelines, flowArrows = null, options = {}) {
  const {
    connectionThreshold = 30,  // 连接判定阈值（更大，允许更远的连接）
    minPathLength = 2          // 最小路径长度（管道段数）
  } = options;

  if (!pipelines || pipelines.length === 0) {
    return [];
  }

  console.log(`🔗 开始构建完整管道路径，共 ${pipelines.length} 段管道`);

  // 1. 提取每段管道的端点
  const pipelineSegments = pipelines.map(pipe => ({
    id: pipe.pathId,
    pipeline: pipe,
    start: extractPipelineStart(pipe),
    end: extractPipelineEnd(pipe),
    direction: calculatePipelineDirection(pipe),
    used: false
  }));

  // 2. 识别流向信息
  const flowDirections = new Map();
  if (flowArrows && flowArrows.length > 0) {
    console.log(`  🎯 处理 ${flowArrows.length} 个流向箭头`);
    flowArrows.forEach(arrow => {
      if (arrow.relatedPipelineId) {
        const direction = extractArrowDirection(arrow);
        if (direction) {
          flowDirections.set(arrow.relatedPipelineId, direction);
        }
      }
    });
    console.log(`  ✅ 识别到 ${flowDirections.size} 个管道的流向`);
  }

  // 3. 构建连接图
  const connections = buildConnectionGraph(pipelineSegments, connectionThreshold);
  console.log(`  🔗 发现 ${connections.length} 个连接点`);

  // 4. 合并成完整路径
  const completePaths = mergeIntoCompletePaths(
    pipelineSegments,
    connections,
    flowDirections,
    minPathLength
  );

  console.log(`  ✅ 构建完成: ${completePaths.length} 条完整管道路径`);
  completePaths.forEach((path, index) => {
    console.log(`    路径 ${index + 1}: ${path.segments.length} 段管道, 长度 ${path.totalLength.toFixed(1)}`);
  });

  return completePaths;
}

/**
 * 提取管道起点
 */
function extractPipelineStart(pipeline) {
  if (!pipeline.segments || pipeline.segments.length === 0) {
    return null;
  }

  // 对于4线段闭合管道，找到最左上的点作为起点
  const allPoints = [];
  pipeline.segments.forEach(seg => {
    const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
    const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
    allPoints.push(p1, p2);
  });

  // 找到最左上的点（X+Y最小）
  return allPoints.reduce((best, point) => {
    const scoreA = point.x + point.y;
    const scoreB = best.x + best.y;
    return scoreA < scoreB ? point : best;
  });
}

/**
 * 提取管道终点
 */
function extractPipelineEnd(pipeline) {
  if (!pipeline.segments || pipeline.segments.length === 0) {
    return null;
  }

  // 找到最右下的点（X+Y最大）
  const allPoints = [];
  pipeline.segments.forEach(seg => {
    const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
    const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
    allPoints.push(p1, p2);
  });

  return allPoints.reduce((best, point) => {
    const scoreA = point.x + point.y;
    const scoreB = best.x + best.y;
    return scoreA > scoreB ? point : best;
  });
}

/**
 * 计算管道主方向
 */
function calculatePipelineDirection(pipeline) {
  if (!pipeline.segments || pipeline.segments.length === 0) {
    return null;
  }

  // 找到最长的线段作为主方向
  let maxLength = 0;
  let mainSegment = null;

  pipeline.segments.forEach(seg => {
    const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
    const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
    const length = getDistance(p1, p2);
    
    if (length > maxLength) {
      maxLength = length;
      mainSegment = { p1, p2 };
    }
  });

  if (!mainSegment) return null;

  const dx = mainSegment.p2.x - mainSegment.p1.x;
  const dy = mainSegment.p2.y - mainSegment.p1.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  return {
    angle: Math.atan2(dy, dx),
    vector: { x: dx / length, y: dy / length }
  };
}

/**
 * 提取箭头方向
 */
function extractArrowDirection(arrow) {
  if (!arrow.segments || arrow.segments.length === 0) {
    return null;
  }

  let maxLength = 0;
  let mainSegment = null;

  arrow.segments.forEach(seg => {
    const length = Math.sqrt(
      Math.pow(seg.x2 - seg.x1, 2) + 
      Math.pow(seg.y2 - seg.y1, 2)
    );
    
    if (length > maxLength) {
      maxLength = length;
      mainSegment = seg;
    }
  });

  if (!mainSegment) return null;

  const dx = mainSegment.x2 - mainSegment.x1;
  const dy = mainSegment.y2 - mainSegment.y1;
  const length = Math.sqrt(dx * dx + dy * dy);

  return {
    angle: Math.atan2(dy, dx),
    vector: { x: dx / length, y: dy / length }
  };
}

/**
 * 构建连接图
 */
function buildConnectionGraph(segments, threshold) {
  const connections = [];

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const seg1 = segments[i];
      const seg2 = segments[j];

      // 检查4种可能的连接方式
      const checks = [
        { p1: seg1.start, p2: seg2.start, type: 'start-start' },
        { p1: seg1.start, p2: seg2.end, type: 'start-end' },
        { p1: seg1.end, p2: seg2.start, type: 'end-start' },
        { p1: seg1.end, p2: seg2.end, type: 'end-end' }
      ];

      checks.forEach(check => {
        if (!check.p1 || !check.p2) return;
        
        const dist = getDistance(check.p1, check.p2);
        if (dist < threshold) {
          // 检查方向是否一致（避免反向连接）
          const directionMatch = checkDirectionMatch(seg1, seg2, check.type);
          
          connections.push({
            from: seg1.id,
            to: seg2.id,
            fromIndex: i,
            toIndex: j,
            type: check.type,
            distance: dist,
            directionMatch: directionMatch,
            connectionPoint: {
              x: (check.p1.x + check.p2.x) / 2,
              y: (check.p1.y + check.p2.y) / 2
            }
          });
        }
      });
    }
  }

  return connections;
}

/**
 * 检查方向是否匹配
 */
function checkDirectionMatch(seg1, seg2, connectionType) {
  if (!seg1.direction || !seg2.direction) {
    return true; // 无法判断，默认匹配
  }

  const angle1 = seg1.direction.angle;
  const angle2 = seg2.direction.angle;

  // 计算角度差
  let angleDiff = Math.abs(angle1 - angle2);
  if (angleDiff > Math.PI) {
    angleDiff = 2 * Math.PI - angleDiff;
  }

  // 如果角度差小于45度，认为方向一致
  return angleDiff < Math.PI / 4;
}

/**
 * 合并成完整路径
 */
function mergeIntoCompletePaths(segments, connections, flowDirections, minPathLength) {
  const paths = [];
  const visited = new Set();

  // 构建邻接表
  const adjacencyList = new Map();
  segments.forEach(seg => {
    adjacencyList.set(seg.id, []);
  });

  connections.forEach(conn => {
    adjacencyList.get(conn.from).push({
      to: conn.to,
      connection: conn
    });
    adjacencyList.get(conn.to).push({
      to: conn.from,
      connection: conn
    });
  });

  // 找到所有路径的起点（优先选择有流向的、连接数少的）
  const startCandidates = segments
    .filter(seg => !visited.has(seg.id))
    .map(seg => ({
      segment: seg,
      connectionCount: adjacencyList.get(seg.id).length,
      hasFlow: flowDirections.has(seg.id),
      score: calculateStartScore(seg, adjacencyList.get(seg.id).length, flowDirections)
    }))
    .sort((a, b) => b.score - a.score);

  // 从每个起点开始构建路径
  startCandidates.forEach(candidate => {
    if (visited.has(candidate.segment.id)) return;

    const path = buildPathFromStart(
      candidate.segment,
      segments,
      adjacencyList,
      visited,
      flowDirections
    );

    if (path.segments.length >= minPathLength) {
      paths.push(path);
    }
  });

  return paths;
}

/**
 * 计算起点分数（分数越高越适合作为起点）
 */
function calculateStartScore(segment, connectionCount, flowDirections) {
  let score = 0;

  // 1. 有流向的优先
  if (flowDirections.has(segment.id)) {
    score += 100;
  }

  // 2. 连接数少的优先（端点）
  if (connectionCount === 1) {
    score += 50;
  } else if (connectionCount === 0) {
    score += 30;
  }

  // 3. 位置靠左上的优先
  const start = segment.start;
  if (start) {
    score -= (start.x + start.y) / 100;
  }

  return score;
}

/**
 * 从起点构建路径
 */
function buildPathFromStart(startSegment, allSegments, adjacencyList, visited, flowDirections) {
  const pathSegments = [startSegment];
  visited.add(startSegment.id);

  let current = startSegment;
  let totalLength = calculateSegmentLength(startSegment.pipeline);

  // 贪心算法：每次选择最佳的下一段
  while (true) {
    const neighbors = adjacencyList.get(current.id)
      .filter(n => !visited.has(n.to))
      .map(n => {
        const nextSeg = allSegments.find(s => s.id === n.to);
        return {
          segment: nextSeg,
          connection: n.connection,
          score: calculateNextScore(current, nextSeg, flowDirections)
        };
      })
      .sort((a, b) => b.score - a.score);

    if (neighbors.length === 0) break;

    const best = neighbors[0];
    pathSegments.push(best.segment);
    visited.add(best.segment.id);
    totalLength += calculateSegmentLength(best.segment.pipeline);
    current = best.segment;
  }

  // 确定路径方向（从起点到终点）
  const pathDirection = determinePathDirection(pathSegments, flowDirections);

  // 如果需要反转路径
  if (pathDirection.shouldReverse) {
    pathSegments.reverse();
  }

  return {
    id: `path_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    segments: pathSegments,
    pipelines: pathSegments.map(s => s.pipeline),
    totalLength: totalLength,
    direction: pathDirection,
    hasFlow: pathSegments.some(s => flowDirections.has(s.id)),
    start: pathSegments[0].start,
    end: pathSegments[pathSegments.length - 1].end
  };
}

/**
 * 计算下一段的分数
 */
function calculateNextScore(current, next, flowDirections) {
  let score = 0;

  // 1. 方向一致性
  if (current.direction && next.direction) {
    const angleDiff = Math.abs(current.direction.angle - next.direction.angle);
    score += (Math.PI - angleDiff) * 10; // 角度越接近，分数越高
  }

  // 2. 有流向的优先
  if (flowDirections.has(next.id)) {
    score += 50;
  }

  // 3. 距离越近越好
  const dist = getDistance(current.end, next.start);
  score -= dist / 10;

  return score;
}

/**
 * 确定路径方向
 */
function determinePathDirection(pathSegments, flowDirections) {
  if (pathSegments.length === 0) {
    return { shouldReverse: false };
  }

  // 1. 如果有流向箭头，按流向方向
  const segmentsWithFlow = pathSegments.filter(s => flowDirections.has(s.id));
  if (segmentsWithFlow.length > 0) {
    const firstFlowSeg = segmentsWithFlow[0];
    const flowDir = flowDirections.get(firstFlowSeg.id);
    const segDir = firstFlowSeg.direction;

    if (flowDir && segDir) {
      // 计算流向和段方向的夹角
      const angleDiff = Math.abs(flowDir.angle - segDir.angle);
      const shouldReverse = angleDiff > Math.PI / 2;
      
      return {
        shouldReverse: shouldReverse,
        reason: 'flow_direction'
      };
    }
  }

  // 2. 否则按从左上到右下的方向
  const first = pathSegments[0];
  const last = pathSegments[pathSegments.length - 1];
  
  const startScore = first.start.x + first.start.y;
  const endScore = last.end.x + last.end.y;
  
  return {
    shouldReverse: startScore > endScore,
    reason: 'position'
  };
}

/**
 * 计算管道段长度
 */
function calculateSegmentLength(pipeline) {
  if (!pipeline.segments) return 0;
  
  return pipeline.segments.reduce((sum, seg) => {
    const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
    const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
    return sum + getDistance(p1, p2);
  }, 0);
}

/**
 * 计算两点距离
 */
function getDistance(p1, p2) {
  if (!p1 || !p2) return Infinity;
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}

/**
 * 沿完整路径排序焊点
 * @param {Array} welds - 焊点列表
 * @param {Array} completePaths - 完整管道路径
 * @param {Object} options - 选项
 * @returns {Array} - 排序后的焊点
 */
export function sortWeldsByCompletePaths(welds, completePaths, options = {}) {
  const { startPosition = 'top-left' } = options;

  if (!welds || welds.length === 0) return [];
  if (!completePaths || completePaths.length === 0) return welds;

  console.log(`🔢 按完整路径排序焊点，路径数=${completePaths.length}, 焊点数=${welds.length}`);

  const sortedWelds = [];
  const processedWeldIds = new Set();

  // 按路径位置排序（从左上到右下）
  const sortedPaths = [...completePaths].sort((a, b) => {
    const scoreA = a.start.x + a.start.y;
    const scoreB = b.start.x + b.start.y;
    return scoreA - scoreB;
  });

  // 遍历每条完整路径
  sortedPaths.forEach((path, pathIndex) => {
    console.log(`\n  📍 路径 ${pathIndex + 1}: ${path.segments.length} 段管道`);

    // 收集该路径上的所有焊点
    const pathWeldIds = new Set();
    path.segments.forEach(seg => {
      pathWeldIds.add(seg.id);
    });

    const pathWelds = welds.filter(weld => 
      weld.relatedPipelineId && pathWeldIds.has(weld.relatedPipelineId)
    );

    if (pathWelds.length === 0) {
      console.log(`    ⚠️ 路径上没有焊点`);
      return;
    }

    console.log(`    🔥 路径上有 ${pathWelds.length} 个焊点`);

    // 沿路径方向排序焊点
    const sorted = sortWeldsAlongPath(pathWelds, path);

    sorted.forEach(weld => {
      const weldId = getWeldId(weld);
      if (!processedWeldIds.has(weldId)) {
        sortedWelds.push(weld);
        processedWeldIds.add(weldId);
      }
    });

    console.log(`    ✅ 已排序 ${sorted.length} 个焊点`);
  });

  // 添加未关联的焊点
  const unassignedWelds = welds.filter(weld => 
    !processedWeldIds.has(getWeldId(weld))
  );

  if (unassignedWelds.length > 0) {
    console.log(`\n  📍 未关联焊点: ${unassignedWelds.length} 个`);
    const sorted = [...unassignedWelds].sort((a, b) => 
      getWeldX(a) - getWeldX(b)
    );
    sortedWelds.push(...sorted);
  }

  console.log(`\n  ✅ 完整路径排序完成，共 ${sortedWelds.length} 个焊点`);

  return sortedWelds;
}

/**
 * 沿路径排序焊点
 */
function sortWeldsAlongPath(welds, path) {
  if (welds.length <= 1) return welds;

  // 计算路径的总方向（从起点到终点）
  const pathVector = {
    x: path.end.x - path.start.x,
    y: path.end.y - path.start.y
  };
  const pathLength = Math.sqrt(pathVector.x ** 2 + pathVector.y ** 2);
  const pathDirection = {
    x: pathVector.x / pathLength,
    y: pathVector.y / pathLength
  };

  // 沿路径方向投影并排序
  return [...welds].sort((a, b) => {
    const projA = getWeldX(a) * pathDirection.x + getWeldY(a) * pathDirection.y;
    const projB = getWeldX(b) * pathDirection.x + getWeldY(b) * pathDirection.y;
    return projA - projB;
  });
}

/**
 * 辅助函数
 */
function getWeldX(weld) {
  return weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width / 2);
}

function getWeldY(weld) {
  return weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height / 2);
}

function getWeldId(weld) {
  return weld.id || `${weld.pathId}_${weld.pageNum}_${weld.pageIndex}`;
}

