/**
 * 管道网络拓扑遍历工具
 * 将管道连接成网络，从起始端开始沿管道路径遍历焊点
 * 支持流向箭头识别，按流向方向遍历
 */

import { associateArrowsWithPipelines } from './PipelineNetworkUtils';

/**
 * 构建管道网络拓扑图
 * @param {Array} pipelines - 管道列表
 * @param {Array} flowArrows - 流向箭头列表（可选）
 * @param {number} connectionThreshold - 连接判定阈值（端点距离）
 * @returns {Object} - 网络拓扑信息
 */
export function buildPipelineNetwork(pipelines, flowArrows = null, connectionThreshold = 20) {
  if (!pipelines || pipelines.length === 0) {
    return { nodes: [], edges: [], networks: [] };
  }

  console.log(`🔗 开始构建管道网络，共 ${pipelines.length} 根管道`);

  // 0. 处理流向箭头（如果有）
  let pipelineFlowDirections = new Map(); // pipelineId -> direction
  if (flowArrows && flowArrows.length > 0) {
    console.log(`  🎯 识别到 ${flowArrows.length} 个流向箭头`);
    
    // 关联箭头到管道
    const validArrows = associateArrowsWithPipelines(flowArrows, pipelines, 10);
    console.log(`  ✅ 有效箭头: ${validArrows.length} 个`);
    
    // 提取每个管道的流向
    validArrows.forEach(arrow => {
      if (arrow.relatedPipelineId) {
        const direction = extractArrowDirection(arrow);
        if (direction) {
          pipelineFlowDirections.set(arrow.relatedPipelineId, direction);
          console.log(`    管道 ${arrow.relatedPipelineId}: 流向 ${(direction.angle * 180 / Math.PI).toFixed(0)}°`);
        }
      }
    });
  }

  // 1. 提取每根管道的端点
  const pipelineEndpoints = pipelines.map(pipe => {
    const endpoints = extractPipelineEndpoints(pipe);
    const flowDirection = pipelineFlowDirections.get(pipe.pathId);
    
    return {
      pipelineId: pipe.pathId,
      pipeline: pipe,
      start: endpoints.start,
      end: endpoints.end,
      flowDirection: flowDirection  // 流向信息
    };
  });

  // 2. 构建连接关系（哪些管道通过端点相连）
  const connections = []; // [{ pipe1, pipe2, connectionPoint }]
  
  for (let i = 0; i < pipelineEndpoints.length; i++) {
    for (let j = i + 1; j < pipelineEndpoints.length; j++) {
      const pipe1 = pipelineEndpoints[i];
      const pipe2 = pipelineEndpoints[j];
      
      // 检查4种可能的连接方式
      const connections_to_check = [
        { p1: pipe1.start, p2: pipe2.start, type: 'start-start' },
        { p1: pipe1.start, p2: pipe2.end, type: 'start-end' },
        { p1: pipe1.end, p2: pipe2.start, type: 'end-start' },
        { p1: pipe1.end, p2: pipe2.end, type: 'end-end' }
      ];
      
      connections_to_check.forEach(conn => {
        const dist = getDistance(conn.p1, conn.p2);
        if (dist < connectionThreshold) {
          connections.push({
            pipe1: pipe1.pipelineId,
            pipe2: pipe2.pipelineId,
            connectionPoint: {
              x: (conn.p1.x + conn.p2.x) / 2,
              y: (conn.p1.y + conn.p2.y) / 2
            },
            type: conn.type,
            distance: dist
          });
        }
      });
    }
  }

  console.log(`  🔗 发现 ${connections.length} 个管道连接点`);

  // 3. 构建邻接表（图结构）
  const adjacencyList = new Map();
  pipelines.forEach(pipe => {
    adjacencyList.set(pipe.pathId, []);
  });

  connections.forEach(conn => {
    adjacencyList.get(conn.pipe1).push({
      neighborId: conn.pipe2,
      connectionPoint: conn.connectionPoint,
      type: conn.type
    });
    adjacencyList.get(conn.pipe2).push({
      neighborId: conn.pipe1,
      connectionPoint: conn.connectionPoint,
      type: conn.type
    });
  });

  // 4. 识别独立的管道网络（连通分量）
  const networks = findConnectedComponents(adjacencyList, pipelines);

  console.log(`  📊 识别到 ${networks.length} 个独立的管道网络`);
  networks.forEach((network, index) => {
    console.log(`    网络 ${index + 1}: ${network.pipelines.length} 根管道`);
  });

  return {
    pipelineEndpoints,
    connections,
    adjacencyList,
    networks,
    flowDirections: pipelineFlowDirections  // 返回流向信息
  };
}

