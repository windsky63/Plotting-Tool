/**
 * 管道段合并器
 * 将多个物理连续的管道段合并成完整的"管子"
 */

/**
 * 合并管道段为完整管子
 * @param {Array} pipelines - 管道列表
 * @param {Array} welds - 焊点列表
 * @param {Map} pipelineGraph - 管道连接图
 * @returns {Array} - 合并后的管子列表
 */
export function mergePipelineSegments(pipelines, welds, pipelineGraph) {
  console.log('🔗 开始合并管道段...');
  
  const visited = new Set();
  const mergedPipes = [];
  let pipeId = 1;
  
  pipelines.forEach(startPipe => {
    if (visited.has(startPipe.pathId)) return;
    
    // 从这根管道开始，沿着直线方向合并
    const mergedPipe = {
      id: `PIPE-${pipeId++}`,
      segments: [startPipe],
      pathIds: [startPipe.pathId],
      totalLength: startPipe.totalLength || 0,
      welds: [],
      type: startPipe.type || 'merged' // 🌟 保留管道类型（main/branch）
    };
    
    visited.add(startPipe.pathId);
    
    // 向两个方向扩展
    extendPipeInDirection(startPipe, mergedPipe, pipelines, pipelineGraph, visited, 'forward');
    extendPipeInDirection(startPipe, mergedPipe, pipelines, pipelineGraph, visited, 'backward');
    
    // 收集这根管子上的焊点
    mergedPipe.welds = findWeldsOnPipe(mergedPipe.segments, welds);
    
    mergedPipes.push(mergedPipe);
  });
  
  console.log(`✅ 合并完成: ${pipelines.length} 段 -> ${mergedPipes.length} 根管子`);
  mergedPipes.forEach((pipe, i) => {
    console.log(`   管子${pipe.id} [${pipe.type}]: ${pipe.segments.length} 段, ${pipe.welds.length} 个焊点, 总长 ${pipe.totalLength.toFixed(1)}`);
  });
  
  return mergedPipes;
}

/**
 * 沿着直线方向扩展管道
 */
