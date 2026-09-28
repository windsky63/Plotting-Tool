/**
 * 管线网络分析工具
 * 基于“焊点-管道”的拓扑位置关系进行分析
 */

function getWeldCenter(weld) {
  return weld.center
    ? weld.center
    : {
        x: weld.boundingBox.minX + weld.boundingBox.width / 2,
        y: weld.boundingBox.minY + weld.boundingBox.height / 2
      };
}

function getSegmentEndpoints(segment) {
  const start = segment.p1 || segment.start || { x: segment.x1, y: segment.y1 };
  const end = segment.p2 || segment.end || { x: segment.x2, y: segment.y2 };
  return { start, end };
}

function calculateSegmentBoundingBox(start, end) {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function projectPointOntoSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return {
      t: 0,
      isInside: false,
      projection: { x: start.x, y: start.y },
      perpendicularDistance: Math.sqrt((point.x - start.x) ** 2 + (point.y - start.y) ** 2)
    };
  }

  const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const clampedT = Math.max(0, Math.min(1, rawT));
  const projection = {
    x: start.x + clampedT * dx,
    y: start.y + clampedT * dy
  };

  return {
    t: rawT,
    isInside: rawT >= 0 && rawT <= 1,
    projection,
    perpendicularDistance: Math.sqrt((point.x - projection.x) ** 2 + (point.y - projection.y) ** 2)
  };
}

function normalizeSingleSegmentCandidate(path) {
  if (!path?.segments || path.segments.length !== 1) {
    return null;
  }

  const [segment] = path.segments;
  if (segment?.type !== 'line') {
    return null;
  }

  const { start, end } = getSegmentEndpoints(segment);
  if (
    typeof start?.x !== 'number' ||
    typeof start?.y !== 'number' ||
    typeof end?.x !== 'number' ||
    typeof end?.y !== 'number'
  ) {
    return null;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) {
    return null;
  }

  const bbox = calculateSegmentBoundingBox(start, end);
  const normalizedSegment = {
    ...segment,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    p1: start,
    p2: end
  };

  const pseudoPipeline = {
    pathId: path.id,
    segments: [normalizedSegment],
    bbox,
    totalLength: length
  };

  return {
    pathId: path.id,
    segment: normalizedSegment,
    start,
    end,
    angle: Math.atan2(dy, dx),
    length,
    bbox,
    pipeline: pseudoPipeline
  };
}

function extractSingleSegmentPathsFromVectors(vectors) {
  const pathMap = new Map();

  vectors.forEach((vec, index) => {
    if (!Array.isArray(vec) || vec.length < 8) {
      return;
    }

    const [, x1, y1, x2, y2, color, width, pathId] = vec;
    if (pathId === undefined || pathId === null) {
      return;
    }

    if (!pathMap.has(pathId)) {
      pathMap.set(pathId, []);
    }

    pathMap.get(pathId).push({
      index,
      x1,
      y1,
      x2,
      y2,
      color,
      width
    });
  });

  return [...pathMap.entries()]
    .filter(([, segments]) => segments.length === 1)
    .map(([pathId, [segment]]) =>
      normalizeSingleSegmentCandidate({
        id: pathId,
        segments: [
          {
            type: 'line',
            x1: segment.x1,
            y1: segment.y1,
            x2: segment.x2,
            y2: segment.y2,
            p1: { x: segment.x1, y: segment.y1 },
            p2: { x: segment.x2, y: segment.y2 },
            color: segment.color,
            width: segment.width,
            vectorIndex: segment.index
          }
        ],
        vectorIndices: [segment.index]
      })
    )
    .filter(Boolean);
}

export function extractSingleSegmentPaths(vectorsOrPaths) {
  if (!Array.isArray(vectorsOrPaths) || vectorsOrPaths.length === 0) {
    return [];
  }

  const looksLikeVectorRow = Array.isArray(vectorsOrPaths[0]);
  if (looksLikeVectorRow) {
    return extractSingleSegmentPathsFromVectors(vectorsOrPaths);
  }

  const paths = vectorsOrPaths;

  return paths
    .map(normalizeSingleSegmentCandidate)
    .filter(Boolean);
}

