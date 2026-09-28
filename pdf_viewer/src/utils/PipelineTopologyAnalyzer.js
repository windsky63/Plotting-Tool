/**
 * 管线拓扑分析器
 * 根据流向箭头和管道的连接关系，分析主管、支管和流向
 */

import { mergePipelineSegments } from './PipelineSegmentMerger';

/**
 * 分析管线网络拓扑结构
 * @param {Array} pipelines - 有效管道列表
 * @param {Array} flowArrows - 有效流向箭头列表
 * @param {Array} welds - 焊点列表
 * @param {Array} tees - 三通列表（可选）
 * @returns {Object} - 拓扑分析结果
 */
export function analyzePipelineTopology(pipelines, flowArrows, welds, tees = []) {
  console.log('🔍 开始管线拓扑分析...');
  
  // 1. 构建管道连接图（基于焊点、端点和流向箭头）
  const pipelineGraph = buildPipelineGraph(pipelines, welds, flowArrows);
  
  // 2. 确定流向（基于原始管道段）
  const flowDirections = determineFlowDirections(pipelines, flowArrows);
  
  // 🌟 3. 如果有三通数据，使用基于三通的拓扑分析；否则全部视为主管
  let mainPipePathIds = new Set();
  let branchPipePathIds = new Set();
  
  if (tees && tees.length > 0) {
    console.log('🧩 使用基于三通的拓扑分析...');
    const teeResult = classifyByTeeTopology(pipelines, tees, pipelineGraph);
    mainPipePathIds = teeResult.mainPipePathIds;
    branchPipePathIds = teeResult.branchPipePathIds;
  } else {
    console.log('📊 无三通数据 -> 所有管道视为主管（不区分主管/支管）');
    // 🔧 关键修改：没有三通时，所有管道都是主管
    pipelines.forEach(p => {
      mainPipePathIds.add(p.pathId);
    });
  }
  
  const mainPipelines = pipelines.filter(p => mainPipePathIds.has(p.pathId));
  const branchPipelines = pipelines.filter(p => branchPipePathIds.has(p.pathId));
  
  // 🔧 修复：先给每个管道段设置类型，再分别合并
  // 设置每个管道段的类型
  pipelines.forEach(p => {
    if (mainPipePathIds.has(p.pathId)) {
      p.type = 'main';
    } else if (branchPipePathIds.has(p.pathId)) {
      p.type = 'branch';
    } else {
      p.type = 'unknown';
    }
  });
  
  // 分别合并主管段和支管段（这样不会混淆）
  const mainPipelinesWithType = pipelines.filter(p => p.type === 'main');
  const branchPipelinesWithType = pipelines.filter(p => p.type === 'branch');
  
  // 🔧 基于三通构建主管和支管
  let mergedMainPipes = [];
  let mergedBranchPipesResult = [];
  
  if (tees && tees.length > 0) {
    // 有三通数据：基于三通构建主管（所有三通的"一"连接成一条路径）
    console.log(`🔧 基于三通构建主管和支管（三通数量: ${tees.length}）...`);
    
    // 构建主管：从三通的主管段开始，沿直线追踪形成完整主管
    mergedMainPipes = buildMainPipeFromTees(
      tees,
      pipelines,
      mainPipelinesWithType,
      mainPipePathIds,
      welds,
      pipelineGraph
    );
    
    // 构建支管：每个三通产生一根独立的支管
    mergedBranchPipesResult = buildBranchPipesFromTees(
      tees, 
      pipelines, 
      branchPipelinesWithType, 
      branchPipePathIds,
      welds,
      pipelineGraph
    );
  } else {
    // 没有三通数据：所有管道合并为主管，无支管
    console.log(`📊 无三通数据，合并所有管道为主管...`);
    const mainPipelineGraph = buildPipelineGraph(mainPipelinesWithType, welds, []);
    mergedMainPipes = mergePipelineSegments(mainPipelinesWithType, welds, mainPipelineGraph);
    
    // 🔧 无支管
    mergedBranchPipesResult = [];
  }
  
  // 主管：取合并后最长的那根（通常只有一根）
  const mainPipe = mergedMainPipes.length > 0 ? mergedMainPipes.reduce((longest, current) => 
    current.totalLength > longest.totalLength ? current : longest
  ) : null;
  
  // 支管：所有合并后的支管
  const branchPipes = mergedBranchPipesResult;
  
  // 合并所有管子（用于整体统计）
  const mergedPipes = [...mergedMainPipes, ...mergedBranchPipesResult];
  
  console.log(`✅ 拓扑分析完成:`);
  console.log(`   主管: ${mergedMainPipes.length} 根 (${mainPipe ? mainPipe.segments.length : 0} 段, ${mainPipe ? mainPipe.welds.length : 0} 个焊点)`);
  console.log(`   支管: ${branchPipes.length} 根 (三通数量: ${tees?.length || 0})`);
  branchPipes.forEach((pipe, i) => {
    console.log(`      支管${i+1}: ${pipe.segments.length} 段, ${pipe.welds.length} 焊点, 总长 ${pipe.totalLength.toFixed(1)}`);
  });
  
  return {
    graph: pipelineGraph,
    flowDirections,
    mergedPipes,
    mainPipe,
    mergedBranchPipes: branchPipes,
    mainPipes: mainPipelines.map(p => ({ ...p, type: 'main' })),
    branchPipes: branchPipelines.map(p => ({ ...p, type: 'branch' }))
  };
}

/**
 * 构建管道连接图
 * 通过焊点、端点邻近和流向箭头判断哪些管道是相连的
 */
function buildPipelineGraph(pipelines, welds, flowArrows = []) {
  const graph = new Map(); // pipelineId -> { connections: [pipelineId], welds: [weld] }
  
  // 初始化图节点
  pipelines.forEach(pipe => {
    graph.set(pipe.pathId, {
      pipeline: pipe,
      connections: [],
      welds: []
    });
  });
  
  console.log(`   📐 构建管道连接图...`);
  
  let weldConnections = 0;
  let endpointConnections = 0;
  let arrowConnections = 0;
  
  // 方法1：通过焊点建立连接
  welds.forEach(weld => {
    const weldX = weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width / 2);
    const weldY = weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height / 2);
    const weldPoint = { x: weldX, y: weldY };
    
    // 找出所有靠近这个焊点的管道
    const connectedPipes = [];
    pipelines.forEach(pipe => {
      const isNear = isPointNearPipeline(weldPoint, pipe, 25); // 放宽到 25px
      if (isNear) {
        connectedPipes.push(pipe.pathId);
      }
    });
    
    // 如果有2根或更多管道连接到这个焊点，说明它们相连
    if (connectedPipes.length >= 2) {
      connectedPipes.forEach(pipeId => {
        const node = graph.get(pipeId);
        if (node) {
          // 记录与此管道相连的其他管道
          connectedPipes.forEach(otherPipeId => {
            if (otherPipeId !== pipeId && !node.connections.includes(otherPipeId)) {
              node.connections.push(otherPipeId);
              weldConnections++;
            }
          });
          // 记录这个焊点
          node.welds.push(weld);
        }
      });
    }
  });
  
  // 方法2：通过端点邻近建立连接（补充方法，用于没有焊点标记的连接）
  const endpointThreshold = 5.0; // 端点距离阈值
  
  for (let i = 0; i < pipelines.length; i++) {
    for (let j = i + 1; j < pipelines.length; j++) {
      const pipe1 = pipelines[i];
      const pipe2 = pipelines[j];
      
      // 获取两个管道的端点
      const endpoints1 = getStructureEndpoints(pipe1);
      const endpoints2 = getStructureEndpoints(pipe2);
      
      // 检查端点是否足够接近
      let isConnected = false;
      for (const ep1 of endpoints1) {
        for (const ep2 of endpoints2) {
          const dist = Math.sqrt(
            (ep1.x - ep2.x) ** 2 + (ep1.y - ep2.y) ** 2
          );
          if (dist < endpointThreshold) {
            isConnected = true;
            break;
          }
        }
        if (isConnected) break;
      }
      
      // 如果端点接近且尚未建立连接，建立连接
      if (isConnected) {
        const node1 = graph.get(pipe1.pathId);
        const node2 = graph.get(pipe2.pathId);
        
        if (node1 && !node1.connections.includes(pipe2.pathId)) {
          node1.connections.push(pipe2.pathId);
          endpointConnections++;
        }
        if (node2 && !node2.connections.includes(pipe1.pathId)) {
          node2.connections.push(pipe1.pathId);
          endpointConnections++;
        }
      }
    }
  }
  
  // 🌟 方法3：通过流向箭头建立连接（关键：解决箭头位置管道断开问题）
  flowArrows.forEach(arrow => {
    // 找出所有靠近这个箭头的管道
    const arrowCenter = calculateArrowCenter(arrow);
    const connectedPipes = [];
    
    pipelines.forEach(pipe => {
      const isNear = isPointNearPipeline(arrowCenter, pipe, 30); // 30px 阈值
      if (isNear) {
        connectedPipes.push(pipe.pathId);
      }
    });
    
    // 如果有2根或更多管道靠近这个箭头，它们应该相连（箭头在管道上）
    if (connectedPipes.length >= 2) {
      connectedPipes.forEach(pipeId => {
        const node = graph.get(pipeId);
        if (node) {
          connectedPipes.forEach(otherPipeId => {
            if (otherPipeId !== pipeId && !node.connections.includes(otherPipeId)) {
              node.connections.push(otherPipeId);
              arrowConnections++;
            }
          });
        }
      });
    }
  });
  
  // 统计连接情况
  console.log(`     ✅ 焊点连接: ${weldConnections / 2} 对`);
  console.log(`     ✅ 端点连接: ${endpointConnections / 2} 对`);
  console.log(`     ✅ 箭头连接: ${arrowConnections / 2} 对`);
  console.log(`     📊 总计: ${(weldConnections + endpointConnections + arrowConnections) / 2} 对`);
  
  return graph;
}