/**
 * 提取箭头的方向
 * @param {Object} arrow - 箭头对象
 * @returns {Object} - { angle, vector: {x, y} }
 */
function extractArrowDirection(arrow) {
  if (!arrow.segments || arrow.segments.length === 0) {
    return null;
  }

  // 找到最长的线段作为箭头主方向
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

  // 计算方向向量
  const dx = mainSegment.x2 - mainSegment.x1;
  const dy = mainSegment.y2 - mainSegment.y1;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length === 0) return null;

  return {
    angle: Math.atan2(dy, dx),
    vector: {
      x: dx / length,
      y: dy / length
    },
    from: { x: mainSegment.x1, y: mainSegment.y1 },
    to: { x: mainSegment.x2, y: mainSegment.y2 }
  };
}

/**
 * 提取管道的两个端点
 * @param {Object} pipeline - 管道对象
 * @returns {Object} - { start, end }
 */
function extractPipelineEndpoints(pipeline) {
  if (!pipeline.segments || pipeline.segments.length === 0) {
    return { start: null, end: null };
  }

  // 获取所有线段的端点
  const allPoints = [];
  pipeline.segments.forEach(seg => {
    const p1 = seg.p1 || seg.start || { x: seg.x1, y: seg.y1 };
    const p2 = seg.p2 || seg.end || { x: seg.x2, y: seg.y2 };
    allPoints.push(p1, p2);
  });

  if (allPoints.length === 0) {
    return { start: null, end: null };
  }

  // 对于4线段闭合管道，找到对角线的两个端点
  // 策略：找到距离最远的两个点
  let maxDistance = 0;
  let start = allPoints[0];
  let end = allPoints[0];

  for (let i = 0; i < allPoints.length; i++) {
    for (let j = i + 1; j < allPoints.length; j++) {
      const dist = getDistance(allPoints[i], allPoints[j]);
      if (dist > maxDistance) {
        maxDistance = dist;
        start = allPoints[i];
        end = allPoints[j];
      }
    }
  }

  return { start, end };
}

/**
 * 查找连通分量（独立的管道网络）
 * @param {Map} adjacencyList - 邻接表
 * @param {Array} pipelines - 管道列表
 * @returns {Array} - 网络列表
 */
function findConnectedComponents(adjacencyList, pipelines) {
  const visited = new Set();
  const networks = [];

  pipelines.forEach(pipe => {
    if (!visited.has(pipe.pathId)) {
      // 使用DFS找到所有连通的管道
      const network = [];
      dfs(pipe.pathId, adjacencyList, visited, network);
      
      networks.push({
        pipelines: network.map(id => pipelines.find(p => p.pathId === id)),
        pipelineIds: network
      });
    }
  });

  return networks;
}

/**
 * 深度优先搜索
 */
function dfs(nodeId, adjacencyList, visited, result) {
  visited.add(nodeId);
  result.push(nodeId);

  const neighbors = adjacencyList.get(nodeId) || [];
  neighbors.forEach(neighbor => {
    if (!visited.has(neighbor.neighborId)) {
      dfs(neighbor.neighborId, adjacencyList, visited, result);
    }
  });
}