function extendPipeInDirection(currentPipe, mergedPipe, allPipelines, pipelineGraph, visited, direction) {
  const node = pipelineGraph.get(currentPipe.pathId);
  if (!node) return;
  
  // 找出所有连接的管道
  const connectedPipes = node.connections
    .map(id => allPipelines.find(p => p.pathId === id))
    .filter(p => p && !visited.has(p.pathId));
  
  if (connectedPipes.length === 0) return;
  
  // 🌟 当前管道的类型（main/branch）
  const currentType = currentPipe.type;
  
  // 如果只有一个连接，且方向一致，继续合并
  if (connectedPipes.length === 1) {
    const nextPipe = connectedPipes[0];
    const alignment = calculateDirectionAlignment(currentPipe, nextPipe);
    
    // 🌟 类型相同 + 方向一致（直线延伸）
    const sameType = !currentType || !nextPipe.type || currentType === nextPipe.type;
    
    // 🌟 策略：如果类型已确定，则必须严格匹配；如果类型一致，则放宽方向要求
    let shouldMerge = false;
    if (sameType) {
      // 同类型：放宽到 0.7（约45度）
      shouldMerge = alignment > 0.7;
    } else if (!currentType && !nextPipe.type) {
      // 两者都未分类：使用更严格的阈值 0.85
      shouldMerge = alignment > 0.85;
    }
    
    if (shouldMerge) {
      visited.add(nextPipe.pathId);
      
      if (direction === 'forward') {
        mergedPipe.segments.push(nextPipe);
        mergedPipe.pathIds.push(nextPipe.pathId);
      } else {
        mergedPipe.segments.unshift(nextPipe);
        mergedPipe.pathIds.unshift(nextPipe.pathId);
      }
      
      mergedPipe.totalLength += nextPipe.totalLength || 0;
      
      // 继续递归扩展
      extendPipeInDirection(nextPipe, mergedPipe, allPipelines, pipelineGraph, visited, direction);
    } else if (!sameType) {
      console.log(`     ⚠️ 类型不同，停止合并: ${currentPipe.pathId} [${currentType}] -> ${nextPipe.pathId} [${nextPipe.type}]`);
    } else {
      console.log(`     ⚠️ 方向不一致，停止合并: ${currentPipe.pathId} -> ${nextPipe.pathId} (对齐度: ${alignment.toFixed(2)})`);
    }
  }
  
  // 如果有多个连接（三通），选择方向最一致 且 类型相同 的那个
  if (connectedPipes.length > 1) {
    let bestPipe = null;
    let bestAlignment = 0;
    
    // 🌟 优先选择同类型的管道
    const sameTypePipes = connectedPipes.filter(pipe => 
      !currentType || !pipe.type || currentType === pipe.type
    );
    
    const candidatePipes = sameTypePipes.length > 0 ? sameTypePipes : connectedPipes;
    
    candidatePipes.forEach(pipe => {
      const alignment = calculateDirectionAlignment(currentPipe, pipe);
      if (alignment > bestAlignment) {
        bestAlignment = alignment;
        bestPipe = pipe;
      }
    });
    
    // 🌟 三通处的合并策略：类型必须严格匹配
    const sameType = currentType && bestPipe?.type && currentType === bestPipe.type;
    const bothUntyped = !currentType && !bestPipe?.type;
    
    let shouldMerge = false;
    if (sameType) {
      // 类型匹配：放宽到 0.7（约45度）
      shouldMerge = bestAlignment > 0.7;
    } else if (bothUntyped) {
      // 都未分类：使用严格阈值 0.9
      shouldMerge = bestAlignment > 0.9;
    }
    
    if (bestPipe && shouldMerge) {
      visited.add(bestPipe.pathId);
      
      if (direction === 'forward') {
        mergedPipe.segments.push(bestPipe);
        mergedPipe.pathIds.push(bestPipe.pathId);
      } else {
        mergedPipe.segments.unshift(bestPipe);
        mergedPipe.pathIds.unshift(bestPipe.pathId);
      }
      
      mergedPipe.totalLength += bestPipe.totalLength || 0;
      
      console.log(`     🔗 三通处合并同类型管道: ${currentPipe.pathId} [${currentType}] -> ${bestPipe.pathId} [${bestPipe.type}] (对齐度: ${bestAlignment.toFixed(2)})`);
      
      // 继续递归扩展
      extendPipeInDirection(bestPipe, mergedPipe, allPipelines, pipelineGraph, visited, direction);
    } else {
      if (bestPipe) {
        console.log(`     ⛔ 三通处停止合并: bestAlignment=${bestAlignment.toFixed(2)}, sameType=${sameType}, currentType=${currentType}, bestPipeType=${bestPipe?.type}`);
      }
    }
  }
}

/**
 * 计算两根管道的方向一致性
 */
function calculateDirectionAlignment(pipe1, pipe2) {
  const getMainDirection = (pipe) => {
    if (!pipe.segments || pipe.segments.length === 0) return null;
    
    // 找最长的线段作为主方向
    let longestSeg = pipe.segments[0];
    let maxLen = 0;
    
    pipe.segments.forEach(seg => {
      const len = Math.sqrt(Math.pow(seg.x2 - seg.x1, 2) + Math.pow(seg.y2 - seg.y1, 2));
      if (len > maxLen) {
        maxLen = len;
        longestSeg = seg;
      }
    });
    
    const dx = longestSeg.x2 - longestSeg.x1;
    const dy = longestSeg.y2 - longestSeg.y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    return len > 0 ? { dx: dx / len, dy: dy / len } : null;
  };
  
  const dir1 = getMainDirection(pipe1);
  const dir2 = getMainDirection(pipe2);
  
  if (!dir1 || !dir2) return 0;
  
  // 计算点积的绝对值（因为方向可能相反）
  const dotProduct = Math.abs(dir1.dx * dir2.dx + dir1.dy * dir2.dy);
  
  return dotProduct;
}

/**
 * 找出在管道上的焊点
 */
function findWeldsOnPipe(pipeSegments, welds) {
  const weldsOnPipe = [];
  
  welds.forEach(weld => {
    const weldX = weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width / 2);
    const weldY = weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height / 2);
    const weldPoint = { x: weldX, y: weldY };
    
    // 检查焊点是否靠近任何一段管道
    const isOnPipe = pipeSegments.some(pipe => {
      return pipe.segments.some(seg => {
        const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
        const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
        
        if (!p1 || !p2) return false;
        
        const dist = getDistancePointToSegment(weldPoint, p1, p2);
        return dist < 20; // 20px 阈值
      });
    });
    
    if (isOnPipe) {
      weldsOnPipe.push(weld);
    }
  });
  
  return weldsOnPipe;
}

/**
 * 计算点到线段的距离
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