/**
 * 计算箭头的中心点
 */
function calculateArrowCenter(arrow) {
  const segments = arrow.segments;
  if (!segments || segments.length === 0) {
    return { x: 0, y: 0 };
  }
  
  const allPoints = segments.flatMap(s => [
    { x: s.x1, y: s.y1 },
    { x: s.x2, y: s.y2 }
  ]);
  
  const centerX = allPoints.reduce((sum, p) => sum + p.x, 0) / allPoints.length;
  const centerY = allPoints.reduce((sum, p) => sum + p.y, 0) / allPoints.length;
  
  return { x: centerX, y: centerY };
}

/**
 * 确定管道的流向
 * 基于流向箭头的方向
 */
function determineFlowDirections(pipelines, flowArrows) {
  const directions = new Map(); // pipelineId -> { angle, direction: 'up'|'down'|'left'|'right' }
  
  flowArrows.forEach(arrow => {
    const pipelineId = arrow.relatedPipelineId;
    if (!pipelineId) return;
    
    // 计算箭头的朝向
    // 箭头通常是三角形，找出尖端方向
    const arrowDirection = calculateArrowDirection(arrow);
    
    directions.set(pipelineId, arrowDirection);
  });
  
  return directions;
}

/**
 * 计算箭头的朝向
 */
function calculateArrowDirection(arrow) {
  const segments = arrow.segments;
  if (!segments || segments.length === 0) {
    return { angle: 0, direction: 'unknown' };
  }
  
  // 计算箭头的中心点和顶点
  const allPoints = segments.flatMap(s => [
    { x: s.x1, y: s.y1 },
    { x: s.x2, y: s.y2 }
  ]);
  
  // 去重
  const uniquePoints = [];
  allPoints.forEach(p => {
    if (!uniquePoints.some(up => Math.abs(up.x - p.x) < 0.1 && Math.abs(up.y - p.y) < 0.1)) {
      uniquePoints.push(p);
    }
  });
  
  if (uniquePoints.length < 3) {
    return { angle: 0, direction: 'unknown' };
  }
  
  // 找出质心
  const centerX = uniquePoints.reduce((sum, p) => sum + p.x, 0) / uniquePoints.length;
  const centerY = uniquePoints.reduce((sum, p) => sum + p.y, 0) / uniquePoints.length;
  
  // 找出离质心最远的点（通常是箭头的尖端）
  let maxDist = 0;
  let tipPoint = uniquePoints[0];
  uniquePoints.forEach(p => {
    const dist = Math.sqrt(Math.pow(p.x - centerX, 2) + Math.pow(p.y - centerY, 2));
    if (dist > maxDist) {
      maxDist = dist;
      tipPoint = p;
    }
  });
  
  // 计算从质心到尖端的角度
  const angle = Math.atan2(tipPoint.y - centerY, tipPoint.x - centerX) * 180 / Math.PI;
  
  // 转换为方向
  let direction = 'right';
  if (angle >= -45 && angle < 45) direction = 'right';
  else if (angle >= 45 && angle < 135) direction = 'down';
  else if (angle >= 135 || angle < -135) direction = 'left';
  else direction = 'up';
  
  return { angle, direction };
}

/**
 * 🔧 基于三通构建主管
 * 主管是所有三通的"一"（横杠两段）连接起来形成的一条完整路径
 */
function buildMainPipeFromTees(tees, allPipelines, mainPipelines, mainPipePathIds, welds, pipelineGraph) {
  if (mainPipelines.length === 0) {
    console.log(`   ⚠️ 没有主管段，返回空列表`);
    return [];
  }
  
  console.log(`   🔵 开始构建主管（主管段数量: ${mainPipelines.length}）...`);
  
  const usedPathIds = new Set();
  
  // 收集所有三通的主管段
  const teeMainSegmentIds = new Set();
  tees.forEach((tee) => {
    const teeParts = tee.parts.map(pathId => 
      allPipelines.find(p => p.pathId === pathId)
    ).filter(p => p);
    
    if (teeParts.length === 3) {
      const { mainSegments } = identifyMainBranchInTee(teeParts, tee.center);
      mainSegments.forEach(seg => teeMainSegmentIds.add(seg.pathId));
    }
  });
  
  console.log(`   📊 三通中的主管段: ${teeMainSegmentIds.size} 个`);
  
  // 找到主管的起点：选择连接数最少的端点管道段（通常是主管的两端之一）
  let startPipe = null;
  let minConnections = Infinity;
  
  mainPipelines.forEach(pipe => {
    const node = pipelineGraph.get(pipe.pathId);
    if (node) {
      // 计算与其他主管段的连接数
      const mainConnections = node.connections.filter(id => mainPipePathIds.has(id)).length;
      if (mainConnections < minConnections) {
        minConnections = mainConnections;
        startPipe = pipe;
      }
    }
  });
  
  if (!startPipe) {
    startPipe = mainPipelines[0];
  }
  
  console.log(`   🚀 主管起点: ${startPipe.pathId} (连接数: ${minConnections})`);
  
  // 从起点开始，沿着直线方向追踪所有主管段
  const mainPipe = {
    id: 'MAIN-1',
    segments: [startPipe],
    pathIds: [startPipe.pathId],
    totalLength: startPipe.totalLength || 0,
    welds: [],
    type: 'main'
  };
  
  usedPathIds.add(startPipe.pathId);
  
  // 向两个方向扩展主管
  extendMainPipeFromTees(startPipe, mainPipe, mainPipelines, mainPipePathIds, pipelineGraph, usedPathIds, 'forward');
  extendMainPipeFromTees(startPipe, mainPipe, mainPipelines, mainPipePathIds, pipelineGraph, usedPathIds, 'backward');
  
  // 🔧 修复：收集所有主管段上的焊点，而不只是连续主管段
  // 使用 mainPipelines（所有被分类为主管的管道段）而不是 mainPipe.segments（只有连续的管道段）
  mainPipe.welds = findWeldsOnBranchPipe(mainPipelines, welds);
  
  console.log(`   ✅ 主管构建完成: ${mainPipe.segments.length} 段连续, ${mainPipe.welds.length} 焊点 (来自所有 ${mainPipelines.length} 段主管), 总长 ${mainPipe.totalLength.toFixed(1)}`);
  
  // 检查是否有未分配的主管段
  const unassignedMainPipes = mainPipelines.filter(p => !usedPathIds.has(p.pathId));
  if (unassignedMainPipes.length > 0) {
    console.log(`   ⚠️ 有 ${unassignedMainPipes.length} 个主管段未形成连续路径（但其焊点已包含在主管焊点中）`);
  }
  
  return [mainPipe]; // 返回数组格式，与之前的接口一致
}