/**
 * 按管道网络拓扑遍历焊点
 * @param {Array} welds - 焊点列表（已关联到管道）
 * @param {Array} pipelines - 管道列表
 * @param {Array} flowArrows - 流向箭头列表（可选）
 * @param {Object} options - 选项
 * @returns {Array} - 排序后的焊点列表
 */
export function sortWeldsByPipelineNetwork(welds, pipelines, flowArrows = null, options = {}) {
  const {
    connectionThreshold = 20,  // 管道连接判定阈值
    startPosition = 'top-left', // 起始网络选择策略
    respectFlowDirection = true // 是否遵循流向（默认true）
  } = options;

  if (!welds || welds.length === 0) return [];
  if (!pipelines || pipelines.length === 0) {
    console.warn('  ⚠️ 没有管道数据，无法使用网络遍历');
    return welds;
  }

  console.log(`🔗 开始管道网络拓扑遍历，焊点数=${welds.length}, 管道数=${pipelines.length}`);
  
  if (flowArrows && flowArrows.length > 0) {
    console.log(`  🎯 考虑流向箭头: ${flowArrows.length} 个`);
  }

  // 1. 构建管道网络（包含流向信息）
  const network = buildPipelineNetwork(pipelines, flowArrows, connectionThreshold);

  // 2. 对每个独立网络进行遍历
  const sortedWelds = [];
  const processedWeldIds = new Set();

  // 按网络的位置排序（从左上到右下）
  const sortedNetworks = sortNetworksByPosition(network.networks, startPosition);

  sortedNetworks.forEach((net, netIndex) => {
    console.log(`\n  📍 处理网络 ${netIndex + 1}/${sortedNetworks.length}`);
    
    // 找到该网络中的所有焊点
    const networkWelds = welds.filter(weld => 
      weld.relatedPipelineId && net.pipelineIds.includes(weld.relatedPipelineId)
    );

    if (networkWelds.length === 0) {
      console.log(`    ⚠️ 网络中没有焊点`);
      return;
    }

    console.log(`    🔥 网络中有 ${networkWelds.length} 个焊点`);

    // 3. 在网络内部按拓扑顺序遍历焊点（考虑流向）
    const networkSorted = traverseNetworkWelds(
      networkWelds,
      net,
      network.adjacencyList,
      network.flowDirections,
      startPosition,
      respectFlowDirection
    );

    networkSorted.forEach(weld => {
      if (!processedWeldIds.has(getWeldId(weld))) {
        sortedWelds.push(weld);
        processedWeldIds.add(getWeldId(weld));
      }
    });
  });

  // 4. 添加未关联到管道的焊点（按位置排序）
  const unassignedWelds = welds.filter(weld => 
    !processedWeldIds.has(getWeldId(weld))
  );

  if (unassignedWelds.length > 0) {
    console.log(`\n  📍 处理 ${unassignedWelds.length} 个未关联焊点`);
    // 按左到右排序
    const unassignedSorted = [...unassignedWelds].sort((a, b) => 
      getWeldX(a) - getWeldX(b)
    );
    sortedWelds.push(...unassignedSorted);
  }

  console.log(`\n  ✅ 管道网络遍历完成，共 ${sortedWelds.length} 个焊点`);

  return sortedWelds;
}

/**
 * 遍历单个管道网络中的焊点
 * @param {Array} welds - 网络中的焊点
 * @param {Object} network - 网络对象
 * @param {Map} adjacencyList - 邻接表
 * @param {Map} flowDirections - 流向信息
 * @param {string} startPosition - 起点策略
 * @param {boolean} respectFlowDirection - 是否遵循流向
 * @returns {Array} - 排序后的焊点
 */