export function associateWeldsWithSingleSegmentVectors(welds, vectorsOrPaths, threshold = 15) {
  const weldToPipelineMap = new Map();
  const pipelineToWeldsMap = new Map();
  const segmentCandidates = extractSingleSegmentPaths(vectorsOrPaths);

  welds.forEach((weld, index) => {
    const weldKey = weld.id ?? weld.pathId ?? weld.pathIndex ?? index;
    const weldCenter = getWeldCenter(weld);

    let bestInternal = null;
    let bestEndpoint = null;

    segmentCandidates.forEach((candidate) => {
      const { bbox, start, end } = candidate;

      if (
        weldCenter.x < bbox.minX - threshold ||
        weldCenter.x > bbox.maxX + threshold ||
        weldCenter.y < bbox.minY - threshold ||
        weldCenter.y > bbox.maxY + threshold
      ) {
        return;
      }

      const projection = projectPointOntoSegment(weldCenter, start, end);

      if (projection.isInside && projection.perpendicularDistance <= threshold) {
        if (
          !bestInternal ||
          projection.perpendicularDistance < bestInternal.distance ||
          (
            projection.perpendicularDistance === bestInternal.distance &&
            candidate.length > bestInternal.candidate.length
          )
        ) {
          bestInternal = {
            candidate,
            distance: projection.perpendicularDistance,
            projection
          };
        }
        return;
      }

      const endpointDistance = Math.min(
        Math.sqrt((weldCenter.x - start.x) ** 2 + (weldCenter.y - start.y) ** 2),
        Math.sqrt((weldCenter.x - end.x) ** 2 + (weldCenter.y - end.y) ** 2)
      );

      if (endpointDistance <= threshold) {
        if (
          !bestEndpoint ||
          endpointDistance < bestEndpoint.distance ||
          (
            endpointDistance === bestEndpoint.distance &&
            candidate.length > bestEndpoint.candidate.length
          )
        ) {
          bestEndpoint = {
            candidate,
            distance: endpointDistance,
            projection
          };
        }
      }
    });

    const matched = bestInternal || bestEndpoint;

    if (!matched) {
      weld.relatedSegmentId = null;
      weld.relatedSegment = null;
      weld.relatedSegmentAngle = null;
      weld.relatedSegmentDistance = null;
      weld.relatedSegmentMatchType = null;
      weld.relatedPipelineId = null;
      weld.relatedPipeline = null;
      return;
    }

    const { candidate } = matched;

    weld.relatedSegmentId = candidate.pathId;
    weld.relatedSegment = candidate;
    weld.relatedSegmentAngle = candidate.angle;
    weld.relatedSegmentDistance = matched.distance;
    weld.relatedSegmentMatchType = matched === bestInternal ? 'centerline' : 'endpoint';
    weld.relatedPipelineId = candidate.pathId;
    weld.relatedPipeline = candidate.pipeline;

    weldToPipelineMap.set(weldKey, candidate.pathId);
    if (!pipelineToWeldsMap.has(candidate.pathId)) {
      pipelineToWeldsMap.set(candidate.pathId, []);
    }
    pipelineToWeldsMap.get(candidate.pathId).push(weld);
  });

  return {
    weldToPipelineMap,
    pipelineToWeldsMap,
    segmentCandidates
  };
}

/**
 * 关联焊点与管道（建立拓扑关系）
 * 解决 "哪个焊点属于哪根管道" 的问题，用于优化标注引线方向，避免遮挡管道
 * 
 * @param {Array} welds - 焊点列表
 * @param {Array} pipelines - 管道列表
 * @param {number} threshold - 判定阈值（距离管道线段的距离）
 * @returns {Object} - { weldToPipelineMap, pipelineToWeldsMap }
 */