/**
 * 从起点向两个方向扩展主管
 */
function extendMainPipeFromTees(currentPipe, mainPipe, mainPipelines, mainPipePathIds, pipelineGraph, usedPathIds, direction) {
  const node = pipelineGraph.get(currentPipe.pathId);
  if (!node) return;
  
  // 找出所有连接的主管段（排除已使用的）
  const connectedMainPipes = node.connections
    .filter(id => mainPipePathIds.has(id) && !usedPathIds.has(id))
    .map(id => mainPipelines.find(p => p.pathId === id))
    .filter(p => p);
  
  if (connectedMainPipes.length === 0) return;
  
  // 选择方向最一致的管道段
  let bestPipe = null;
  let bestAlignment = 0;
  
  connectedMainPipes.forEach(pipe => {
    const alignment = calculatePipeAlignment(currentPipe, pipe);
    if (alignment > bestAlignment) {
      bestAlignment = alignment;
      bestPipe = pipe;
    }
  });
  
  // 主管应该是直线延伸，使用较高的阈值
  if (bestPipe && bestAlignment > 0.7) {
    usedPathIds.add(bestPipe.pathId);
    
    if (direction === 'forward') {
      mainPipe.segments.push(bestPipe);
      mainPipe.pathIds.push(bestPipe.pathId);
    } else {
      mainPipe.segments.unshift(bestPipe);
      mainPipe.pathIds.unshift(bestPipe.pathId);
    }
    
    mainPipe.totalLength += bestPipe.totalLength || 0;
    
    // 继续递归扩展
    extendMainPipeFromTees(bestPipe, mainPipe, mainPipelines, mainPipePathIds, pipelineGraph, usedPathIds, direction);
  }
}

/**
 * 🔧 基于三通构建支管
 * 每个三通产生一根独立的支管（从三通支管段开始，向远离三通的方向追踪）
 */
function buildBranchPipesFromTees(tees, allPipelines, branchPipelines, branchPipePathIds, welds, pipelineGraph) {
  const branchPipesFromTees = [];
  const usedPathIds = new Set(); // 已被分配到某根支管的管道段
  
  tees.forEach((tee, teeIndex) => {
    // 获取三通的支管段
    const teeParts = tee.parts.map(pathId => 
      allPipelines.find(p => p.pathId === pathId)
    ).filter(p => p);
    
    if (teeParts.length !== 3) {
      console.log(`   ⚠️ 三通 #${teeIndex+1} 的管道数量不是3，跳过`);
      return;
    }
    
    // 识别支管段（已在 classifyByTeeTopology 中识别）
    const { mainSegments, branchSegment } = identifyMainBranchInTee(teeParts, tee.center);
    
    if (!branchSegment) {
      console.log(`   ⚠️ 三通 #${teeIndex+1} 无法识别支管段，跳过`);
      return;
    }
    
    // 如果这个支管段已经被使用，跳过
    if (usedPathIds.has(branchSegment.pathId)) {
      console.log(`   ⚠️ 三通 #${teeIndex+1} 的支管段已被使用，跳过`);
      return;
    }
    
    // 从三通支管段开始，构建这根支管
    const branchPipe = {
      id: `BRANCH-${teeIndex + 1}`,
      segments: [branchSegment],
      pathIds: [branchSegment.pathId],
      totalLength: branchSegment.totalLength || 0,
      welds: [],
      type: 'branch',
      teeIndex: teeIndex, // 记录来自哪个三通
      teeCenter: tee.center
    };
    
    usedPathIds.add(branchSegment.pathId);
    
    // 从支管段向外追踪（远离三通中心的方向）
    extendBranchFromTee(
      branchSegment, 
      branchPipe, 
      branchPipelines, 
      branchPipePathIds,
      pipelineGraph, 
      usedPathIds,
      tee.center
    );
    
    branchPipesFromTees.push(branchPipe);
  });
  
  // 🔧 修复：为所有支管收集焊点（在所有支管构建完成后）
  // 对于每根支管，收集所有属于该支管路径上的焊点
  branchPipesFromTees.forEach((branchPipe, index) => {
    // 收集这根支管上已追踪到的连续段的焊点
    const trackedWelds = findWeldsOnBranchPipe(branchPipe.segments, welds);
    
    // 🔧 同时收集所有未被其他支管使用的支管段上的焊点（解决断开的支管段问题）
    // 找出所有未被任何支管追踪到的支管段
    const allTrackedPathIds = new Set();
    branchPipesFromTees.forEach(bp => {
      bp.pathIds.forEach(id => allTrackedPathIds.add(id));
    });
    
    const untrackedBranchPipes = branchPipelines.filter(p => !allTrackedPathIds.has(p.pathId));
    
    // 如果只有一根支管，将所有未追踪的支管段上的焊点也分配给它
    if (branchPipesFromTees.length === 1) {
      const untrackedWelds = findWeldsOnBranchPipe(untrackedBranchPipes, welds);
      branchPipe.welds = [...trackedWelds, ...untrackedWelds];
      console.log(`   ✅ 支管 #${index+1}: ${branchPipe.segments.length} 段连续, ${branchPipe.welds.length} 焊点 (来自所有 ${branchPipelines.length} 段支管), 总长 ${branchPipe.totalLength.toFixed(1)}`);
    } else {
      // 如果有多根支管，只收集已追踪段上的焊点（避免焊点分配冲突）
      branchPipe.welds = trackedWelds;
      console.log(`   ✅ 支管 #${index+1}: ${branchPipe.segments.length} 段, ${branchPipe.welds.length} 焊点, 总长 ${branchPipe.totalLength.toFixed(1)}`);
    }
  });
  
  return branchPipesFromTees;
}

/**
 * 从三通支管段向外扩展
 */
function extendBranchFromTee(currentPipe, branchPipe, branchPipelines, branchPipePathIds, pipelineGraph, usedPathIds, teeCenter) {
  const node = pipelineGraph.get(currentPipe.pathId);
  if (!node) return;
  
  // 找出所有连接的支管段（排除已使用的）
  const connectedBranchPipes = node.connections
    .filter(id => branchPipePathIds.has(id) && !usedPathIds.has(id))
    .map(id => branchPipelines.find(p => p.pathId === id))
    .filter(p => p);
  
  if (connectedBranchPipes.length === 0) return;
  
  // 选择远离三通中心的方向
  let bestPipe = null;
  let bestScore = -Infinity;
  
  connectedBranchPipes.forEach(pipe => {
    // 计算这个管道段的中心点
    const pipeCenter = getPipeCenter(pipe);
    const currentCenter = getPipeCenter(currentPipe);
    
    // 计算方向一致性（沿着支管方向延伸）
    const alignment = calculatePipeAlignment(currentPipe, pipe);
    
    // 计算是否远离三通中心
    const distFromTee = Math.sqrt(
      Math.pow(pipeCenter.x - teeCenter.x, 2) + 
      Math.pow(pipeCenter.y - teeCenter.y, 2)
    );
    const currentDistFromTee = Math.sqrt(
      Math.pow(currentCenter.x - teeCenter.x, 2) + 
      Math.pow(currentCenter.y - teeCenter.y, 2)
    );
    
    // 评分：方向一致性 + 远离三通的趋势
    const movingAway = distFromTee > currentDistFromTee ? 1 : 0;
    const score = alignment * 100 + movingAway * 50 + distFromTee;
    
    if (score > bestScore) {
      bestScore = score;
      bestPipe = pipe;
    }
  });
  
  // 只有方向足够一致才继续合并
  if (bestPipe) {
    const alignment = calculatePipeAlignment(currentPipe, bestPipe);
    if (alignment > 0.5) { // 放宽到 0.5（约60度），支管可能有弯曲
      usedPathIds.add(bestPipe.pathId);
      branchPipe.segments.push(bestPipe);
      branchPipe.pathIds.push(bestPipe.pathId);
      branchPipe.totalLength += bestPipe.totalLength || 0;
      
      // 继续递归扩展
      extendBranchFromTee(bestPipe, branchPipe, branchPipelines, branchPipePathIds, pipelineGraph, usedPathIds, teeCenter);
    }
  }
}

/**
 * 获取管道中心点
 */