function traverseNetworkWelds(welds, network, adjacencyList, flowDirections, startPosition, respectFlowDirection) {
  // 1. 选择起始管道（考虑流向）
  const startPipeline = selectStartPipelineWithFlow(
    network.pipelines, 
    flowDirections, 
    startPosition,
    respectFlowDirection
  );
  
  const hasFlow = flowDirections && flowDirections.has(startPipeline.pathId);
  console.log(`      起始管道: ${startPipeline.pathId}${hasFlow ? ' (有流向)' : ''}`);

  // 2. 使用BFS遍历管道网络
  const visited = new Set();
  const pipelineOrder = [];
  const queue = [startPipeline.pathId];
  visited.add(startPipeline.pathId);

  while (queue.length > 0) {
    const currentPipeId = queue.shift();
    pipelineOrder.push(currentPipeId);

    // 访问相邻的管道
    const neighbors = adjacencyList.get(currentPipeId) || [];
    neighbors.forEach(neighbor => {
      if (!visited.has(neighbor.neighborId)) {
        visited.add(neighbor.neighborId);
        queue.push(neighbor.neighborId);
      }
    });
  }

  console.log(`      管道遍历顺序: ${pipelineOrder.join(' → ')}`);

  // 3. 按管道顺序收集焊点（考虑流向）
  const sortedWelds = [];
  pipelineOrder.forEach(pipeId => {
    // 找到该管道上的焊点
    const pipeWelds = welds.filter(w => w.relatedPipelineId === pipeId);
    
    if (pipeWelds.length > 0) {
      // 在单根管道上，按位置排序焊点（考虑流向）
      const pipeline = network.pipelines.find(p => p.pathId === pipeId);
      const flowDirection = flowDirections ? flowDirections.get(pipeId) : null;
      
      const sorted = sortWeldsAlongPipeline(
        pipeWelds, 
        pipeline, 
        flowDirection, 
        respectFlowDirection
      );
      
      sortedWelds.push(...sorted);
      
      const flowInfo = flowDirection ? ' (按流向)' : '';
      console.log(`      管道 ${pipeId}: ${sorted.length} 个焊点${flowInfo}`);
    }
  });

  return sortedWelds;
}

/**
 * 沿管道方向排序焊点
 * @param {Array} welds - 管道上的焊点
 * @param {Object} pipeline - 管道对象
 * @param {Object} flowDirection - 流向信息（可选）
 * @param {boolean} respectFlowDirection - 是否遵循流向
 * @returns {Array} - 排序后的焊点
 */
function sortWeldsAlongPipeline(welds, pipeline, flowDirection = null, respectFlowDirection = true) {
  if (!pipeline || welds.length <= 1) {
    return welds;
  }

  // 优先使用流向箭头的方向
  let direction = null;
  
  if (respectFlowDirection && flowDirection) {
    direction = flowDirection.vector;
    console.log(`        使用流向: ${(flowDirection.angle * 180 / Math.PI).toFixed(0)}°`);
  } else {
    // 否则使用管道的主方向
    const mainDirection = getPipelineMainDirection(pipeline);
    if (mainDirection) {
      direction = { x: mainDirection.x, y: mainDirection.y };
    }
  }
  
  if (!direction) {
    // 无法确定方向，按X坐标排序
    return [...welds].sort((a, b) => getWeldX(a) - getWeldX(b));
  }

  // 沿方向投影并排序
  return [...welds].sort((a, b) => {
    const projA = projectOnDirection(a, direction);
    const projB = projectOnDirection(b, direction);
    return projA - projB;
  });
}

/**
 * 获取管道主方向
 */