export function associateWeldsWithPipelines(welds, pipelines, threshold = 15) {
  const weldToPipelineMap = new Map(); // weldId -> pipelineId
  const pipelineToWeldsMap = new Map(); // pipelineId -> [weldId, ...]

  welds.forEach(weld => {
    let bestPipe = null;
    let minDistance = Infinity;
    
    // 焊点中心
    const weldX = weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width/2);
    const weldY = weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height/2);
    const weldPoint = { x: weldX, y: weldY };

    pipelines.forEach(pipe => {
      // 快速包围盒检测 (扩大一点范围)
      const bbox = pipe.bbox;
      if (bbox) {
        if (weldX < bbox.minX - threshold || weldX > bbox.maxX + threshold ||
            weldY < bbox.minY - threshold || weldY > bbox.maxY + threshold) {
          return; // 距离太远，跳过
        }
      }

      // 详细检测：计算焊点到管道每条线段的最短距离
      pipe.segments.forEach(seg => {
        const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
        const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
        
        if (p1 && p2) {
          const dist = getDistancePointToSegment(weldPoint, p1, p2);
          if (dist < minDistance) {
            minDistance = dist;
            bestPipe = pipe;
          }
        }
      });
    });

    // 找到最佳匹配
    if (bestPipe && minDistance <= threshold) {
      // 记录关系
      weldToPipelineMap.set(weld.id, bestPipe.pathId); // 注意: weld.id 需要确保存在，否则用索引
      
      // 反向记录
      if (!pipelineToWeldsMap.has(bestPipe.pathId)) {
        pipelineToWeldsMap.set(bestPipe.pathId, []);
      }
      pipelineToWeldsMap.get(bestPipe.pathId).push(weld);
      
      // 直接挂载到对象上（方便直接读取）
      weld.relatedPipelineId = bestPipe.pathId;
      weld.relatedPipeline = bestPipe;
    }
  });

  return { weldToPipelineMap, pipelineToWeldsMap };
}

/**
 * 关联流向箭头与管道
 * 只有当箭头紧挨着管道时才认为是有效箭头
 * 
 * @param {Array} flowArrows - 流向箭头列表 (path 对象)
 * @param {Array} pipelines - 管道列表
 * @param {number} threshold - 距离阈值 (默认 5，紧贴着管道)
 * @returns {Array} - 有效的流向箭头列表 (每个箭头对象增加 relatedPipelineId 属性)
 */
export function associateArrowsWithPipelines(flowArrows, pipelines, threshold = 5) {
  const validArrows = [];
  
  flowArrows.forEach(arrow => {
    // 计算箭头中心点
    const arrowBbox = arrow.features?.bbox || calculateBoundingBoxFromSegments(arrow.segments);
    const arrowCenter = {
      x: arrowBbox.minX + arrowBbox.width / 2,
      y: arrowBbox.minY + arrowBbox.height / 2
    };
    
    let bestPipe = null;
    let minDistance = Infinity;
    
    pipelines.forEach(pipe => {
      // 快速包围盒检测 (扩大范围)
      const pipeBbox = pipe.bbox;
      if (pipeBbox) {
        // 如果箭头在管道包围盒外很远，直接跳过
        if (arrowCenter.x < pipeBbox.minX - 50 || arrowCenter.x > pipeBbox.maxX + 50 ||
            arrowCenter.y < pipeBbox.minY - 50 || arrowCenter.y > pipeBbox.maxY + 50) {
          return; 
        }
      }
      
      // 详细检测：计算箭头中心到管道每一条边的距离
      pipe.segments.forEach(seg => {
        // 兼容不同的 segment 数据结构
        const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
        const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
        
        if (p1 && p2) {
          const dist = getDistancePointToSegment(arrowCenter, p1, p2);
          if (dist < minDistance) {
            minDistance = dist;
            bestPipe = pipe;
          }
        }
      });
    });
    
    // 如果距离在阈值内，说明箭头确实是依附在管道上的
    if (bestPipe && minDistance <= threshold) {
      arrow.relatedPipelineId = bestPipe.pathId;
      validArrows.push(arrow);
    }
  });
  
  return validArrows;
}

/**
 * 辅助：从线段计算包围盒
 */
