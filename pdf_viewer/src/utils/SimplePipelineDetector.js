/**
 * 简单管道识别器
 * 当前实际判断逻辑：
 * 1. Path 恰好由 4 根线段组成
 * 2. 路径闭合
 * 3. 结构宽度（两条短边平均值）位于 1.0 ~ 2.0
 */

import { groupVectorsIntoPathsStructured } from './WeldDetector';

export class SimplePipelineDetector {
  /**
   * @param {Array} vectors - 原始矢量元素数组 [type, x1, y1, x2, y2, color, width, id]
   * @param {Object} options - 配置选项
   */
  constructor(vectors, options = {}) {
    this.vectors = vectors || [];
    this.options = {
      segmentCount: 4,           // 线段数量（固定为4）
      closeThreshold: 5,         // 闭合判断阈值（起点和终点距离）
      ...options
    };
    this.detectedTees = []; // 🌟 缓存识别到的三通
  }

  /**
   * 识别管道
   * @param {Array} existingPaths - (可选) 已分组的 Path 列表，避免重复计算
   * @returns {Array} - 管道 Path 列表
   */
  detectPipelines(existingPaths = null) {
    if (!this.vectors || this.vectors.length === 0) {
      return [];
    }

    // console.log('🔍 开始简单管道识别...');
    // console.log('   判断逻辑: 4根线段 + 闭合路径 + 管径(1.0~2.0) = 管道');

    // 按 Path ID 分组
    const paths = existingPaths || groupVectorsIntoPathsStructured(this.vectors);
    if (!existingPaths) {
        // console.log(`  📊 共 ${paths.length} 个 Path`);
    }

    const pipelines = [];
    const { segmentCount, closeThreshold } = this.options;

    // 统计
    let totalPaths = paths.length;
    let fourSegmentPaths = 0;
    let closedPaths = 0;

    paths.forEach(path => {
      const segments = path.segments;

      // 条件 1：必须是 4 根线段
      if (segments.length !== segmentCount) {
        return;
      }
      fourSegmentPaths++;

      // 条件 2：必须是闭合路径
      const isClosed = this.isClosedPath(segments, closeThreshold);
      if (!isClosed) {
        return;
      }
      closedPaths++;

      // 条件 3：管径（结构宽度）必须在 1.0 ~ 2.0 之间
      // 避免识别到过细的标注线（< 1.0）或过粗的符号框（> 2.0）
      const structuralWidth = this.calculateStructuralWidth(segments);
      if (structuralWidth < 1.0 || structuralWidth > 2.0) {
        return;
      }

      // ✅ 符合条件：这是管道
      pipelines.push({
        pathId: path.id,
        segmentCount: segments.length,
        isClosed: true,
        vectorIndices: path.vectorIndices,
        segments: path.segments,
        // 计算一些有用的统计信息
        totalLength: this.calculateTotalLength(segments),
        avgWidth: this.calculateAvgWidth(segments),
        structuralWidth: structuralWidth, // 保存管径
        bbox: this.calculateBoundingBox(segments)
      });
    });

    console.log(`✅ 简单管道识别完成:`);
    console.log(`  📊 总 Path 数: ${totalPaths}`);
    console.log(`  📊 4线段 Path: ${fourSegmentPaths}`);
    console.log(`  📊 4线段 + 闭合: ${closedPaths}`);
    console.log(`  🎯 识别到管道: ${pipelines.length}`);

    if (pipelines.length > 0) {
      console.log(`\n  📊 管道统计:`);
      const avgLength = pipelines.reduce((sum, p) => sum + p.totalLength, 0) / pipelines.length;
      const avgWidth = pipelines.reduce((sum, p) => sum + p.avgWidth, 0) / pipelines.length;
      console.log(`    - 平均长度: ${avgLength.toFixed(1)}`);
      console.log(`    - 平均线宽: ${avgWidth.toFixed(3)}`);
    }

    // 🌟 新增：识别三通 (Tee) - 传入所有原始paths以查找连接节点
    this.detectedTees = this.detectTees(pipelines, paths);
    console.log(`  🧩 识别到三通组件: ${this.detectedTees.length} 组`);

    return pipelines;
  }