function getPipeCenter(pipe) {
  if (!pipe.segments || pipe.segments.length === 0) {
    return { x: 0, y: 0 };
  }
  
  let sumX = 0, sumY = 0, count = 0;
  pipe.segments.forEach(seg => {
    const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
    const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
    const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
    const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
    sumX += (x1 + x2) / 2;
    sumY += (y1 + y2) / 2;
    count++;
  });
  
  return { x: sumX / count, y: sumY / count };
}

/**
 * 计算两根管道的方向一致性
 */
function calculatePipeAlignment(pipe1, pipe2) {
  const getMainDirection = (pipe) => {
    if (!pipe.segments || pipe.segments.length === 0) return null;
    
    // 找最长的线段作为主方向
    let longestSeg = pipe.segments[0];
    let maxLen = 0;
    
    pipe.segments.forEach(seg => {
      const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
      const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
      const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
      const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
      const len = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
      if (len > maxLen) {
        maxLen = len;
        longestSeg = seg;
      }
    });
    
    const x1 = longestSeg.x1 ?? longestSeg.p1?.x ?? longestSeg.start?.x ?? 0;
    const y1 = longestSeg.y1 ?? longestSeg.p1?.y ?? longestSeg.start?.y ?? 0;
    const x2 = longestSeg.x2 ?? longestSeg.p2?.x ?? longestSeg.end?.x ?? 0;
    const y2 = longestSeg.y2 ?? longestSeg.p2?.y ?? longestSeg.end?.y ?? 0;
    
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    return len > 0 ? { dx: dx / len, dy: dy / len } : null;
  };
  
  const dir1 = getMainDirection(pipe1);
  const dir2 = getMainDirection(pipe2);
  
  if (!dir1 || !dir2) return 0;
  
  // 计算点积的绝对值（因为方向可能相反）
  return Math.abs(dir1.dx * dir2.dx + dir1.dy * dir2.dy);
}

/**
 * 找出在支管上的焊点
 */
function findWeldsOnBranchPipe(pipeSegments, welds) {
  const weldsOnPipe = [];
  const addedWeldIds = new Set(); // 🔧 用于去重
  
  welds.forEach(weld => {
    // 🔧 获取焊点的唯一标识
    const weldId = weld.pathId || weld.id || 
                   `${weld.center?.x || weld.boundingBox?.minX}_${weld.center?.y || weld.boundingBox?.minY}`;
    
    // 🔧 如果已经添加过，跳过
    if (addedWeldIds.has(weldId)) {
      return;
    }
    
    const weldX = weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width / 2);
    const weldY = weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height / 2);
    const weldPoint = { x: weldX, y: weldY };
    
    // 检查焊点是否靠近任何一段管道
    const isOnPipe = pipeSegments.some(pipe => {
      return pipe.segments.some(seg => {
        const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
        const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
        const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
        const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
        
        const dist = getDistancePointToSegmentLocal({ x: x1, y: y1 }, { x: x2, y: y2 }, weldPoint);
        return dist < 20; // 20px 阈值
      });
    });
    
    if (isOnPipe) {
      weldsOnPipe.push(weld);
      addedWeldIds.add(weldId); // 🔧 标记为已添加
    }
  });
  
  return weldsOnPipe;
}

/**
 * 计算点到线段的距离（本地版本）
 */
function getDistancePointToSegmentLocal(v, w, p) {
  const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
  
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  
  const projectionX = v.x + t * (w.x - v.x);
  const projectionY = v.y + t * (w.y - v.y);
  
  return Math.sqrt((p.x - projectionX) ** 2 + (p.y - projectionY) ** 2);
}

/**
 * 🌟 基于三通的拓扑分析
 * 识别三通中的主管和支管，然后追踪完整的主管路径
 */