function calculateBoundingBoxFromSegments(segments) {
  if (!segments || segments.length === 0) return { minX:0, minY:0, maxX:0, maxY:0, width:0, height:0 };
  
  const allX = segments.flatMap(s => [s.x1, s.x2]);
  const allY = segments.flatMap(s => [s.y1, s.y2]);
  
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  
  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * 计算点到线段的最短距离
 */
function getDistancePointToSegment(p, v, w) {
  const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
  
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  
  const projectionX = v.x + t * (w.x - v.x);
  const projectionY = v.y + t * (w.y - v.y);
  
  return Math.sqrt((p.x - projectionX) ** 2 + (p.y - projectionY) ** 2);
}

/**
 * 核心算法：根据焊点位置过滤有效管道（改进版：保留连续性）
 * 策略：
 * 1. 首先标记所有靠近焊点的管道（直接关联）
 * 2. 然后补充那些连接这些管道的中间管段（保持连续性）
 * 
 * @param {Array} pipelines - 候选管道列表 (来自 SimplePipelineDetector)
 * @param {Array} welds - 焊点列表 (来自 ObjectRecognizer)
 * @param {number} threshold - 吸附阈值 (默认 50，单位：PDF坐标点)
 * @returns {Array} - 经过验证的管道列表
 */
export function filterPipelinesByWelds(pipelines, welds, threshold = 50) {
  if (!pipelines || pipelines.length === 0) return [];
  if (!welds || welds.length === 0) return []; // 如果没有焊点，保守策略是不返回管道，或者返回全部(视需求而定)

  const directlyConnectedIds = new Set(); // 直接与焊点关联的管道
  const debugStats = { checked: 0, directlyMatched: 0, bridgeAdded: 0 };

  // 第一步：标记所有直接与焊点关联的管道
  pipelines.forEach(pipe => {
    debugStats.checked++;
    
    // 获取管道的关键点（起点、终点、中心点）
    const segments = pipe.segments;
    let pointsToCheck = [];
    
    if (segments.length > 0) {
      // 简单取所有线段的端点（去重后最多4个点）
      segments.forEach(seg => {
        const start = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
        const end = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
        
        if (start && typeof start.x === 'number') {
          pointsToCheck.push({ x: start.x, y: start.y });
        }
        
        if (end && typeof end.x === 'number') {
          pointsToCheck.push({ x: end.x, y: end.y });
        }
      });
      
      // 也加入中心点
      if (pipe.bbox) {
        pointsToCheck.push({
          x: pipe.bbox.minX + pipe.bbox.width / 2,
          y: pipe.bbox.minY + pipe.bbox.height / 2
        });
      }
    }

    // 检查这些点是否在任意焊点的范围内
    const isConnected = welds.some(weld => {
      const weldX = weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width/2);
      const weldY = weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height/2);

      return pointsToCheck.some(point => {
        const dist = Math.sqrt(Math.pow(point.x - weldX, 2) + Math.pow(point.y - weldY, 2));
        return dist < threshold;
      });
    });

    if (isConnected) {
      directlyConnectedIds.add(pipe.pathId);
      debugStats.directlyMatched++;
    }
  });

  // 第二步：补充连接这些管道的中间管段（桥接段）
  // 策略：如果一个管道的两端都非常接近已标记的管道，则认为它是桥接段
  const bridgeThreshold = 20; // 桥接段的距离阈值（更严格）
  const allValidIds = new Set(directlyConnectedIds);
  const bridgeSegments = []; // 记录桥接段详情
  
  let bridgeChanged = true;
  let iterations = 0;
  const maxIterations = 10; // 防止无限循环
  
  while (bridgeChanged && iterations < maxIterations) {
    bridgeChanged = false;
    iterations++;
    
    pipelines.forEach(candidatePipe => {
      if (allValidIds.has(candidatePipe.pathId)) return; // 已标记
      
      // 检查候选管道是否连接两个已标记的管道
      const validPipes = pipelines.filter(p => allValidIds.has(p.pathId));
      
      // 计算候选管道与已标记管道的最短距离
      let minDist = Infinity;
      let nearCount = 0;
      let nearestPipeId = null;
      
      validPipes.forEach(validPipe => {
        const dist = calculatePipeDistance(candidatePipe, validPipe);
        if (dist < bridgeThreshold) {
          nearCount++;
          if (dist < minDist) {
            minDist = dist;
            nearestPipeId = validPipe.pathId;
          }
        }
      });
      
      // 如果候选管道接近至少一个已标记的管道，且距离很近，则添加为桥接段
      if (nearCount >= 1 && minDist < bridgeThreshold) {
        allValidIds.add(candidatePipe.pathId);
        debugStats.bridgeAdded++;
        bridgeChanged = true;
        bridgeSegments.push({
          pathId: candidatePipe.pathId,
          distance: minDist.toFixed(1),
          nearestPipe: nearestPipeId,
          iteration: iterations
        });
      }
    });
  }

  const validPipelines = pipelines.filter(p => allValidIds.has(p.pathId));
  
  console.log(`🔗 管线拓扑分析: 候选 ${debugStats.checked} -> 直接匹配 ${debugStats.directlyMatched} + 桥接补充 ${debugStats.bridgeAdded} = 总计 ${validPipelines.length} (阈值: 焊点${threshold}px, 桥接${bridgeThreshold}px, ${iterations}次迭代)`);
  
  // 显示桥接段详情（前10个）
  if (bridgeSegments.length > 0) {
    console.log(`   🌉 桥接补充详情 (显示前10个):`);
    bridgeSegments.slice(0, 10).forEach((seg, idx) => {
      console.log(`      ${idx + 1}. 管道${seg.pathId} ← 距离管道${seg.nearestPipe} ${seg.distance}px (第${seg.iteration}轮)`);
    });
    if (bridgeSegments.length > 10) {
      console.log(`      ... 以及其他 ${bridgeSegments.length - 10} 个桥接段`);
    }
  }
  
  return validPipelines;
}