function getPipelineMainDirection(pipeline) {
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
 * 将焊点投影到方向向量上
 */
function projectOnDirection(weld, direction) {
  const x = getWeldX(weld);
  const y = getWeldY(weld);
  return x * direction.x + y * direction.y;
}

/**
 * 选择起始管道（考虑流向）
 * @param {Array} pipelines - 管道列表
 * @param {Map} flowDirections - 流向信息
 * @param {string} position - 位置策略
 * @param {boolean} respectFlowDirection - 是否遵循流向
 * @returns {Object} - 起始管道
 */
function selectStartPipelineWithFlow(pipelines, flowDirections, position, respectFlowDirection) {
  if (pipelines.length === 0) return null;
  if (pipelines.length === 1) return pipelines[0];

  // 如果要遵循流向，优先选择有流向箭头的管道作为起点
  if (respectFlowDirection && flowDirections && flowDirections.size > 0) {
    // 找到所有有流向的管道
    const pipelinesWithFlow = pipelines.filter(p => flowDirections.has(p.pathId));
    
    if (pipelinesWithFlow.length > 0) {
      console.log(`      发现 ${pipelinesWithFlow.length} 根有流向的管道`);
      
      // 在有流向的管道中，选择最符合起始位置的
      return selectStartPipeline(pipelinesWithFlow, position);
    }
  }

  // 否则按常规方式选择
  return selectStartPipeline(pipelines, position);
}

/**
 * 选择起始管道
 */
function selectStartPipeline(pipelines, position) {
  if (pipelines.length === 0) return null;
  if (pipelines.length === 1) return pipelines[0];

  // 根据位置策略选择起始管道
  switch (position) {
    case 'top-left':
      return pipelines.reduce((best, pipe) => {
        const score = pipe.bbox.minX + pipe.bbox.minY;
        const bestScore = best.bbox.minX + best.bbox.minY;
        return score < bestScore ? pipe : best;
      });
    
    case 'top-right':
      return pipelines.reduce((best, pipe) => {
        const score = -pipe.bbox.maxX + pipe.bbox.minY;
        const bestScore = -best.bbox.maxX + best.bbox.minY;
        return score < bestScore ? pipe : best;
      });
    
    case 'bottom-left':
      return pipelines.reduce((best, pipe) => {
        const score = pipe.bbox.minX - pipe.bbox.maxY;
        const bestScore = best.bbox.minX - best.bbox.maxY;
        return score < bestScore ? pipe : best;
      });
    
    default:
      return pipelines[0];
  }
}

/**
 * 按位置排序网络
 */
function sortNetworksByPosition(networks, position) {
  if (networks.length <= 1) return networks;

  return [...networks].sort((a, b) => {
    // 计算每个网络的边界框
    const bboxA = calculateNetworkBoundingBox(a.pipelines);
    const bboxB = calculateNetworkBoundingBox(b.pipelines);

    // 根据位置策略排序
    switch (position) {
      case 'top-left':
        return (bboxA.minX + bboxA.minY) - (bboxB.minX + bboxB.minY);
      case 'top-right':
        return (-bboxA.maxX + bboxA.minY) - (-bboxB.maxX + bboxB.minY);
      case 'bottom-left':
        return (bboxA.minX - bboxA.maxY) - (bboxB.minX - bboxB.maxY);
      default:
        return (bboxA.minX + bboxA.minY) - (bboxB.minX + bboxB.minY);
    }
  });
}

/**
 * 计算网络的边界框
 */
function calculateNetworkBoundingBox(pipelines) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  pipelines.forEach(pipe => {
    if (pipe.bbox) {
      minX = Math.min(minX, pipe.bbox.minX);
      minY = Math.min(minY, pipe.bbox.minY);
      maxX = Math.max(maxX, pipe.bbox.maxX);
      maxY = Math.max(maxY, pipe.bbox.maxY);
    }
  });

  return { minX, minY, maxX, maxY };
}

/**
 * 辅助函数：计算两点距离
 */
function getDistance(p1, p2) {
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}

/**
 * 辅助函数：获取焊点X坐标
 */
function getWeldX(weld) {
  return weld.center ? weld.center.x : (weld.boundingBox.minX + weld.boundingBox.width / 2);
}

/**
 * 辅助函数：获取焊点Y坐标
 */
function getWeldY(weld) {
  return weld.center ? weld.center.y : (weld.boundingBox.minY + weld.boundingBox.height / 2);
}

/**
 * 辅助函数：获取焊点唯一ID
 */
function getWeldId(weld) {
  return weld.id || `${weld.pathId}_${weld.pageNum}_${weld.pageIndex}`;
}