function classifyByTeeTopology(pipelines, tees, pipelineGraph) {
  const mainPipePathIds = new Set();
  const branchPipePathIds = new Set();
  
  console.log(`   🧩 分析 ${tees.length} 个三通的拓扑结构...`);
  
  // 记录每个管道的分类投票（一个管道可能在多个三通中出现）
  const pipeClassVotes = new Map(); // pathId -> { main: count, branch: count }
  
  // 🌟 0. 建立管道到三通的映射（用于快速判断两个管道是否属于同一个三通）
  const pipeToTeeIndices = new Map(); // pathId -> Set<teeIndex>
  tees.forEach((tee, index) => {
    tee.parts.forEach(pathId => {
      if (!pipeToTeeIndices.has(pathId)) {
        pipeToTeeIndices.set(pathId, new Set());
      }
      pipeToTeeIndices.get(pathId).add(index);
    });
  });
  
  // 🌟 第一轮：为每个三通识别主管段和支管段（基于角度）
  const teeClassifications = []; // 保存每个三通的分类结果，用于后续回溯修正
  
  tees.forEach((tee, index) => {
    // 获取三通的三个管道
    const teeParts = tee.parts.map(pathId => 
      pipelines.find(p => p.pathId === pathId)
    ).filter(p => p);
    
    if (teeParts.length !== 3) {
      console.warn(`   ⚠️ 三通 #${index+1} 的管道数量不是3 (${teeParts.length})，跳过`);
      return;
    }
    
    // 识别主管段（两个共线的管道）和支管段
    const { mainSegments, branchSegment } = identifyMainBranchInTee(teeParts, tee.center);
    
    if (mainSegments.length === 2 && branchSegment) {
      console.log(`   ✅ 三通 #${index+1}: 横杠 [${mainSegments.map(p => p.pathId).join(', ')}], 竖杠 [${branchSegment.pathId}]`);
      
      // 保存分类结果
      teeClassifications.push({
        teeIndex: index,
        tee: tee,
        mainSegments: mainSegments,
        branchSegment: branchSegment
      });
      
      // 投票：主管段
      mainSegments.forEach(seg => {
        if (!pipeClassVotes.has(seg.pathId)) {
          pipeClassVotes.set(seg.pathId, { main: 0, branch: 0 });
        }
        pipeClassVotes.get(seg.pathId).main++;
      });
      
      // 投票：支管段
      if (!pipeClassVotes.has(branchSegment.pathId)) {
        pipeClassVotes.set(branchSegment.pathId, { main: 0, branch: 0 });
      }
      pipeClassVotes.get(branchSegment.pathId).branch++;
    } else {
      console.warn(`   ⚠️ 三通 #${index+1} 无法区分主管和支管`);
    }
  });
  
  // 🌟 根据投票结果决定最终分类
  console.log(`   📊 处理分类决策...`);
  console.log(`      投票统计: ${pipeClassVotes.size} 个三通管道`);
  
  pipeClassVotes.forEach((votes, pathId) => {
    if (votes.main > 0 && votes.branch > 0) {
      // 冲突：同时被标记为主管和支管
      console.log(`      ⚠️ 管道 ${pathId} 分类冲突: 主管票${votes.main}, 支管票${votes.branch}`);
      // 🌟 改为主管优先（一个管道在多个三通中，如果大部分是主管段，就是主管）
      if (votes.main > votes.branch) {
        mainPipePathIds.add(pathId);
        console.log(`         → 最终判定: 主管`);
      } else {
        branchPipePathIds.add(pathId);
        console.log(`         → 最终判定: 支管`);
      }
    } else if (votes.main > 0) {
      mainPipePathIds.add(pathId);
      console.log(`      ✓ 管道 ${pathId}: 主管 (票数: ${votes.main})`);
    } else if (votes.branch > 0) {
      branchPipePathIds.add(pathId);
      console.log(`      ✓ 管道 ${pathId}: 支管 (票数: ${votes.branch})`);
    }
  });
  
  console.log(`   📋 初始分类结果: 主管段 ${mainPipePathIds.size} 个, 支管段 ${branchPipePathIds.size} 个`);
  
  // 🌟 新增：回溯修正机制 - 检查三通的横杠是否延伸到已判定的支管
  console.log(`   🔄 【回溯修正】检查三通横杠的延伸方向...`);
  
  let correctionsMade = 0;
  const maxCorrectionIterations = 10;
  
  for (let iter = 0; iter < maxCorrectionIterations; iter++) {
    let correctedThisRound = false;
    
    teeClassifications.forEach(({ teeIndex, tee, mainSegments, branchSegment }) => {
      // 检查这个三通的横杠段是否需要修正
      mainSegments.forEach(mainSeg => {
        // 如果这个横杠段已经被判定为支管，跳过（已经修正过了）
        if (branchPipePathIds.has(mainSeg.pathId)) return;
        
        // 🌟 递归追踪：从横杠段开始，沿着连接链追踪，看是否最终连接到支管
        // ⚠️ 限制追踪深度，避免追踪整个管网
        const visited = new Set([mainSeg.pathId]);
        const queue = [{ pipe: mainSeg, depth: 0 }]; // 添加深度信息
        let foundBranchConnection = false;
        let connectionChain = [mainSeg.pathId]; // 记录连接链
        const maxDepth = 5; // 🌟 最多追踪5段（避免追踪整个管网）
        
        console.log(`   🔍 开始递归追踪三通#${teeIndex+1}的横杠${mainSeg.pathId} (最大深度: ${maxDepth})...`);
        
        while (queue.length > 0 && !foundBranchConnection) {
          const { pipe: currentPipe, depth: currentDepth } = queue.shift();
          
          // 🌟 深度限制：超过最大深度停止追踪
          if (currentDepth >= maxDepth) {
            console.log(`      ⚠️ 达到最大追踪深度 ${maxDepth}，停止追踪`);
            continue;
          }
          const connectedPipes = findConnectedPipes(currentPipe, pipelines, pipelineGraph);
          
          console.log(`      → 当前管道${currentPipe.pathId}, 连接数: ${connectedPipes.length}`);
          
          for (const connectedPipe of connectedPipes) {
            console.log(`         检查连接管道${connectedPipe.pathId}...`);
            
            // 排除三通内部连接
            if (tee.parts.includes(connectedPipe.pathId)) {
              console.log(`         → 跳过: 三通内部连接`);
              continue;
            }
            
            // 🌟 排除任意三通内部的连接（例如从横杠跳到竖杠）
            const currentTeeIndices = pipeToTeeIndices.get(currentPipe.pathId);
            const connectedTeeIndices = pipeToTeeIndices.get(connectedPipe.pathId);
            
            if (currentTeeIndices && connectedTeeIndices) {
              // 检查是否有共同所属的三通
              let commonTeeIndex = -1;
              for (const idx of currentTeeIndices) {
                if (connectedTeeIndices.has(idx)) {
                  commonTeeIndex = idx;
                  break;
                }
              }
              
              if (commonTeeIndex !== -1) {
                console.log(`         → 跳过: 同一三通内部连接 (Tee #${commonTeeIndex+1})`);
                continue;
              }
            }
            
            // 已访问过，跳过
            if (visited.has(connectedPipe.pathId)) {
              console.log(`         → 跳过: 已访问`);
              continue;
            }
            
            // 检查方向一致性（只追踪方向一致的管道）
            const distance = calculateDistance(currentPipe, connectedPipe);
            const isContinuation = checkPipeContinuity(currentPipe, connectedPipe, distance);
            
            console.log(`         → 距离: ${distance.toFixed(1)}px, 方向一致: ${!!isContinuation}`);
            
            if (!isContinuation) {
              console.log(`         → 跳过: 方向不一致`);
              continue; // 方向不一致，不追踪
            }
            
            // 🌟 关键判断：如果连接的管道已经是支管
            if (branchPipePathIds.has(connectedPipe.pathId)) {
              foundBranchConnection = true;
              connectionChain.push(connectedPipe.pathId);
              console.log(`   🔄 修正: 三通#${teeIndex+1}的横杠${mainSeg.pathId}递归追踪到支管${connectedPipe.pathId}(连接链: ${connectionChain.join(' → ')}) → 判定为支管`);
              
              // 从主管移除，加入支管
              mainPipePathIds.delete(mainSeg.pathId);
              branchPipePathIds.add(mainSeg.pathId);
              
              // 更新投票
              if (pipeClassVotes.has(mainSeg.pathId)) {
                pipeClassVotes.get(mainSeg.pathId).branch++;
              }
              
              correctedThisRound = true;
              correctionsMade++;
              
              // 🔧 连锁修正：这个三通的另一个横杠段也应该是支管
              const otherMainSeg = mainSegments.find(seg => seg.pathId !== mainSeg.pathId);
              if (otherMainSeg && !branchPipePathIds.has(otherMainSeg.pathId)) {
                console.log(`   🔄 连锁修正: 三通#${teeIndex+1}的另一横杠${otherMainSeg.pathId} → 判定为支管`);
                mainPipePathIds.delete(otherMainSeg.pathId);
                branchPipePathIds.add(otherMainSeg.pathId);
                if (pipeClassVotes.has(otherMainSeg.pathId)) {
                  pipeClassVotes.get(otherMainSeg.pathId).branch++;
                }
                correctionsMade++;
              }
              break;
            }
            
            // 🌟 如果连接的管道是主管段（三通的横杠）或未分类的管道，继续追踪
            const isMainPipe = mainPipePathIds.has(connectedPipe.pathId);
            const isUnclassified = !mainPipePathIds.has(connectedPipe.pathId) && 
                                   !branchPipePathIds.has(connectedPipe.pathId);
            
            if (isMainPipe || isUnclassified) {
              visited.add(connectedPipe.pathId);
              queue.push({ pipe: connectedPipe, depth: currentDepth + 1 }); // 深度+1
              connectionChain.push(connectedPipe.pathId);
              const pipeType = isMainPipe ? '主管' : '未分类';
              console.log(`         → 继续追踪: ${pipeType}管道，加入队列 (深度: ${currentDepth + 1}, 当前链: ${connectionChain.join(' → ')})`);
            } else {
              console.log(`         → 跳过: 既不是主管也不是支管`);
            }
          }
        }
        
        if (!foundBranchConnection) {
          console.log(`   ❌ 三通#${teeIndex+1}的横杠${mainSeg.pathId}未找到支管连接`);
        }
      });
    });
    
    if (!correctedThisRound) {
      console.log(`   ✅ 回溯修正完成，共修正 ${correctionsMade} 个管道段`);
      break;
    }
  }
  
  console.log(`   📋 修正后分类: 主管段 ${mainPipePathIds.size} 个, 支管段 ${branchPipePathIds.size} 个`);
  
  // 🌟 新策略：基于位置接近性的严格追踪
  // 主管：从三通"一"的两端延伸
  // 支管：从三通"丨"远离"一"的一端延伸
  
  console.log(`   🔄 开始基于位置接近性的追踪...`);
  
  // 创建所有管道的列表（排除已分类的三通管道）
  const unclassifiedPipes = pipelines.filter(p => 
    !mainPipePathIds.has(p.pathId) && !branchPipePathIds.has(p.pathId)
  );
  
  console.log(`   📋 待分类管道: ${unclassifiedPipes.length} 个`);
  
  // ============ 第一步：基于位置追踪主管 ============
  console.log(`   🔄 【第一步】追踪主管（从三通横杠两端延伸）`);
  
  let mainChanged = true;
  let mainIterations = 0;
  const maxIterations = 50; // 防止无限循环
  
  while (mainChanged && mainIterations < maxIterations) {
    mainChanged = false;
    mainIterations++;
    
    unclassifiedPipes.forEach(pipe => {
      if (mainPipePathIds.has(pipe.pathId)) return; // 已分类
      if (branchPipePathIds.has(pipe.pathId)) return; // 已是支管
      
      // 🔍 检查候选管道是否更接近支管方向
      const nearestBranchPipe = findNearestPipe(pipe, pipelines.filter(p => 
        branchPipePathIds.has(p.pathId)
      ));
      
      // 🔍 同时检查是否更接近主管
      const nearestMainPipe = findNearestPipe(pipe, pipelines.filter(p => 
        mainPipePathIds.has(p.pathId)
      ));
      
      if (nearestBranchPipe && nearestBranchPipe.distance < 20) {
        // 如果候选管道距离支管很近,检查方向一致性
        const shouldAddToBranch = checkPipeContinuity(
          pipe,
          nearestBranchPipe.pipe,
          nearestBranchPipe.distance
        );
        
        if (shouldAddToBranch) {
          // 🔧 额外检查:如果同时也接近主管,使用综合评分机制
          if (nearestMainPipe) {
            const shouldAddToMain = checkPipeContinuity(
              pipe,
              nearestMainPipe.pipe,
              nearestMainPipe.distance
            );
            
            if (shouldAddToMain) {
              // 两边都可以,使用综合评分（距离 + 方向一致性）
              const branchScore = calculatePipeConnectionScore(
                pipe, 
                nearestBranchPipe.pipe, 
                nearestBranchPipe.distance
              );
              const mainScore = calculatePipeConnectionScore(
                pipe, 
                nearestMainPipe.pipe, 
                nearestMainPipe.distance
              );
              
              if (mainScore > branchScore) {
                // 主管评分更高,跳过支管分配
                console.log(`     ⚖️ 管道 ${pipe.pathId} 同时接近主管(${nearestMainPipe.distance.toFixed(1)}px,评分${mainScore.toFixed(2)})和支管(${nearestBranchPipe.distance.toFixed(1)}px,评分${branchScore.toFixed(2)}), 选择主管`);
                // 继续下面的主管检查
              } else {
                // 支管评分更高,分配给支管
                branchPipePathIds.add(pipe.pathId);
                console.log(`     🔀 添加到支管: ${pipe.pathId} (距支管 ${nearestBranchPipe.distance.toFixed(1)}px,评分${branchScore.toFixed(2)} > 主管评分${mainScore.toFixed(2)})`);
                return; // 跳过主管检查
              }
            } else {
              // 只与支管方向一致
              branchPipePathIds.add(pipe.pathId);
              console.log(`     🔀 添加到支管: ${pipe.pathId} (距支管 ${nearestBranchPipe.distance.toFixed(1)}px, 方向一致)`);
              return; // 跳过主管检查
            }
          } else {
            // 没有接近的主管,直接分配给支管
            branchPipePathIds.add(pipe.pathId);
            console.log(`     🔀 添加到支管: ${pipe.pathId} (距支管 ${nearestBranchPipe.distance.toFixed(1)}px, 方向一致)`);
            return; // 跳过主管检查
          }
        }
      }
      
      // nearestMainPipe已经在上面声明过了,这里不需要重复声明
      if (nearestMainPipe) {
        const shouldAdd = checkPipeContinuity(
          pipe, 
          nearestMainPipe.pipe, 
          nearestMainPipe.distance
        );
        
        if (shouldAdd) {
          mainPipePathIds.add(pipe.pathId);
          mainChanged = true;
          console.log(`     ➕ 添加到主管: ${pipe.pathId} (距离: ${nearestMainPipe.distance.toFixed(1)}px, ${shouldAdd.reason})`);
        }
      }
    });
  }
  
  console.log(`   🎯 主管追踪完成: ${mainPipePathIds.size} 段 (${mainIterations} 次迭代)`);
  
  // ============ 第二步：基于位置追踪支管 ============
  console.log(`   🔄 【第二步】追踪支管（从三通竖杠远端延伸）`);
  
  let branchChanged = true;
  let branchIterations = 0;
  
  while (branchChanged && branchIterations < maxIterations) {
    branchChanged = false;
    branchIterations++;
    
    unclassifiedPipes.forEach(pipe => {
      if (mainPipePathIds.has(pipe.pathId)) return; // 已是主管
      if (branchPipePathIds.has(pipe.pathId)) return; // 已分类
      
      // 找到最近的支管段
      const nearestBranchPipe = findNearestPipe(pipe, pipelines.filter(p => 
        branchPipePathIds.has(p.pathId)
      ));
      
      if (nearestBranchPipe) {
        const shouldAdd = checkPipeContinuity(
          pipe, 
          nearestBranchPipe.pipe, 
          nearestBranchPipe.distance
        );
        
        if (shouldAdd) {
          branchPipePathIds.add(pipe.pathId);
          branchChanged = true;
          console.log(`     ➕ 添加到支管: ${pipe.pathId} (距离: ${nearestBranchPipe.distance.toFixed(1)}px, ${shouldAdd.reason})`);
        }
      }
    });
  }
  
  console.log(`   🔀 支管追踪完成: ${branchPipePathIds.size} 段 (${branchIterations} 次迭代)`);
  
  // 旧的基于连接图的追踪逻辑（已废弃，保留注释供参考）
  /*
  while (false) {
    const currentId = branchQueue.shift();
    const node = pipelineGraph.get(currentId);
    
    if (!node) continue;
    
    const currentPipe = pipelines.find(p => p.pathId === currentId);
    if (!currentPipe) continue;
    
    console.log(`     🔍 支管追踪检查管道 ${currentId}, 连接数: ${node.connections.length}`);
    
    // 检查相连的管道
    node.connections.forEach(connectedId => {
      // 跳过已访问的
      if (branchVisited.has(connectedId)) {
        console.log(`       ⏭️ 已访问，跳过: ${connectedId}`);
        return;
      }
      
      // 🌟 跳过三通的主管段（不要进入主管路径）
      if (mainPipePathIds.has(connectedId)) {
        console.log(`       ⏸️ 遇到三通主管段，停止支管追踪: ${connectedId}`);
        return;
      }
      
      const connectedPipe = pipelines.find(p => p.pathId === connectedId);
      if (!connectedPipe) return;
      
      // 🌟 智能分支判断：连接数>=3时，检查方向一致性
      const connectedNode = pipelineGraph.get(connectedId);
      if (connectedNode && connectedNode.connections.length >= 3) {
        // 检查方向是否一致（接壤/共线 = 同类型延续）
        const isSameDirection = checkDirectionContinuity(currentPipe, connectedPipe);
        
        if (!isSameDirection) {
          // 方向不一致，是真正的分支点，停止
          console.log(`       ⚠️ 管道 ${connectedId} 连接数=${connectedNode.connections.length}，方向不一致，停止支管追踪`);
          return;
        } else {
          // 方向一致，是同类型延续，继续追踪
          console.log(`       ✓ 管道 ${connectedId} 连接数=${connectedNode.connections.length}，但方向一致，继续追踪`);
        }
      }
      
      // 判断是否为三通的一部分
      const isTeePart = connectedPipe.isTeePart;
      
      if (isTeePart) {
        // 如果是三通的支管段，继续追踪
        if (branchPipePathIds.has(connectedId)) {
          branchVisited.add(connectedId);
          branchQueue.push(connectedId);
          console.log(`       ➡️ 跨越三通继续追踪支管: ${connectedId}`);
        } else {
          // 是三通的主管段，停止
          console.log(`       ⏸️ 遇到三通主管段，停止支管追踪: ${connectedId}`);
        }
      } else {
        // 不是三通的一部分，说明是支管的延续
        branchPipePathIds.add(connectedId);
        branchVisited.add(connectedId);
        branchQueue.push(connectedId);
        console.log(`       ➕ 添加到支管: ${connectedId}`);
      }
    });
  }
  
  // 旧的主管追踪逻辑也已废弃
  */
  
  console.log(`   ✅ 最终分类完成: 主管 ${mainPipePathIds.size} 段, 支管 ${branchPipePathIds.size} 段`);
  
  return { mainPipePathIds, branchPipePathIds };
}