  /**
   * 识别三通（Tee）
   * 当前逻辑分两步：
   * 1. 从已识别的管道中筛出主轴长度足够的有效管段
   * 2. 识别两类三通：
   *    - 直接三通：3 根管道直接汇于同一点
   *    - 间接三通：3 根管道通过 1 个或多个小连接节点汇合
   * @param {Array} pipelines - 已识别的管道列表（4段闭合路径）
   * @param {Array} allPaths - 所有原始路径（用于查找连接节点）
   */
  detectTees(pipelines, allPaths = []) {
    const pipeMinLen = 10.0; // 正常管道的最小长度
    const connectorMinLen = 5.0; // 连接节点的最小长度
    const connectorMaxLen = 10.0; // 连接节点的最大长度
    
    // 1️⃣ 从已识别的管道中筛选有效管道（主轴长度 > 10）
    const validPipelines = pipelines.filter(p => {
      const mainAxisLength = this.calculateMainAxisLength(p.segments);
      p.mainAxisLength = mainAxisLength;
      p.isPipeline = true; // 🌟 标记为管道
      return mainAxisLength > pipeMinLen;
    });
    
    // 2️⃣ 从所有原始路径中查找潜在的连接节点（小型、多段闭合结构）
    const potentialConnectors = allPaths.filter(path => {
      // 跳过已识别为管道的
      if (pipelines.find(p => p.pathId === path.id)) {
        return false;
      }
      
      // 必须是闭合路径
      if (!this.isClosedPath(path.segments, this.options.closeThreshold)) {
        return false;
      }
      
      // 计算边界框尺寸（用于筛选小型结构）
      const bbox = this.calculateBoundingBox(path.segments);
      const size = Math.max(bbox.width, bbox.height);
      
      return size >= connectorMinLen && size <= connectorMaxLen;
    }).map(path => ({
      pathId: path.id,
      segments: path.segments,
      mainAxisLength: Math.max(
        this.calculateBoundingBox(path.segments).width,
        this.calculateBoundingBox(path.segments).height
      ),
      bbox: this.calculateBoundingBox(path.segments),
      isConnector: true, // 标记为连接节点
      isPipeline: false // 🌟 不是管道
    }));
    
    // 3️⃣ 合并候选对象：管道 + 连接节点
    const candidates = [...validPipelines, ...potentialConnectors];

    if (validPipelines.length < 3) {
      console.log(`  🔍 三通识别: 有效管道不足3个 (${validPipelines.length}，要求主轴长度>${pipeMinLen})`);
      return [];
    }

    console.log(`  🔍 三通识别: 筛选后 ${validPipelines.length} 个管道 + ${potentialConnectors.length} 个连接节点`);
    if (potentialConnectors.length > 0) {
      console.log(`    🔗 连接节点示例:`, potentialConnectors.slice(0, 3).map(c => 
        `pathId=${c.pathId}, 尺寸=${c.mainAxisLength.toFixed(2)}px`
      ));
    }

    // ========================================
    // 🔵 第一种三通：常规直接三通
    // 3个管道直接在一个点连接，使用严格的连接容差
    // ========================================
    console.log(`\n  🔵 识别第一种三通（常规直接三通）...`);
    const directTees = this.detectDirectTees(validPipelines);
    
    // ========================================
    // 🟢 第二种三通：间接连接三通
    // 3个管道通过1个连接节点连接，使用宽松的连接容差
    // ========================================
    console.log(`\n  🟢 识别第二种三通（间接连接三通）...`);
    const indirectTees = this.detectIndirectTees(validPipelines, potentialConnectors);
    
    // 合并结果
    const tees = [...directTees, ...indirectTees];
    console.log(`\n  🧩 最终识别到 ${tees.length} 个三通 (直接: ${directTees.length}, 间接: ${indirectTees.length})`);

    return tees;
  }