/**
 * 计算两个管道之间的最短距离
 */
function calculatePipeDistance(pipe1, pipe2) {
  // 获取两个管道的端点
  const getEndpoints = (pipe) => {
    const points = [];
    if (pipe.segments && pipe.segments.length > 0) {
      pipe.segments.forEach(seg => {
        const start = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
        const end = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
        if (start) points.push(start);
        if (end) points.push(end);
      });
    }
    return points;
  };
  
  const points1 = getEndpoints(pipe1);
  const points2 = getEndpoints(pipe2);
  
  let minDist = Infinity;
  
  points1.forEach(p1 => {
    points2.forEach(p2 => {
      const dist = Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
      minDist = Math.min(minDist, dist);
    });
  });
  
  return minDist;
}

/**
 * 计算管线区域的边界框
 * 包括所有焊点和有效管道的范围
 * 
 * @param {Array} pipelines - 有效管道
 * @param {Array} welds - 焊点
 * @param {number} padding - 边缘留白
 * @returns {Object} - { minX, minY, maxX, maxY, width, height }
 */
export function calculatePipelineArea(pipelines, welds, padding = 20) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasData = false;

  // 1. 包含所有焊点范围
  welds.forEach(weld => {
    const bbox = weld.boundingBox;
    if (bbox) {
      minX = Math.min(minX, bbox.minX);
      minY = Math.min(minY, bbox.minY);
      maxX = Math.max(maxX, bbox.maxX);
      maxY = Math.max(maxY, bbox.maxY);
      hasData = true;
    }
  });

  // 2. 包含所有有效管道范围
  pipelines.forEach(pipe => {
    const bbox = pipe.bbox;
    if (bbox) {
      minX = Math.min(minX, bbox.minX);
      minY = Math.min(minY, bbox.minY);
      maxX = Math.max(maxX, bbox.maxX);
      maxY = Math.max(maxY, bbox.maxY);
      hasData = true;
    }
  });

  if (!hasData) return null;

  // 添加 Padding
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
    width: (maxX + padding) - (minX - padding),
    height: (maxY + padding) - (minY - padding)
  };
}