/**
 * 在三通中识别主管段和支管段
 * 主管段：两个接近共线的管道（T的横杠）
 * 支管段：第三个管道（T的竖杠）
 */
function identifyMainBranchInTee(teeParts, teeCenter) {
  if (teeParts.length !== 3) {
    return { mainSegments: [], branchSegment: null };
  }
  
  // 计算每个管道相对于三通中心的方向向量
  const directions = teeParts.map(pipe => {
    // 获取管道的端点，取距离三通中心最远的那个端点
    const endpoints = getStructureEndpoints(pipe);
    
    // 🔍 调试:输出所有端点
    // console.log(`         管道 ${pipe.pathId} 的端点:`);
    // endpoints.forEach((ep, idx) => {
    //   const dist = Math.sqrt((ep.x - teeCenter.x) ** 2 + (ep.y - teeCenter.y) ** 2);
    //   console.log(`           端点${idx}: (${ep.x.toFixed(1)}, ${ep.y.toFixed(1)}), 距三通中心: ${dist.toFixed(1)}px`);
    // });
    
    // 找到离中心更远的端点
    const farPoint = endpoints.reduce((far, pt) => {
      const distFar = Math.sqrt((far.x - teeCenter.x) ** 2 + (far.y - teeCenter.y) ** 2);
      const distPt = Math.sqrt((pt.x - teeCenter.x) ** 2 + (pt.y - teeCenter.y) ** 2);
      return distPt > distFar ? pt : far;
    });
    
    // console.log(`         → 选择的远端点: (${farPoint.x.toFixed(1)}, ${farPoint.y.toFixed(1)})`);
    
    // 计算方向向量（从中心指向远端点）
    const dx = farPoint.x - teeCenter.x;
    const dy = farPoint.y - teeCenter.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    
    // console.log(`         → 方向角度: ${angle.toFixed(1)}°`);
    
    return {
      pipe,
      vector: { x: dx / length, y: dy / length },
      angle,
      farPoint,
      length
    };
  });
  
  // 找出角度最接近180度的两个管道（它们是共线的，构成主管）
  // 🔧 严格要求：必须是严格共线（接近180度），避免拐弯处被误判为三通
  let bestResult = null;
  let maxColinearity = -Infinity;
  
  // 🌟 共线阈值（适度放宽以识别真实三通，同时避免90度拐弯被误判）
  const STRICT_COLINEARITY_THRESHOLD = 150.0; // 角度差必须接近180度（至少150度，排除90度拐弯）
  const STRICT_DOT_PRODUCT_THRESHOLD = -0.85; // 点积必须接近-1（方向基本相反）
  
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const k = 3 - i - j; // 第三个索引
      
      // 计算 i 和 j 的角度差（应该接近180度）
      let angleDiff = Math.abs(directions[i].angle - directions[j].angle);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;
      
      // 共线度：越接近180度，越共线
      const colinearity = 180 - Math.abs(180 - angleDiff);
      
      // 🌟 额外检查：计算点积，确保方向相反
      const dotProduct = directions[i].vector.x * directions[j].vector.x + 
                        directions[i].vector.y * directions[j].vector.y;
      // 点积应该接近-1（方向相反）
      const dotScore = Math.abs(dotProduct + 1) * 100; // 越小越好，转换为分数
      
      // 🔧 严格检查：必须满足共线度和点积的双重要求
      if (colinearity < STRICT_COLINEARITY_THRESHOLD) {
        continue; // 角度偏差太大，不是真正的共线
      }
      
      if (dotProduct > STRICT_DOT_PRODUCT_THRESHOLD) {
        continue; // 点积不够负，方向不是严格相反
      }
      
      // 综合评分
      const score = colinearity - dotScore;
      
      if (score > maxColinearity) {
        maxColinearity = score;
        bestResult = {
          mainPair: [i, j],
          branchIndex: k,
          colinearity,
          dotProduct,
          angles: [directions[i].angle, directions[j].angle, directions[k].angle]
        };
      }
    }
  }
  
  if (!bestResult) {
    console.log(`      ⚠️ 未找到严格共线的管道对（共线度阈值: ${STRICT_COLINEARITY_THRESHOLD}°, 点积阈值: ${STRICT_DOT_PRODUCT_THRESHOLD}），可能是拐弯而非三通`);
    return { mainSegments: [], branchSegment: null };
  }
  
  // 🌟 调试输出 (仅在第一次调用或检测到三通时输出)
  // console.log(`      三通 @ (${teeCenter.x.toFixed(1)}, ${teeCenter.y.toFixed(1)})`);
  // console.log(`        主管段角度: ${bestResult.angles[bestResult.mainPair[0]].toFixed(1)}° 和 ${bestResult.angles[bestResult.mainPair[1]].toFixed(1)}°`);
  // console.log(`        支管段角度: ${bestResult.angles[bestResult.branchIndex].toFixed(1)}°`);
  // console.log(`        共线度: ${bestResult.colinearity.toFixed(2)}, 点积: ${bestResult.dotProduct.toFixed(3)}`);
  // console.log(`        ✅ 通过严格共线检查 (阈值: 共线度>${STRICT_COLINEARITY_THRESHOLD}°, 点积<${STRICT_DOT_PRODUCT_THRESHOLD})`);
  
  return {
    mainSegments: [
      directions[bestResult.mainPair[0]].pipe, 
      directions[bestResult.mainPair[1]].pipe
    ],
    branchSegment: directions[bestResult.branchIndex].pipe
  };
}