  /**
   * 🔵 识别第一种三通：常规直接三通
   * 3个管道直接在一个点连接
   */
  detectDirectTees(validPipelines) {
    const endpointMap = new Map();
    const threshold = 3.0; // 严格的连接容差（直接连接）

    // 辅助：找到或创建近似坐标的Key
    const getSpatialKey = (x, y) => {
      for (const key of endpointMap.keys()) {
        const [kx, ky] = key.split(',').map(Number);
        if (Math.sqrt((x - kx) ** 2 + (y - ky) ** 2) < threshold) {
          return key;
        }
      }
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    };

    // 只处理管道
    validPipelines.forEach(pipe => {
      const endPoints = this.getStructureEndpoints(pipe);
      
      endPoints.forEach(pt => {
        const key = getSpatialKey(pt.x, pt.y);
        if (!endpointMap.has(key)) {
          endpointMap.set(key, []);
        }
        const list = endpointMap.get(key);
        if (!list.includes(pipe)) {
          list.push(pipe);
        }
      });
    });

    const tees = [];
    endpointMap.forEach((connectedPipes, key) => {
      // 必须恰好3个管道
      if (connectedPipes.length === 3) {
        const [cx, cy] = key.split(',').map(Number);
        
        console.log(`    ✅ 找到常规直接三通 @ (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
        console.log(`       管道: [${connectedPipes.map(p => `${p.pathId}(${p.mainAxisLength.toFixed(1)}px)`).join(', ')}]`);
        
        // 标记这些管道为三通部分
        connectedPipes.forEach(pipe => {
          pipe.isTeePart = true;
          pipe.teeCenter = { x: cx, y: cy };
          pipe.type = 'tee_part';
        });

        tees.push({
          center: { x: cx, y: cy },
          parts: connectedPipes.map(p => p.pathId),
          type: 'direct'
        });
      }
    });
    
    console.log(`    📊 识别到 ${tees.length} 个常规直接三通`);
    return tees;
  }

  /**
   * 🟢 识别第二种三通：间接连接三通
   * 3个管道通过1个连接节点连接
   */
  detectIndirectTees(validPipelines, potentialConnectors) {
    const endpointMap = new Map();
    const threshold = 8.0; // 宽松的连接容差（允许通过连接节点）

    // 辅助：找到或创建近似坐标的Key
    const getSpatialKey = (x, y) => {
      for (const key of endpointMap.keys()) {
        const [kx, ky] = key.split(',').map(Number);
        if (Math.sqrt((x - kx) ** 2 + (y - ky) ** 2) < threshold) {
          return key;
        }
      }
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    };

    // 处理管道和连接节点
    const candidates = [...validPipelines, ...potentialConnectors];
    candidates.forEach(obj => {
      const endPoints = this.getStructureEndpoints(obj);
      
      endPoints.forEach(pt => {
        const key = getSpatialKey(pt.x, pt.y);
        if (!endpointMap.has(key)) {
          endpointMap.set(key, []);
        }
        const list = endpointMap.get(key);
        if (!list.includes(obj)) {
          list.push(obj);
        }
      });
    });

    const tees = [];
    
    // 🔍 调试：打印所有连接点的详细信息
    console.log(`    🔍 端点连接分析: 共 ${endpointMap.size} 个连接点`);
    let debugCount = 0;
    endpointMap.forEach((connectedObjs, key) => {
      // 筛选：只计算真正的管道，不计算连接节点
      const actualPipes = connectedObjs.filter(p => p.isPipeline === true);
      const connectors = connectedObjs.filter(p => p.isConnector === true);
      
      // 🔍 调试：打印3管道+1连接节点的候选点（前10个）
      if (actualPipes.length === 3 && connectors.length === 1 && debugCount < 10) {
        const [cx, cy] = key.split(',').map(Number);
        console.log(`      🔍 候选间接三通 @ (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
        console.log(`         管道: [${actualPipes.map(p => `${p.pathId}(${p.mainAxisLength.toFixed(1)}px)`).join(', ')}]`);
        console.log(`         连接节点: pathId=${connectors[0].pathId}, 尺寸=${connectors[0].mainAxisLength.toFixed(2)}px`);
        debugCount++;
      }
      
      // 🔍 调试：打印包含目标管道的连接点
      const targetIds = [9056, 9091, 9387];
      const hasTarget = connectedObjs.some(obj => targetIds.includes(obj.pathId));
      if (hasTarget && debugCount < 20) {
        const [cx, cy] = key.split(',').map(Number);
        console.log(`      🎯 包含目标管道的连接点 @ (${cx.toFixed(1)}, ${cy.toFixed(1)}): ${actualPipes.length}管道 + ${connectors.length}连接节点`);
        console.log(`         对象列表: [${connectedObjs.map(o => `${o.pathId}(${o.isPipeline ? '管道' : o.isConnector ? '连接节点' : '未知'})`).join(', ')}]`);
        
        // 🔍 打印连接节点的详细信息
        if (connectors.length > 0) {
          console.log(`         📍 连接节点详情:`);
          connectors.forEach(c => {
            const bbox = c.bbox || c.boundingBox;
            console.log(`            - pathId=${c.pathId}: 尺寸=${c.mainAxisLength?.toFixed(2)}px, 中心=(${bbox?.centerX?.toFixed(1)}, ${bbox?.centerY?.toFixed(1)}), bbox宽高=(${bbox?.width?.toFixed(1)} x ${bbox?.height?.toFixed(1)})`);
          });
        }
        debugCount++;
      }
      
      // 必须恰好3个管道 + 至少1个连接节点
      if (actualPipes.length === 3 && connectors.length >= 1) {
        const [cx, cy] = key.split(',').map(Number);
        
        console.log(`    ✅ 找到间接连接三通 @ (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
        console.log(`       连接节点: [${connectors.map(c => `${c.pathId}(${c.mainAxisLength.toFixed(2)}px)`).join(', ')}]`);
        console.log(`       管道: [${actualPipes.map(p => `${p.pathId}(${p.mainAxisLength.toFixed(1)}px)`).join(', ')}]`);
        
        // 标记3个管道为三通部分
        actualPipes.forEach(pipe => {
          pipe.isTeePart = true;
          pipe.teeCenter = { x: cx, y: cy };
          pipe.type = 'tee_part';
        });
        
        // 标记所有连接节点
        connectors.forEach(connector => {
          connector.type = 'tee_connector';
          connector.teeCenter = { x: cx, y: cy };
        });

        tees.push({
          center: { x: cx, y: cy },
          parts: actualPipes.map(p => p.pathId),
          connectors: connectors.map(c => c.pathId), // 记录所有连接节点
          type: 'indirect'
        });
      }
    });
    
    console.log(`    📊 识别到 ${tees.length} 个间接连接三通`);
    return tees;
  }

  /**
   * 计算管道主轴长度（最长边）
   * 对于4线段矩形，返回两条长边的平均值
   */
  calculateMainAxisLength(segments) {
    if (segments.length !== 4) return 0;
    
    // 计算每条边的长度
    const lengths = segments.map(s => 
      Math.sqrt(Math.pow(s.x2 - s.x1, 2) + Math.pow(s.y2 - s.y1, 2))
    );
    
    // 排序，取最长的两条边的平均值
    const sortedLengths = [...lengths].sort((a, b) => b - a);
    return (sortedLengths[0] + sortedLengths[1]) / 2;
  }

  /**
   * 获取管道结构的逻辑端点
   * 对于矩形短管，取距离最远的两个点
   */
  getStructureEndpoints(pipe) {
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
   * 判断是否为闭合路径
   * @param {Array} segments - 线段数组
   * @param {number} threshold - 距离阈值
   * @returns {boolean}
   */
  isClosedPath(segments, threshold) {
    if (segments.length === 0) return false;

    // 获取第一个线段的起点
    const firstSegment = segments[0];
    const startPoint = { x: firstSegment.x1, y: firstSegment.y1 };

    // 获取最后一个线段的终点
    const lastSegment = segments[segments.length - 1];
    const endPoint = { x: lastSegment.x2, y: lastSegment.y2 };

    // 计算距离
    const distance = Math.sqrt(
      Math.pow(endPoint.x - startPoint.x, 2) + 
      Math.pow(endPoint.y - startPoint.y, 2)
    );

    return distance < threshold;
  }

  /**
   * 计算结构宽度（管径）
   * 取两条最短边的平均长度
   */
  calculateStructuralWidth(segments) {
    if (segments.length !== 4) return 0;
    
    const lengths = segments.map(s => 
      Math.sqrt(Math.pow(s.x2 - s.x1, 2) + Math.pow(s.y2 - s.y1, 2))
    );
    
    // 找出两条短边
    const sortedLengths = [...lengths].sort((a, b) => a - b);
    return (sortedLengths[0] + sortedLengths[1]) / 2;
  }

  /**
   * 计算总长度
   */
  calculateTotalLength(segments) {
    return segments.reduce((sum, s) => {
      const len = Math.sqrt(
        Math.pow(s.x2 - s.x1, 2) + 
        Math.pow(s.y2 - s.y1, 2)
      );
      return sum + len;
    }, 0);
  }

  /**
   * 计算平均线宽
   */
  calculateAvgWidth(segments) {
    const totalWidth = segments.reduce((sum, s) => sum + s.width, 0);
    return totalWidth / segments.length;
  }

  /**
   * 计算边界框
   */
  calculateBoundingBox(segments) {
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
   * 检查指定 Path 是否为管道
   * @param {number} pathId - Path ID
   * @returns {boolean}
   */
  isPipeline(pathId) {
    const pipelines = this.detectPipelines();
    return pipelines.some(p => p.pathId === pathId);
  }

  /**
   * 获取所有管道的 Path ID 集合
   * @returns {Set}
   */
  getPipelinePathIds() {
    const pipelines = this.detectPipelines();
    return new Set(pipelines.map(p => p.pathId));
  }

  /**
   * 获取所有管道的矢量索引集合
   * @returns {Set}
   */
  getPipelineVectorIndices() {
    const pipelines = this.detectPipelines();
    const indices = new Set();
    pipelines.forEach(p => {
      p.vectorIndices.forEach(idx => indices.add(idx));
    });
    return indices;
  }

  /**
   * 🌟 获取已识别的三通数据
   * 在调用 detectPipelines() 后使用此方法获取三通信息
   * @returns {Array} 三通列表
   */
  getDetectedTees() {
    return this.detectedTees || [];
  }
}

/**
 * 快速检查：给定 segments 是否构成管道
 * @param {Array} segments - 线段数组
 * @param {number} closeThreshold - 闭合阈值（默认5）
 * @returns {boolean}
 */
export function isPipelineBySegments(segments, closeThreshold = 5) {
  // 必须是4根线段
  if (segments.length !== 4) {
    return false;
  }

  // 必须闭合
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  
  const distance = Math.sqrt(
    Math.pow(lastSegment.x2 - firstSegment.x1, 2) + 
    Math.pow(lastSegment.y2 - firstSegment.y1, 2)
  );

  return distance < closeThreshold;
}