/**
 * 计算管道连接的综合评分（距离 + 方向一致性）
 * @param {Object} pipe1 - 目标管道
 * @param {Object} pipe2 - 候选管道
 * @param {number} distance - 两管道间的距离
 * @returns {number} - 评分值，越高表示连接性越好
 */
function calculatePipeConnectionScore(pipe1, pipe2, distance) {
  // 1️⃣ 距离评分（距离越近，分数越高，最大50分）
  const maxDistance = 50; // 超过50px评分为0
  const distanceScore = Math.max(0, (1 - distance / maxDistance) * 50);
  
  // 2️⃣ 方向一致性评分（最大50分）
  let directionScore = 0;
  
  const endpoints1 = getStructureEndpoints(pipe1);
  const endpoints2 = getStructureEndpoints(pipe2);
  
  // 计算方向向量
  const dir1 = {
    x: endpoints1[1].x - endpoints1[0].x,
    y: endpoints1[1].y - endpoints1[0].y
  };
  const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
  if (len1 > 0) {
    dir1.x /= len1;
    dir1.y /= len1;
  }
  
  const dir2 = {
    x: endpoints2[1].x - endpoints2[0].x,
    y: endpoints2[1].y - endpoints2[0].y
  };
  const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);
  if (len2 > 0) {
    dir2.x /= len2;
    dir2.y /= len2;
  }
  
  // 计算点积（方向相似度）-1到1之间
  const dotProduct = Math.abs(dir1.x * dir2.x + dir1.y * dir2.y);
  
  // 方向评分：dotProduct越接近1（平行），分数越高
  // 0.82以上（35度以内）给满分50，之后线性递减
  if (dotProduct >= 0.82) {
    directionScore = 50;
  } else if (dotProduct >= 0.5) { // 60度以内还有一些分数
    directionScore = (dotProduct - 0.5) / (0.82 - 0.5) * 50;
  } else {
    directionScore = 0;
  }
  
  // 3️⃣ 综合评分（方向权重更高）
  // 距离权重：40%，方向权重：60%
  const totalScore = distanceScore * 0.4 + directionScore * 0.6;
  
  return totalScore;
}

/**
 * 检查两个管道是否连续（综合判断距离和方向）
 * @param {Object} pipe1 - 目标管道
 * @param {Object} pipe2 - 候选管道
 * @param {number} distance - 两管道间的距离
 * @returns {Object|null} - { reason } 如果连续，返回原因；否则返回null
 */
function checkPipeContinuity(pipe1, pipe2, distance) {
  // 策略1：位置非常接近（紧挨着）
  const proximityThreshold = 10; // 10px
  if (distance < proximityThreshold) {
    return { reason: '位置接近' };
  }
  
  // 策略2：距离稍远，但方向一致（共线延伸）
  const maxDistanceForDirection = 50; // 最大50px内检查方向
  if (distance < maxDistanceForDirection) {
    // 计算两个管道的方向向量
    const endpoints1 = getStructureEndpoints(pipe1);
    const endpoints2 = getStructureEndpoints(pipe2);
    
    const dir1 = {
      x: endpoints1[1].x - endpoints1[0].x,
      y: endpoints1[1].y - endpoints1[0].y
    };
    const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
    if (len1 > 0) {
      dir1.x /= len1;
      dir1.y /= len1;
    }
    
    const dir2 = {
      x: endpoints2[1].x - endpoints2[0].x,
      y: endpoints2[1].y - endpoints2[0].y
    };
    const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);
    if (len2 > 0) {
      dir2.x /= len2;
      dir2.y /= len2;
    }
    
    // 计算点积（方向相似度）
    const dotProduct = Math.abs(dir1.x * dir2.x + dir1.y * dir2.y);
    
    // 🌟 适度放宽：夹角 < 35°（cos(35°) ≈ 0.82），平衡准确性和灵活性
    const directionThreshold = 0.82;
    if (dotProduct > directionThreshold) {
      return { reason: '方向一致' };
    }
  }
  
  return null; // 不连续
}

/**
 * 找到与给定管道最近的管道
 * @param {Object} targetPipe - 目标管道
 * @param {Array} candidatePipes - 候选管道列表
 * @returns {Object} - { pipe, distance } 最近的管道及距离
 */
function findNearestPipe(targetPipe, candidatePipes) {
  if (!candidatePipes || candidatePipes.length === 0) {
    return null;
  }
  
  const targetEndpoints = getStructureEndpoints(targetPipe);
  let minDistance = Infinity;
  let nearestPipe = null;
  
  candidatePipes.forEach(candidate => {
    const candidateEndpoints = getStructureEndpoints(candidate);
    
    // 计算所有端点对之间的最小距离
    for (const ep1 of targetEndpoints) {
      for (const ep2 of candidateEndpoints) {
        const dist = Math.sqrt(
          (ep1.x - ep2.x) ** 2 + (ep1.y - ep2.y) ** 2
        );
        
        if (dist < minDistance) {
          minDistance = dist;
          nearestPipe = candidate;
        }
      }
    }
  });
  
  return nearestPipe ? { pipe: nearestPipe, distance: minDistance } : null;
}

/**
 * 检查两个管道是否连续（方向一致 或 位置接近）
 * 用于判断是否为同类型管道的延续
 * @deprecated 已被基于位置接近性的新算法替代
 */
function checkDirectionContinuity(pipe1, pipe2) {
  // 获取两个管道的端点
  const endpoints1 = getStructureEndpoints(pipe1);
  const endpoints2 = getStructureEndpoints(pipe2);
  
  // 🌟 首先检查位置接近性（端点距离）
  let minDistance = Infinity;
  for (const ep1 of endpoints1) {
    for (const ep2 of endpoints2) {
      const dist = Math.sqrt(
        (ep1.x - ep2.x) ** 2 + (ep1.y - ep2.y) ** 2
      );
      minDistance = Math.min(minDistance, dist);
    }
  }
  
  // 如果端点非常接近（< 5px），认为是紧密连接，无论方向如何都继续
  const proximityThreshold = 5.0;
  if (minDistance < proximityThreshold) {
    return true; // 位置接近，是延续
  }
  
  // 🌟 位置不够接近时，检查方向一致性
  // 计算pipe1的方向向量
  const dir1 = {
    x: endpoints1[1].x - endpoints1[0].x,
    y: endpoints1[1].y - endpoints1[0].y
  };
  const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
  if (len1 === 0) return false;
  dir1.x /= len1;
  dir1.y /= len1;
  
  // 计算pipe2的方向向量
  const dir2 = {
    x: endpoints2[1].x - endpoints2[0].x,
    y: endpoints2[1].y - endpoints2[0].y
  };
  const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);
  if (len2 === 0) return false;
  dir2.x /= len2;
  dir2.y /= len2;
  
  // 计算点积（cos(angle)）
  const dotProduct = Math.abs(dir1.x * dir2.x + dir1.y * dir2.y);
  
  // 🌟 适度放宽：cos(40°) ≈ 0.766，平衡准确性和灵活性
  const angleThreshold = 0.766;
  
  return dotProduct > angleThreshold; // 方向一致
}

/**
 * 查找与指定管道连接的所有管道
 * @param {Object} pipe - 目标管道
 * @param {Array} allPipelines - 所有管道列表
 * @param {Map} pipelineGraph - 管道连接图
 * @returns {Array} - 连接的管道列表
 */
function findConnectedPipes(pipe, allPipelines, pipelineGraph) {
  const connected = [];
  const node = pipelineGraph.get(pipe.pathId);
  
  if (!node) return connected;
  
  // 从连接图获取直接连接的管道ID
  node.connections.forEach(connectedId => {
    const connectedPipe = allPipelines.find(p => p.pathId === connectedId);
    if (connectedPipe) {
      connected.push(connectedPipe);
    }
  });
  
  // 🌟 额外检查：基于位置接近性查找可能遗漏的连接
  const endpoints = getStructureEndpoints(pipe);
  const proximityThreshold = 15; // 15px内认为可能连接
  
  allPipelines.forEach(candidate => {
    if (candidate.pathId === pipe.pathId) return; // 跳过自己
    if (connected.some(p => p.pathId === candidate.pathId)) return; // 已经在列表中
    
    const candidateEndpoints = getStructureEndpoints(candidate);
    
    // 检查端点距离
    for (const ep1 of endpoints) {
      for (const ep2 of candidateEndpoints) {
        const dist = Math.sqrt(
          (ep1.x - ep2.x) ** 2 + (ep1.y - ep2.y) ** 2
        );
        
        if (dist < proximityThreshold) {
          connected.push(candidate);
          return; // 找到一个就够了
        }
      }
    }
  });
  
  return connected;
}

/**
 * 计算两个管道之间的最短距离
 * @param {Object} pipe1 - 管道1
 * @param {Object} pipe2 - 管道2
 * @returns {number} - 最短距离
 */
function calculateDistance(pipe1, pipe2) {
  const endpoints1 = getStructureEndpoints(pipe1);
  const endpoints2 = getStructureEndpoints(pipe2);
  
  let minDistance = Infinity;
  
  for (const ep1 of endpoints1) {
    for (const ep2 of endpoints2) {
      const dist = Math.sqrt(
        (ep1.x - ep2.x) ** 2 + (ep1.y - ep2.y) ** 2
      );
      minDistance = Math.min(minDistance, dist);
    }
  }
  
  return minDistance;
}

/**
 * 获取管道结构的逻辑端点
 */
function getStructureEndpoints(pipe) {
  const segments = pipe.segments;
  const allPoints = [];
  segments.forEach(s => {
    allPoints.push({ x: s.x1, y: s.y1 });
    allPoints.push({ x: s.x2, y: s.y2 });
  });

  // 找到距离最远的两个点
  let maxDist = 0;
  let p1 = allPoints[0];
  let p2 = allPoints[0];

  for (let i = 0; i < allPoints.length; i++) {
    for (let j = i + 1; j < allPoints.length; j++) {
      const dist = Math.sqrt(
        (allPoints[i].x - allPoints[j].x) ** 2 + 
        (allPoints[i].y - allPoints[j].y) ** 2
      );
      if (dist > maxDist) {
        maxDist = dist;
        p1 = allPoints[i];
        p2 = allPoints[j];
      }
    }
  }
  return [p1, p2];
}

/**
 * 分类主管和支管（基于合并后的管子）
 */
function classifyMainAndBranchPipes(mergedPipes, flowDirections) {
  if (mergedPipes.length === 0) {
    return { mainPipe: null, branchPipes: [] };
  }
  
  // 为每根管子计算权重
  const pipeScores = mergedPipes.map(pipe => {
    let score = 0;
    
    // 1. 总长度权重（主要因素）
    score += pipe.totalLength * 10;
    
    // 2. 管道段数量权重（段数多说明是主干）
    score += pipe.segments.length * 100;
    
    // 3. 焊点数量权重
    score += pipe.welds.length * 50;
    
    // 4. 流向箭头数量权重
    const arrowCount = pipe.pathIds.filter(id => flowDirections.has(id)).length;
    score += arrowCount * 200;
    
    return { pipe, score };
  });
  
  // 按分数排序
  pipeScores.sort((a, b) => b.score - a.score);
  
  // 分数最高的是主管
  const mainPipe = pipeScores[0].pipe;
  mainPipe.type = 'main';
  
  // 其余都是支管
  const branchPipes = pipeScores.slice(1).map(ps => {
    ps.pipe.type = 'branch';
    return ps.pipe;
  });
  
  console.log(`   🎯 主管: ${mainPipe.segments.length} 段, ${mainPipe.welds.length} 焊点, 总长 ${mainPipe.totalLength.toFixed(1)}`);
  branchPipes.forEach((pipe, i) => {
    console.log(`   🔀 支管${i+1}: ${pipe.segments.length} 段, ${pipe.welds.length} 焊点, 总长 ${pipe.totalLength.toFixed(1)}`);
  });
  
  return { mainPipe, branchPipes };
}


/**
 * 辅助：判断点是否靠近管道
 */
function isPointNearPipeline(point, pipeline, threshold) {
  return pipeline.segments.some(seg => {
    const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
    const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
    
    if (!p1 || !p2) return false;
    
    const dist = getDistancePointToSegment(point, p1, p2);
    return dist < threshold;
  });
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

