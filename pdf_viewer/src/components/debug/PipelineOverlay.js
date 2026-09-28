import React, { useRef, useEffect, useMemo } from 'react';
import { SimplePipelineDetector } from '../../utils/SimplePipelineDetector';
import { filterPipelinesByWelds, associateArrowsWithPipelines, associateWeldsWithPipelines } from '../../utils/PipelineNetworkUtils';
import { PathTypeClassifier, PathType } from '../../utils/PathTypeClassifier';
import { groupVectorsIntoPathsStructured } from '../../utils/WeldDetector';
import { analyzePipelineTopology } from '../../utils/PipelineTopologyAnalyzer';
import { getVectorSegmentType } from '../../utils/vectorTypeUtils';

const EMPTY_RENDER_STATS = {
  pipelineCount: 0,
  teeCount: 0,
  mainPipeCount: 0,
  branchPipeCount: 0,
  flowArrowCount: 0,
  uniqueEdgeCount: 0,
  mainEndpointCount: 0,
  branchEndpointCount: 0,
  numberedWeldCount: 0,
  avgWidth: 0,
  totalLength: 0
};

/**
 * 管道可视化组件
 * 高亮显示识别到的管道（4线段+闭合）和流向箭头
 * 区分主管（深蓝色）和支管（浅蓝色）
 */
export const PipelineOverlay = ({ 
  vectors, 
  scale = 1, 
  visible = false,
  options = {}
}) => {
  const canvasRef = useRef(null);

  /**
   * 判断两条边是否共用（位置相近且方向一致或相反）
   */
  const areEdgesShared = (edge1, edge2, threshold = 5) => {
    // 检查是否是同一条边
    const dist1 = Math.sqrt(Math.pow(edge1.start.x - edge2.start.x, 2) + Math.pow(edge1.start.y - edge2.start.y, 2));
    const dist2 = Math.sqrt(Math.pow(edge1.end.x - edge2.end.x, 2) + Math.pow(edge1.end.y - edge2.end.y, 2));
    
    // 正向匹配
    if (dist1 < threshold && dist2 < threshold) return true;
    
    // 反向匹配
    const dist3 = Math.sqrt(Math.pow(edge1.start.x - edge2.end.x, 2) + Math.pow(edge1.start.y - edge2.end.y, 2));
    const dist4 = Math.sqrt(Math.pow(edge1.end.x - edge2.start.x, 2) + Math.pow(edge1.end.y - edge2.start.y, 2));
    
    if (dist3 < threshold && dist4 < threshold) return true;
    
    return false;
  };

  /**
   * 计算两条边之间的距离（使用中点）
   */
  const getEdgeDistance = (edge1, edge2) => {
    const mid1 = {
      x: (edge1.start.x + edge1.end.x) / 2,
      y: (edge1.start.y + edge1.end.y) / 2
    };
    const mid2 = {
      x: (edge2.start.x + edge2.end.x) / 2,
      y: (edge2.start.y + edge2.end.y) / 2
    };
    
    return Math.sqrt(Math.pow(mid1.x - mid2.x, 2) + Math.pow(mid1.y - mid2.y, 2));
  };

  /**
   * 判断两条边是否平行
   */
  const areEdgesParallel = (edge1, edge2, angleThreshold = 15) => {
    const dir1 = {
      x: edge1.end.x - edge1.start.x,
      y: edge1.end.y - edge1.start.y
    };
    const dir2 = {
      x: edge2.end.x - edge2.start.x,
      y: edge2.end.y - edge2.start.y
    };
    
    const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
    const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);
    
    if (len1 === 0 || len2 === 0) return false;
    
    dir1.x /= len1;
    dir1.y /= len1;
    dir2.x /= len2;
    dir2.y /= len2;
    
    const dotProduct = Math.abs(dir1.x * dir2.x + dir1.y * dir2.y);
    const angleThresholdCos = Math.cos(angleThreshold * Math.PI / 180);
    
    return dotProduct > angleThresholdCos;
  };

  /**
   * 获取管道的所有边（4条边），并区分长边和宽边
   */
  const getPipelineEdges = (pipeline, vectors) => {
    const edges = [];
    const pathId = pipeline.pathId;
    
    vectors.forEach((vec, index) => {
      if (!Array.isArray(vec) || vec.length < 8) return;
      const [type, x1, y1, x2, y2, color, width, vecPathId] = vec;
      
      if (vecPathId === pathId) {
        const length = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
        edges.push({
          vectorIndex: index,
          start: { x: x1, y: y1 },
          end: { x: x2, y: y2 },
          width,
          pathId,
          length
        });
      }
    });
    
    // 区分长边和宽边
    // 管道由4条边组成：2条长边（主要方向）+ 2条宽边（宽度方向，较短）
    if (edges.length === 4) {
      // 按长度排序
      const sortedByLength = [...edges].sort((a, b) => b.length - a.length);
      const avgLongEdge = (sortedByLength[0].length + sortedByLength[1].length) / 2;
      const avgShortEdge = (sortedByLength[2].length + sortedByLength[3].length) / 2;
      
      // 标记边的类型
      edges.forEach(edge => {
        edge.isWidthEdge = edge.length < (avgLongEdge + avgShortEdge) / 2; // 宽边（短边）
      });
    }
    
    return edges;
  };

  // 识别管道（按 Path 判断：4线段+闭合）和流向箭头，并进行拓扑分析
  const pipelineData = useMemo(() => {
    if (!visible || !vectors || vectors.length === 0) {
      return { 
        pipelines: [], 
        segments: [], 
        flowArrows: [], 
        flowArrowSegments: [],
        mainPipes: [],
        branchPipes: [],
        topology: null,
        uniqueEdges: []
      };
    }

    console.log('🔍 开始管道及组件识别...');
    
    // 1. 先识别流向箭头（优先级高，避免被误识别为管道）
    const paths = groupVectorsIntoPathsStructured(vectors);
    
    // 🔧 优化：尝试复用全局识别器的分类结果，避免重复计算
    let classifications;
    if (window.__weldRecognizer__ && window.__weldRecognizer__.getAllClassifications) {
      classifications = window.__weldRecognizer__.getAllClassifications();
      if (classifications && classifications.size > 0) {
         console.log('🔗 [PipelineOverlay] 复用全局 Path 分类结果');
      } else {
         classifications = null;
      }
    }
    
    if (!classifications) {
      const classifier = new PathTypeClassifier(vectors);
      classifications = classifier.classifyAllPaths(paths);
    }
    
    const flowArrows = [];
    const flowArrowPathIds = new Set();
    paths.forEach(path => {
       const result = classifications.get(path.id);
       if (result && result.type === PathType.FLOW_ARROW && result.confidence > 0.6) {
           flowArrows.push(path);
           flowArrowPathIds.add(path.id);
       }
    });
    
    console.log(`   🎯 识别到流向箭头: ${flowArrows.length} 个 (Path IDs: [${Array.from(flowArrowPathIds).slice(0, 5).join(', ')}...])`);
    
    // 2. 识别管道（排除流向箭头）
    let allPipelines;
    let tees;
    
    // 🔧 尝试使用全局缓存
    if (typeof window !== 'undefined') {
      if (!window.__pipelineCache__) window.__pipelineCache__ = new WeakMap();
      if (window.__pipelineCache__.has(vectors)) {
        const cached = window.__pipelineCache__.get(vectors);
        allPipelines = cached.allPipelines;
        tees = cached.tees;
        console.log('⚡ [PipelineOverlay] 复用缓存的管道识别结果');
      }
    }

    if (!allPipelines) {
      const detector = new SimplePipelineDetector(vectors);
      // 🔧 传递已分组的 paths，避免重复计算
      allPipelines = detector.detectPipelines(paths);
      // 🌟 获取三通信息（已在 detectPipelines() 中识别，直接获取缓存）
      tees = detector.getDetectedTees();
      
      // 写入缓存
      if (typeof window !== 'undefined' && window.__pipelineCache__) {
        window.__pipelineCache__.set(vectors, { allPipelines, tees });
      }
    }
    
    // 过滤掉流向箭头
    let pipelines = allPipelines.filter(p => !flowArrowPathIds.has(p.pathId));
    if (allPipelines.length > pipelines.length) {
      console.log(`   ✂️ 排除流向箭头: ${allPipelines.length} -> ${pipelines.length} (剔除 ${allPipelines.length - pipelines.length})`);
    }
    
    // 🌟 获取三通信息（已在 detectPipelines() 中识别，直接获取缓存）
    // const tees = detector.getDetectedTees();
    
    // 🔗 焊点邻域过滤
    // 尝试获取全局纯净焊点
    let welds = [];
    const visualizerRef = window.__firstPageVisualizerRef__;
    
    if (visualizerRef && visualizerRef.current && visualizerRef.current.getDisplayedWelds) {
      welds = visualizerRef.current.getDisplayedWelds();
      console.log(`   🔗 获取到已过滤焊点: ${welds.length} 个`);
    } else if (window.__weldRecognizer__) {
      welds = window.__weldRecognizer__.getDetectedWelds();
      console.warn(`   ⚠️ 使用原始检测焊点 (未过滤OCR): ${welds.length} 个`);
    }
    
    if (welds.length > 0) {
      // 🔧 关键修复：在 PipelineOverlay 内部也执行焊点-管道关联
      // 确保焊点对象具有 relatedPipelineId 属性，避免依赖外部关联的时序问题
      try {
        associateWeldsWithPipelines(welds, pipelines, 15);
        const associatedCount = welds.filter(w => w.relatedPipeline).length;
        console.log(`   🔗 [PipelineOverlay] 焊点-管道关联完成: ${associatedCount}/${welds.length} 个焊点`);
      } catch (e) {
        console.warn('   ⚠️ [PipelineOverlay] 焊点-管道关联失败:', e);
      }
      
      const originalCount = pipelines.length;
      pipelines = filterPipelinesByWelds(pipelines, welds, 50); // 50px 阈值
      console.log(`   ✂️ 焊点过滤: ${originalCount} -> ${pipelines.length} (剔除 ${originalCount - pipelines.length})`);
    } else {
      console.warn('   ⚠️ 未获取到焊点数据，跳过邻域过滤');
    }

    // 3. 关联流向箭头与管道 (注意：必须使用过滤后的 pipelines)
    const validFlowArrows = associateArrowsWithPipelines(flowArrows, pipelines, 5); // 5px 阈值，必须紧贴管道
    
    console.log(`   🎯 识别到流向箭头: ${flowArrows.length} 个, 有效关联(过滤后): ${validFlowArrows.length} 个`);
    
    // 4. 拓扑分析：区分主管和支管（传入三通数据）
    const topology = analyzePipelineTopology(pipelines, validFlowArrows, welds, tees);
    const mainPipes = topology.mainPipes;
    const branchPipes = topology.branchPipes;
    
    // 统计合并后的管道根数（非管道段数）
    const mainPipeCount = topology.mainPipe ? 1 : 0;
    const branchPipeCount = topology.mergedBranchPipes ? topology.mergedBranchPipes.length : 0;
    console.log(`   📊 拓扑分析: 主管 ${mainPipeCount} 根 (${mainPipes.length} 段), 支管 ${branchPipeCount} 根 (${branchPipes.length} 段)`);
    
    // 获取所有管道的线段索引（需要区分主管和支管）
    const mainPipeIds = new Set(mainPipes.map(p => p.pathId));
    const branchPipeIds = new Set(branchPipes.map(p => p.pathId));
    
    // 提取管道的线段信息用于绘制（区分主管和支管）
    const mainSegments = [];
    const branchSegments = [];
    const teeMainSegments = []; // 🌟 三通中的主管段
    const teeBranchSegments = []; // 🌟 三通中的支管段
    
    vectors.forEach((vec, index) => {
      if (!Array.isArray(vec) || vec.length < 8) return;
      const [type, x1, y1, x2, y2, color, width, pathId] = vec;
      const length = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
      
      const segment = {
        vectorIndex: index,
        type: getVectorSegmentType(type),
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        color,
        width,
        pathId,
        length
      };
      
      // 🌟 主管/支管分类优先于三通标记
      const pipe = pipelines.find(p => p.pathId === pathId);
      const isTeePart = pipe && pipe.isTeePart;
      
      if (mainPipeIds.has(pathId)) {
        // 主管（可能是三通的一部分）
        if (isTeePart) {
          teeMainSegments.push(segment);
        } else {
          mainSegments.push(segment);
        }
      } else if (branchPipeIds.has(pathId)) {
        // 支管（可能是三通的一部分）
        if (isTeePart) {
          teeBranchSegments.push(segment);
        } else {
          branchSegments.push(segment);
        }
      }
    });
    
    // 提取流向箭头的线段信息用于绘制
    const flowArrowSegments = [];
    validFlowArrows.forEach(arrow => {
        arrow.segments.forEach(seg => {
            flowArrowSegments.push({
                ...seg,
                start: {x: seg.x1, y: seg.y1},
                end: {x: seg.x2, y: seg.y2},
                length: Math.sqrt(Math.pow(seg.x2 - seg.x1, 2) + Math.pow(seg.y2 - seg.y1, 2))
            });
        });
    });
    
    console.log(`✅ 最终识别到 ${pipelines.length} 根管道，${validFlowArrows.length} 个流向箭头，${tees.length} 个三通`);
    
    // 🔴 检测非共用的宽边（短边）
    console.log('🔍 开始检测非共用的宽边（短边）...');
    const allWidthEdges = [];  // 只收集宽边
    
    // 收集所有管道的宽边（标记主管/支管类型）
    // 注意：mainPipeIds 和 branchPipeIds 已在前面定义
    pipelines.forEach(pipeline => {
      // 🔧 跳过三通部分的管道段（三通内部的端点不应被识别为管道端点）
      if (pipeline.isTeePart) {
        return;
      }
      
      const edges = getPipelineEdges(pipeline, vectors);
      const pipeType = mainPipeIds.has(pipeline.pathId) ? 'main' : 
                       branchPipeIds.has(pipeline.pathId) ? 'branch' : 
                       'unknown';
      
      edges.forEach(edge => {
        // 只收集宽边（短边）
        if (edge.isWidthEdge) {
          allWidthEdges.push({
            ...edge,
            pipelineId: pipeline.pathId,
            pipelineType: pipeType  // 🌟 标记管道类型
          });
        }
      });
    });
    
    console.log(`   📏 共收集到 ${allWidthEdges.length} 条宽边 (主管: ${allWidthEdges.filter(e => e.pipelineType === 'main').length}, 支管: ${allWidthEdges.filter(e => e.pipelineType === 'branch').length})`);
    
    // 标记每条宽边是否被共用
    const uniqueEdges = [];
    allWidthEdges.forEach((edge, index) => {
      let isShared = false;
      
      // 检查是否与其他管道的宽边共用
      for (let i = 0; i < allWidthEdges.length; i++) {
        if (i === index) continue;
        const otherEdge = allWidthEdges[i];
        
        // 只有不同管道的边才算共用
        if (otherEdge.pipelineId !== edge.pipelineId) {
          if (areEdgesShared(edge, otherEdge, 10)) {
            isShared = true;
            break;
          }
        }
      }
      
      // 记录非共用的宽边
      if (!isShared) {
        uniqueEdges.push(edge);
      }
    });
    
    console.log(`   🔴 初步识别到 ${uniqueEdges.length} 条非共用的宽边`);
    
    // 🔍 过滤掉相近的非共用宽边对（中间可能有阀门或流向箭头）
    // ⚠️ 重要：只过滤不同管道之间的相近宽边
    // ⭐ 改进：基于距离优先配对，而不是先到先得
    
    // 第一步：找出所有可能的配对及其距离
    const possiblePairs = [];
    for (let i = 0; i < uniqueEdges.length; i++) {
      for (let j = i + 1; j < uniqueEdges.length; j++) {
        const edge1 = uniqueEdges[i];
        const edge2 = uniqueEdges[j];
        
        // 只考虑不同管道之间的宽边
        if (edge1.pipelineId !== edge2.pipelineId) {
          const distance = getEdgeDistance(edge1, edge2);
          const isParallel = areEdgesParallel(edge1, edge2);
          
          // 相近且平行
          if (distance < 50 && isParallel) {
            possiblePairs.push({
              index1: i,
              index2: j,
              distance: distance,
              edge1: edge1,
              edge2: edge2
            });
          }
        }
      }
    }
    
    // 第二步：按距离排序，优先配对距离最近的
    possiblePairs.sort((a, b) => a.distance - b.distance);
    
    // 第三步：依次配对，确保每条边只被配对一次
    const pairedEdgeIds = new Set();
    possiblePairs.forEach(pair => {
      // 如果两条边都还没被配对
      if (!pairedEdgeIds.has(pair.index1) && !pairedEdgeIds.has(pair.index2)) {
        pairedEdgeIds.add(pair.index1);
        pairedEdgeIds.add(pair.index2);
        console.log(`   ⚠️ 过滤相近宽边对: 管道${pair.edge1.pipelineId} ↔ 管道${pair.edge2.pipelineId}, 距离=${pair.distance.toFixed(1)}px (可能有阀门/流向)`);
      }
    });
    
    // 第四步：保留未被配对的边
    const filteredUniqueEdges = [];
    uniqueEdges.forEach((edge, index) => {
      if (!pairedEdgeIds.has(index)) {
        filteredUniqueEdges.push(edge);
      }
    });
    
    console.log(`   ✅ 最终识别到 ${filteredUniqueEdges.length} 条真正的非共用宽边（已排除 ${pairedEdgeIds.size} 条配对边）`);
    
    // 🎯 第五步：标记管道端点（分主管和支管）
    console.log('🎯 识别管道端点...');
    
    // 分类处理主管和支管的端点
    const mainEndpoints = filteredUniqueEdges.filter(e => e.pipelineType === 'main');
    const branchEndpoints = filteredUniqueEdges.filter(e => e.pipelineType === 'branch');
    
    console.log(`   🔵 主管端点: ${mainEndpoints.length} 个${mainEndpoints.length > 0 ? ', pathId: [' + mainEndpoints.map(e => e.pipelineId).join(', ') + ']' : ''}`);
    console.log(`   🟠 支管端点: ${branchEndpoints.length} 个${branchEndpoints.length > 0 ? ', pathId: [' + branchEndpoints.map(e => e.pipelineId).join(', ') + ']' : ''}`);
    console.log(`   📊 总端点数: ${filteredUniqueEdges.length} 个`);
    console.log(`   💡 说明: 这是从所有${topology.mainPipePathIds?.size || 0}个主管段和${topology.branchPipePathIds?.size || 0}个支管段中检测到的端点`);
    
    // 📝 第六步：生成焊点编号序列
    console.log('📝 生成焊点编号序列...');
    const weldNumberingSequence = [];
    let currentNumber = 1;
    
    // 辅助函数：获取焊点坐标（兼容不同的焊点数据结构）
    const getWeldCoords = (weld) => {
      if (weld.center) {
        return { x: weld.center.x, y: weld.center.y };
      }
      if (weld.x !== undefined && weld.y !== undefined) {
        return { x: weld.x, y: weld.y };
      }
      if (weld.boundingBox) {
        return {
          x: weld.boundingBox.minX + weld.boundingBox.width / 2,
          y: weld.boundingBox.minY + weld.boundingBox.height / 2
        };
      }
      return { x: 0, y: 0 }; // 默认值
    };
    
    // 辅助函数：计算焊点到端点的距离
    const getDistanceToEndpoint = (weld, endpoint) => {
      const weldCoords = getWeldCoords(weld);
      const endpointCenter = {
        x: (endpoint.start.x + endpoint.end.x) / 2,
        y: (endpoint.start.y + endpoint.end.y) / 2
      };
      return Math.sqrt(
        Math.pow(weldCoords.x - endpointCenter.x, 2) + 
        Math.pow(weldCoords.y - endpointCenter.y, 2)
      );
    };
    
    // 辅助函数：判断焊点是否属于某个管道
    // 使用焊点已关联的管道ID进行判断
    const isWeldOnPipeline = (weld, pipeline) => {
      // 焊点在关联阶段已经设置了 relatedPipelineId 属性
      if (weld.relatedPipelineId && weld.relatedPipelineId === pipeline.pathId) {
        return true;
      }
      
      // 备选：检查 pipelineId 属性（某些情况下可能使用此属性）
      if (weld.pipelineId && weld.pipelineId === pipeline.pathId) {
        return true;
      }
      
      return false;
    };
    
    // 调试：检查焊点数据结构
    if (welds.length > 0) {
      const coords = getWeldCoords(welds[0]);
      console.log('   🔍 焊点数据检查 (第一个焊点):', {
        coords: coords,
        relatedPipelineId: welds[0].relatedPipelineId,
        pipelineId: welds[0].pipelineId,
        hasCenter: !!welds[0].center,
        hasBoundingBox: !!welds[0].boundingBox
      });
    }
    
    // 调试：检查管道数据结构
    if (mainPipes.length > 0) {
      console.log('   🔍 主管数据检查 (第一根):', {
        pathId: mainPipes[0].pathId,
        hasBounds: !!mainPipes[0].bounds,
        hasBbox: !!mainPipes[0].bbox
      });
    }
    
    // 🔧 关键：跟踪已编号的焊点ID，防止重复编号（与多页处理一致）
    const numberedWeldIds = new Set();
    
    // 辅助函数：获取焊点唯一标识
    const getWeldId = (weld) => weld.pathId || weld.id || `${weld.center?.x || 0}_${weld.center?.y || 0}`;
    
    // 辅助函数：计算点到线段的距离
    const getDistancePointToSegment = (p, v, w) => {
      const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
      if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
      let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
      t = Math.max(0, Math.min(1, t));
      const projX = v.x + t * (w.x - v.x);
      const projY = v.y + t * (w.y - v.y);
      return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
    };
    
    // 辅助函数：计算焊点到管道的最短距离
    const getDistanceToPipe = (weld, pipeSegments) => {
      const weldCoords = getWeldCoords(weld);
      let minDist = Infinity;
      
      pipeSegments.forEach(pipe => {
        if (!pipe.segments) return;
        pipe.segments.forEach(seg => {
          const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
          const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
          const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
          const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
          const dist = getDistancePointToSegment(weldCoords, { x: x1, y: y1 }, { x: x2, y: y2 });
          if (dist < minDist) minDist = dist;
        });
      });
      
      return minDist;
    };
    
    // 🔧 关键：重新分配焊点到距离最近的管道（解决三通交汇点焊点归属问题）
    // 焊点应该属于距离它最近的管道，而不是被多个管道同时收集
    const mergedMainPipe = topology.mainPipe;
    const mergedBranchPipes = topology.mergedBranchPipes || [];
    
    const reassignedMainWelds = [];
    const reassignedBranchWelds = {}; // {branchIndex: welds[]}
    
    // 🔧 使用所有主管段（包括未被合并的），而不仅仅是 mergedMainPipe.segments
    // 因为 mergedMainPipe 可能只包含从三通开始追踪的连通部分
    
    // 🔧 辅助函数：判断焊点是否在三通附近，以及它更靠近主管还是支管
    const getWeldTeeAffinity = (weld, tees, mainPipeIds, branchPipeIds) => {
      const weldCoords = getWeldCoords(weld);
      const TEE_INFLUENCE_RADIUS = 50; // 三通影响半径 50px
      
      for (const tee of tees) {
        const distToTee = Math.sqrt(
          Math.pow(weldCoords.x - tee.center.x, 2) +
          Math.pow(weldCoords.y - tee.center.y, 2)
        );
        
        if (distToTee < TEE_INFLUENCE_RADIUS) {
          // 焊点在三通影响范围内
          // 判断它更接近主管还是支管
          // 三通有3个parts: 2个主管段 + 1个支管段
          const mainParts = (tee.parts || []).filter(pathId => mainPipeIds.has(pathId));
          const branchParts = (tee.parts || []).filter(pathId => branchPipeIds.has(pathId));
          
          return {
            nearTee: true,
            teeCenter: tee.center,
            distToTee,
            mainParts,
            branchParts
          };
        }
      }
      
      return { nearTee: false };
    };
    
    if (mainPipes.length > 0 || mergedBranchPipes.length > 0) {
      console.log(`   🔧 重新分配焊点到最近的管道（考虑三通拓扑）...`);
      console.log(`      使用所有主管段: ${mainPipes.length} 个`);
      
      // 收集所有管道信息（使用所有主管段，而不仅仅是合并后的）
      const allPipes = [];
      
      // 添加所有主管段（每个主管段作为独立的管道）
      // 🔧 修复：保存完整的管道引用，用于更新焊点的 relatedPipeline
      mainPipes.forEach(pipe => {
        if (pipe.segments && pipe.segments.length > 0) {
          allPipes.push({ type: 'main', index: -1, pipeSegments: pipe.segments, pipeRef: pipe });
        }
      });
      
      // 添加所有支管段
      mergedBranchPipes.forEach((bp, idx) => {
        if (bp.segments) {
          // 收集支管的所有线段
          const branchSegments = [];
          // 🔧 修复：同时收集支管的管道引用列表
          const branchPipeRefs = [];
          bp.segments.forEach(seg => {
            if (seg.segments) {
              branchSegments.push(...seg.segments);
              branchPipeRefs.push(seg); // 保存支管段引用
            }
          });
          allPipes.push({ type: 'branch', index: idx, pipeSegments: branchSegments, branchPipeRefs });
          reassignedBranchWelds[idx] = [];
        }
      });
      
      console.log(`      收集到 ${allPipes.length} 个管道用于焊点分配`);
        
      // 辅助函数：计算焊点到线段数组的最短距离，并返回最近的线段所属管道
      const getDistanceToSegmentsWithPipe = (weld, segments, pipeRefs) => {
        const weldCoords = getWeldCoords(weld);
        let minDist = Infinity;
        let closestPipeRef = null;
        
        segments.forEach((seg, segIdx) => {
          const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
          const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
          const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
          const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
          const dist = getDistancePointToSegment(weldCoords, { x: x1, y: y1 }, { x: x2, y: y2 });
          if (dist < minDist) {
            minDist = dist;
            // 找到这个线段属于哪个管道引用
            if (pipeRefs && Array.isArray(pipeRefs)) {
              // 支管情况：需要从 branchPipeRefs 中找
              let totalSegs = 0;
              for (const ref of pipeRefs) {
                const refSegCount = ref.segments ? ref.segments.length : 0;
                if (segIdx < totalSegs + refSegCount) {
                  closestPipeRef = ref;
                  break;
                }
                totalSegs += refSegCount;
              }
            }
          }
        });
        
        return { dist: minDist, pipeRef: closestPipeRef };
      };
        
      // 🔧 第二阶段：直接使用第一阶段的关联关系，根据管道类型重新分类焊点
      // 不重新计算距离，避免丢失已关联的焊点
      welds.forEach(weld => {
        const weldPipelineId = weld.relatedPipelineId;
        if (!weldPipelineId) {
          console.warn(`      ⚠️ 焊点 ${getWeldId(weld)} 没有关联管道，跳过`);
          return;
        }
        
        // 根据管道ID判断是主管还是支管
        if (mainPipeIds.has(weldPipelineId)) {
          // 主管焊点
          reassignedMainWelds.push(weld);
        } else if (branchPipeIds.has(weldPipelineId)) {
          // 支管焊点 - 尝试找到对应的支管组，找不到则添加到第一个支管组
          let assignedToBranch = false;
          
          // 遍历所有支管组，检查是否包含该管道
          mergedBranchPipes.forEach((branch, idx) => {
            if (assignedToBranch) return; // 已分配，跳过
            
            // 提取支管组中所有管道的 pathId
            const branchPathIds = [];
            if (branch.segments) {
              branch.segments.forEach(seg => {
                if (seg.pathId) {
                  branchPathIds.push(seg.pathId);
                }
              });
            }
            
            if (branchPathIds.includes(weldPipelineId)) {
              reassignedBranchWelds[idx].push(weld);
              assignedToBranch = true;
            }
          });
          
          // 如果没有找到对应的支管组，但管道确实是支管，则添加到第一个支管组
          if (!assignedToBranch && mergedBranchPipes.length > 0) {
            reassignedBranchWelds[0].push(weld);
            // 减少日志噪音: 不再为每个焊点输出详细警告，因为后续有扩展遍历修复
            // console.log(`      ℹ️ 焊点 ${getWeldId(weld)} 的管道 ${weldPipelineId} 是支管但不在三通支管组中，已添加到支管1`);
          }
        } else {
          // console.warn(`      ⚠️ 焊点 ${getWeldId(weld)} 关联的管道 ${weldPipelineId} 不在主管或支管列表中`);
        }
      });
      
      console.log(`      ✅ 重新分配结果: 主管 ${reassignedMainWelds.length} 个焊点`);
      Object.keys(reassignedBranchWelds).forEach(idx => {
        const count = reassignedBranchWelds[idx].length;
        if (count > 0) {
          console.log(`         支管${parseInt(idx) + 1}: ${count} 个焊点`);
        }
      });
      
      // 检查是否所有焊点都被正确分配
      const totalAssigned = reassignedMainWelds.length + 
        Object.values(reassignedBranchWelds).reduce((sum, arr) => sum + arr.length, 0);
      if (totalAssigned < welds.length) {
        console.log(`      ⚠️ 有 ${welds.length - totalAssigned} 个焊点未被分配（可能关联的管道不在主管/支管列表中）`);
      } else if (totalAssigned === welds.length) {
        console.log(`      ✅ 所有 ${welds.length} 个焊点都已成功分配`);
      }
      
      // 📊 第二阶段：输出详细的重新分配信息和变化对比
      // console.log('\n   📊 【第二阶段】拓扑分析后的焊点重新分配详情:');
      // console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      // 主管焊点 (简化输出)
      // console.log(`   🔵 主管焊点 (${reassignedMainWelds.length} 个):`);
      // reassignedMainWelds.forEach((weld, index) => {
      //   const weldPathId = getWeldId(weld);
      //   const oldPipeId = weld.relatedPipelineId;
      //   const newPipeId = weld.relatedPipeline?.pathId || weld.relatedPipelineId;
      //   const changed = oldPipeId !== newPipeId;
      //   const changeTag = changed ? ` 🔄 (原: ${oldPipeId})` : '';
      //   console.log(`      ${index + 1}. 焊点Path:${weldPathId} → 主管Path:${newPipeId}${changeTag}`);
      // });
      
      // 支管焊点 (简化输出)
      // Object.keys(reassignedBranchWelds).forEach(idx => {
      //   const branchIndex = parseInt(idx);
      //   const branchWelds = reassignedBranchWelds[idx];
      //   console.log(`   🟠 支管${branchIndex + 1}焊点 (${branchWelds.length} 个):`);
      //   branchWelds.forEach((weld, index) => {
      //     const weldPathId = getWeldId(weld);
      //     const oldPipeId = weld.relatedPipelineId;
      //     const newPipeId = weld.relatedPipeline?.pathId || weld.relatedPipelineId;
      //     const changed = oldPipeId !== newPipeId;
      //     const changeTag = changed ? ` 🔄 (原: ${oldPipeId})` : '';
      //     console.log(`      ${index + 1}. 焊点Path:${weldPathId} → 支管Path:${newPipeId}${changeTag}`);
      //   });
      // });
      
      // console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }
    
    // 处理主管焊点编号（按管道段连续遍历）
    const mainWelds = reassignedMainWelds.length > 0 ? reassignedMainWelds : (mergedMainPipe?.welds || []);
    if (mainWelds.length > 0 && mainPipes.length > 0) {
      console.log('   🔵 处理主管焊点编号（按管道段连续遍历）...');
      
      // 🔧 使用所有主管段的pathIds，而不仅仅是mergedMainPipe的
      const mainPipePathIds = new Set(mainPipes.map(p => p.pathId));
      const pipeEndpoints = mainEndpoints.filter(e => mainPipePathIds.has(e.pipelineId));
      console.log(`      主管共 ${mainWelds.length} 个焊点, ${mainPipes.length} 个管道段, ${pipeEndpoints.length} 个端点`);
      
      // 辅助函数：计算焊点到线段数组的最短距离
      const getDistanceToSegments = (weld, segments) => {
        const weldCoords = getWeldCoords(weld);
        let minDist = Infinity;
        
        segments.forEach(seg => {
          const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
          const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
          const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
          const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
          const dist = getDistancePointToSegment(weldCoords, { x: x1, y: y1 }, { x: x2, y: y2 });
          if (dist < minDist) minDist = dist;
        });
        
        return minDist;
      };
      
      // 辅助函数：计算管道段的中心点
      const getPipeCenter = (pipe) => {
        if (!pipe.segments || pipe.segments.length === 0) return { x: 0, y: 0 };
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
      };
      
      // 辅助函数：获取管道段的所有端点
      const getPipeEndpoints = (pipe) => {
        if (!pipe.segments || pipe.segments.length === 0) return [];
        
        const allPoints = [];
        pipe.segments.forEach(seg => {
          const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
          const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
          const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
          const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
          allPoints.push({ x: x1, y: y1 }, { x: x2, y: y2 });
        });
        
        return allPoints;
      };
      
      // 辅助函数：计算点到管道段最近端点的距离
      const getDistanceToNearestEndpoint = (point, pipe) => {
        const endpoints = getPipeEndpoints(pipe);
        if (endpoints.length === 0) return Infinity;
        
        let minDist = Infinity;
        endpoints.forEach(ep => {
          const dist = Math.sqrt(Math.pow(ep.x - point.x, 2) + Math.pow(ep.y - point.y, 2));
          if (dist < minDist) minDist = dist;
        });
        
        return minDist;
      };
      
      // 辅助函数：计算管道段的尾端点
      const getPipeTailEnd = (pipe, fromPoint) => {
        if (!pipe.segments || pipe.segments.length === 0) return { x: 0, y: 0 };
        
        const allPoints = [];
        pipe.segments.forEach(seg => {
          const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
          const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
          const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
          const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
          allPoints.push({ x: x1, y: y1 }, { x: x2, y: y2 });
        });
        
        let maxDist = 0;
        let tailEnd = allPoints[0];
        allPoints.forEach(p => {
          const dist = Math.sqrt(Math.pow(p.x - fromPoint.x, 2) + Math.pow(p.y - fromPoint.y, 2));
          if (dist > maxDist) {
            maxDist = dist;
            tailEnd = p;
          }
        });
        
        return tailEnd;
      };
      
      // 辅助函数：获取管道段上的焊点
      const getWeldsOnPipe = (pipe) => {
        // 🔧 直接使用第一阶段的关联关系，不重新计算距离
        return mainWelds.filter(weld => {
          return weld.relatedPipelineId === pipe.pathId;
        });
      };
      
      // 1. 确定起始管道段（优先选择有焊点的管道段）
      let startPipe = null;
      let startPoint = null;
      
      if (pipeEndpoints.length > 0) {
        const endpoint = pipeEndpoints[0];
        startPoint = {
          x: (endpoint.start.x + endpoint.end.x) / 2,
          y: (endpoint.start.y + endpoint.end.y) / 2
        };
        console.log(`      ✅ 起始端点: (${startPoint.x.toFixed(1)}, ${startPoint.y.toFixed(1)})`);
        
        // 🌟 优先找有焊点的管道段
        const pipesWithWelds = mainPipes.map(pipe => ({
          pipe,
          welds: getWeldsOnPipe(pipe),
          distToEndpoint: Math.sqrt(
            Math.pow(getPipeCenter(pipe).x - startPoint.x, 2) + 
            Math.pow(getPipeCenter(pipe).y - startPoint.y, 2)
          )
        }));
        
        // 先找有焊点的管道段
        const pipesWithWeldsOnly = pipesWithWelds.filter(p => p.welds.length > 0);
        
        if (pipesWithWeldsOnly.length > 0) {
          // 从有焊点的管道段中选择离端点最近的
          const sorted = pipesWithWeldsOnly.sort((a, b) => a.distToEndpoint - b.distToEndpoint);
          startPipe = sorted[0].pipe;
          console.log(`      ✅ 起始管道段（有焊点）: pathId=${startPipe.pathId}, 距端点 ${sorted[0].distToEndpoint.toFixed(1)}px, ${sorted[0].welds.length} 个焊点`);
        } else {
          // 如果所有管道段都没有焊点，选择离端点最近的
          const sorted = pipesWithWelds.sort((a, b) => a.distToEndpoint - b.distToEndpoint);
          startPipe = sorted[0].pipe;
          console.log(`      ⚠️ 起始管道段（无焊点）: pathId=${startPipe.pathId}, 距端点 ${sorted[0].distToEndpoint.toFixed(1)}px`);
        }
      } else {
        console.log(`      ⚠️ 无端点，使用备选策略：选择最左上的有焊点管道段`);
        
        // 🌟 优先选择有焊点的管道段
        const pipesWithWelds = mainPipes.filter(pipe => getWeldsOnPipe(pipe).length > 0);
        
        if (pipesWithWelds.length > 0) {
          // 计算每个管道段的位置评分
          const pipeScores = pipesWithWelds.map(pipe => {
            const center = getPipeCenter(pipe);
            const score = center.x + center.y;
            return {
              pathId: pipe.pathId,
              center,
              score,
              welds: getWeldsOnPipe(pipe).length
            };
          }).sort((a, b) => a.score - b.score);
          
          console.log(`      📊 候选管道段（按左上位置排序，前${Math.min(3, pipeScores.length)}个）:`);
          pipeScores.slice(0, 3).forEach((p, i) => {
            console.log(`         ${i+1}. pathId=${p.pathId}, 中心(${p.center.x.toFixed(1)}, ${p.center.y.toFixed(1)}), 评分=${p.score.toFixed(1)}, ${p.welds}个焊点${i===0 ? ' ✅选中' : ''}`);
          });
          
          startPipe = pipesWithWelds.reduce((best, pipe) => {
            const centerA = getPipeCenter(pipe);
            const centerB = getPipeCenter(best);
            return (centerA.x + centerA.y) < (centerB.x + centerB.y) ? pipe : best;
          });
        } else {
          startPipe = mainPipes.reduce((best, pipe) => {
            const centerA = getPipeCenter(pipe);
            const centerB = getPipeCenter(best);
            return (centerA.x + centerA.y) < (centerB.x + centerB.y) ? pipe : best;
          });
          console.log(`      ⚠️ 无焊点管道段，选择最左上的: pathId=${startPipe.pathId}`);
        }
        startPoint = getPipeCenter(startPipe);
      }
      
      // 2. 按管道段连续遍历编号
      const visitedPipes = new Set();
      let currentPipe = startPipe;
      let currentTailEnd = startPoint;
      let sortedWelds = [];
      
      console.log(`      🔄 开始沿管道段遍历...`);
      
      const mainTraversalOrder = []; // 记录主管遍历顺序
      while (currentPipe && visitedPipes.size < mainPipes.length) {
        visitedPipes.add(currentPipe.pathId);
        mainTraversalOrder.push({
          pathId: currentPipe.pathId,
          traversalOrder: visitedPipes.size
        });
        
        const pipeWelds = getWeldsOnPipe(currentPipe);
        
        if (pipeWelds.length > 0) {
          const sortedPipeWelds = pipeWelds.map(weld => ({
            ...weld,
            distToTail: Math.sqrt(
              Math.pow(getWeldCoords(weld).x - currentTailEnd.x, 2) +
              Math.pow(getWeldCoords(weld).y - currentTailEnd.y, 2)
            )
          })).sort((a, b) => a.distToTail - b.distToTail);
          
          sortedWelds.push(...sortedPipeWelds);
          console.log(`         遍历顺序${visitedPipes.size}: pathId=${currentPipe.pathId}, ${pipeWelds.length}个焊点`);
        } else {
          console.log(`         遍历顺序${visitedPipes.size}: pathId=${currentPipe.pathId}, 无焊点`);
        }
        
        currentTailEnd = getPipeTailEnd(currentPipe, currentTailEnd);
        
        let nextPipe = null;
        let minDist = Infinity;
        
        mainPipes.forEach(pipe => {
          if (visitedPipes.has(pipe.pathId)) return;
          
          // 计算当前尾端到候选管道段最近端点的距离
          const dist = getDistanceToNearestEndpoint(currentTailEnd, pipe);
          
          if (dist < minDist) {
            minDist = dist;
            nextPipe = pipe;
          }
        });
        
        if (nextPipe) {
          console.log(`         → 下一段: pathId=${nextPipe.pathId}, 距离 ${minDist.toFixed(1)}px`);
        }
        
        currentPipe = nextPipe;
      }
      
      console.log(`      ✅ 遍历完成，共访问 ${visitedPipes.size} 个管道段`);
      console.log(`      📋 主管遍历映射: ${mainTraversalOrder.map(t => `pathId${t.pathId}→遍历${t.traversalOrder}`).join(', ')}`);
      console.log(`      主管焊点排序（前${Math.min(3, sortedWelds.length)}个）:`);
      sortedWelds.slice(0, 3).forEach((weld, i) => {
        const coords = getWeldCoords(weld);
        console.log(`         ${i + 1}. 焊点(${coords.x.toFixed(1)}, ${coords.y.toFixed(1)}) → 编号${currentNumber + i}`);
      });
      
      // 为焊点编号
      sortedWelds.forEach((weld) => {
        const weldId = getWeldId(weld);
        
        if (numberedWeldIds.has(weldId)) {
          console.log(`      ⚠️ 焊点 ${weldId} 已被编号，跳过`);
          return;
        }
        
        weldNumberingSequence.push({
          weld,
          number: currentNumber++,
          pipelineType: 'main',
          pipelineId: mergedMainPipe.id,
          pipelineIndex: 0
        });
        
        numberedWeldIds.add(weldId);
      });
      
      console.log(`      ✅ 主管 ${sortedWelds.length} 个焊点已编号 (${currentNumber - sortedWelds.length} ~ ${currentNumber - 1})`);
    }
    
    // 处理支管焊点编号（使用重新分配后的支管焊点列表）
    if (mergedBranchPipes.length > 0 && welds.length > 0) {
      console.log('   🟠 处理支管焊点编号（使用重新分配后的焊点）...');
      
      mergedBranchPipes.forEach((branchPipe, pipeIndex) => {
        // 🔧 使用该支管实际包含的所有管道段ID（pathIds + segments.pathId）
        console.log(`      支管${pipeIndex + 1}: 📊 pathId追加顺序详情:`);
        
        // 步骤1：从 branchPipe.pathIds 初始化
        const branchPipePathIds = new Set(branchPipe.pathIds || []);
        const step1PathIds = Array.from(branchPipePathIds);
        console.log(`         步骤1 [branchPipe.pathIds]: ${step1PathIds.length > 0 ? JSON.stringify(step1PathIds) : '空'}`);
        
        // 步骤2：从 branchPipe.segments 补充
        const step2Added = [];
        (branchPipe.segments || []).forEach(seg => {
          if (seg?.pathId !== undefined && seg?.pathId !== null) {
            const sizeBefore = branchPipePathIds.size;
            branchPipePathIds.add(seg.pathId);
            if (branchPipePathIds.size > sizeBefore) {
              step2Added.push(seg.pathId);
            }
          }
        });
        console.log(`         步骤2 [segments补充]: ${step2Added.length > 0 ? '新增 ' + JSON.stringify(step2Added) : '无新增'}`);
        
        const teeCenter = branchPipe.teeCenter; // 三通中心位置
        
        // 🔧 使用重新分配的焊点列表，如果没有则使用原始列表
        const allPipeWelds = (reassignedBranchWelds[pipeIndex] && reassignedBranchWelds[pipeIndex].length > 0)
          ? reassignedBranchWelds[pipeIndex]
          : (branchPipe.welds || []);
        
        // 🔧 过滤掉已在主管中编号的焊点
        const pipeWelds = allPipeWelds.filter(weld => {
          const weldId = getWeldId(weld);
          return !numberedWeldIds.has(weldId);
        });
        
        const skippedCount = allPipeWelds.length - pipeWelds.length;
        if (skippedCount > 0) {
          console.log(`      支管${pipeIndex + 1}: ⚠️ 跳过 ${skippedCount} 个已编号的焊点`);
        }
        console.log(`      支管${pipeIndex + 1}: ${pipeWelds.length} 个待编号焊点`);
        
        if (pipeWelds.length === 0) {
          console.log(`      支管${pipeIndex + 1}: ❌ 无待编号焊点，跳过`);
          return;
        }

        // 🔧 关键修复：将该支管焊点关联到的 pathId 也纳入支管段集合
        // 避免 branchPipe.segments 仅保留“代表段”导致遍历段数偏少
        const branchPipeById = new Map((branchPipes || []).map(p => [p.pathId, p]));
        const weldRelatedPathIds = new Set();
        pipeWelds.forEach(weld => {
          const pid = weld.relatedPipelineId;
          if (pid !== undefined && pid !== null && branchPipeById.has(pid)) {
            weldRelatedPathIds.add(pid);
          }
        });
        // 步骤3：追加焊点关联的pathId
        const step3Added = [];
        weldRelatedPathIds.forEach(pid => {
          const sizeBeforeAdd = branchPipePathIds.size;
          branchPipePathIds.add(pid);
          if (branchPipePathIds.size > sizeBeforeAdd) {
            step3Added.push(pid);
          }
        });
        console.log(`         步骤3 [焊点关联pathId]: ${step3Added.length > 0 ? '新增 ' + JSON.stringify(step3Added) : '无新增'}`);
        console.log(`         🎯 最终pathId集合 (${branchPipePathIds.size}个): ${JSON.stringify(Array.from(branchPipePathIds))}`);
        console.log(`         💡 说明: pathId在集合中的位置 ≠ 实际遍历顺序，遍历顺序由端点距离动态决定`);
        
        // 获取该支管的端点（基于扩展后的 pathId 集合）
        let pipeEndpoints = branchEndpoints.filter(e => branchPipePathIds.has(e.pipelineId));
        console.log(`      支管${pipeIndex + 1}: 有 ${pipeEndpoints.length} 个端点`);
        
        // 🔧 修复：如果当前支管没有匹配到端点，尝试使用全局支管端点
        if (pipeEndpoints.length === 0 && branchEndpoints.length > 0) {
          console.log(`         ⚠️ 未检测到端点原因: 支管端点的pipelineId不在该支管的pathId集合中`);
          console.log(`         📊 全局支管端点: ${branchEndpoints.length}个, pathId分别为: ${branchEndpoints.map(e => e.pipelineId).join(', ')}`);
          console.log(`         📊 当前支管pathId集合: ${Array.from(branchPipePathIds).join(', ')}`);
          console.log(`         💡 尝试使用全局端点: 找到距离当前支管最近的端点`);
          
          // 计算当前支管的中心（所有管道段的平均中心）
          const branchPipeSegmentsForCenter = Array.from(branchPipePathIds)
            .map(pathId => branchPipeById.get(pathId))
            .filter(seg => !!seg);
          
          if (branchPipeSegmentsForCenter.length > 0) {
            let totalX = 0, totalY = 0, totalCount = 0;
            branchPipeSegmentsForCenter.forEach(pipeSeg => {
              const segs = pipeSeg.segments || [];
              segs.forEach(seg => {
                const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
                const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
                const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
                const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
                totalX += (x1 + x2) / 2;
                totalY += (y1 + y2) / 2;
                totalCount++;
              });
            });
            
            const branchCenter = { x: totalX / totalCount, y: totalY / totalCount };
            
            // 找到距离支管中心最近的全局端点
            const endpointsWithDist = branchEndpoints.map(ep => {
              const epCenter = {
                x: (ep.start.x + ep.end.x) / 2,
                y: (ep.start.y + ep.end.y) / 2
              };
              const dist = Math.sqrt(
                Math.pow(epCenter.x - branchCenter.x, 2) + 
                Math.pow(epCenter.y - branchCenter.y, 2)
              );
              return { ...ep, dist, center: epCenter };
            }).sort((a, b) => a.dist - b.dist);
            
            if (endpointsWithDist.length > 0) {
              const nearestEndpoint = endpointsWithDist[0];
              pipeEndpoints = [nearestEndpoint];
              console.log(`         ✅ 使用全局端点: pathId=${nearestEndpoint.pipelineId}, 距支管中心${nearestEndpoint.dist.toFixed(1)}px`);
              console.log(`         🔧 将端点管道段加入pathId集合，以支持端点策略`);
              
              // 将端点所在的管道段也加入pathId集合（如果在支管列表中）
              if (branchPipeById.has(nearestEndpoint.pipelineId)) {
                branchPipePathIds.add(nearestEndpoint.pipelineId);
                console.log(`         ✅ 已添加端点管道段 ${nearestEndpoint.pipelineId} 到pathId集合`);
              }
            }
          }
        }
        
        // 🔧 关键：如果有多个端点且有三通信息，选择远离三通的端点
        // 这样编号从支管外端开始，与多页处理一致
        if (pipeEndpoints.length > 1 && teeCenter) {
          pipeEndpoints = pipeEndpoints.map(ep => {
            const epCenter = {
              x: (ep.start.x + ep.end.x) / 2,
              y: (ep.start.y + ep.end.y) / 2
            };
            const distToTee = Math.sqrt(
              Math.pow(epCenter.x - teeCenter.x, 2) + 
              Math.pow(epCenter.y - teeCenter.y, 2)
            );
            return { ...ep, distToTee };
          }).sort((a, b) => b.distToTee - a.distToTee); // 远离三通的优先
          
          console.log(`      支管${pipeIndex + 1}: 🔧 选择远离三通的端点（距离三通 ${pipeEndpoints[0].distToTee.toFixed(1)}px）`);
        }
        
        // 焊点排序逻辑（按管道段连续遍历）
        let branchPipeSegments = Array.from(branchPipePathIds)
          .map(pathId => branchPipeById.get(pathId))
          .filter(seg => !!seg);
        
        // 兼容旧数据：若映射不到有效段，则退回原始分组
        if (branchPipeSegments.length === 0) {
          branchPipeSegments = branchPipe.segments || [];
        }
        
        const originalSegmentCount = (branchPipe.segments || []).length;
        const finalSegmentCount = branchPipeSegments.length;
        if (finalSegmentCount !== originalSegmentCount) {
          console.log(`      支管${pipeIndex + 1}: 🔧 扩展遍历段数 ${originalSegmentCount} -> ${finalSegmentCount}${pipeEndpoints.length > 0 ? ' (含端点管道段)' : ''}`);
        }
        const branchSegmentPathIds = branchPipeSegments.map(seg => seg?.pathId).filter(id => id !== undefined && id !== null);
        if (branchSegmentPathIds.length > 0) {
          console.log(`      支管${pipeIndex + 1}: 段PathIDs = [${branchSegmentPathIds.join(', ')}]`);
        }
        let sortedWelds = [];
        
        if (branchPipeSegments.length > 0) {
          console.log(`      支管${pipeIndex + 1}: 按管道段连续遍历 (${branchPipeSegments.length} 段)`);
          
          // 辅助函数：获取支管段上的焊点
          const getWeldsOnBranchPipe = (pipeSegment) => {
            // 🔧 直接使用第一阶段的关联关系，不重新计算距离
            return pipeWelds.filter(weld => {
              return weld.relatedPipelineId === pipeSegment.pathId;
            });
          };
          
          // 辅助函数：获取支管段中心
          const getBranchPipeCenter = (pipeSegment) => {
            const segs = pipeSegment.segments || [];
            if (segs.length === 0) return { x: 0, y: 0 };
            
            let sumX = 0, sumY = 0, count = 0;
            segs.forEach(seg => {
              const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
              const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
              const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
              const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
              sumX += (x1 + x2) / 2;
              sumY += (y1 + y2) / 2;
              count++;
            });
            return { x: sumX / count, y: sumY / count };
          };
          
          // 辅助函数：计算支管段的尾端
          const getBranchPipeTailEnd = (pipeSegment, fromPoint) => {
            const segs = pipeSegment.segments || [];
            if (segs.length === 0) return { x: 0, y: 0 };
            
            const allPoints = [];
            segs.forEach(seg => {
              const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
              const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
              const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
              const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
              allPoints.push({ x: x1, y: y1 }, { x: x2, y: y2 });
            });
            
            let maxDist = 0;
            let tailEnd = allPoints[0];
            allPoints.forEach(p => {
              const dist = Math.sqrt(Math.pow(p.x - fromPoint.x, 2) + Math.pow(p.y - fromPoint.y, 2));
              if (dist > maxDist) {
                maxDist = dist;
                tailEnd = p;
              }
            });
            
            return tailEnd;
          };
          
          // 辅助函数：获取支管段的所有端点
          const getBranchPipeEndpoints = (pipeSegment) => {
            const segs = pipeSegment.segments || [];
            if (segs.length === 0) return [];
            
            const allPoints = [];
            segs.forEach(seg => {
              const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
              const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
              const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
              const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
              allPoints.push({ x: x1, y: y1 }, { x: x2, y: y2 });
            });
            
            return allPoints;
          };
          
          // 辅助函数：计算点到支管段最近端点的距离
          const getDistanceToBranchNearestEndpoint = (point, pipeSegment) => {
            const endpoints = getBranchPipeEndpoints(pipeSegment);
            if (endpoints.length === 0) return Infinity;
            
            let minDist = Infinity;
            endpoints.forEach(ep => {
              const dist = Math.sqrt(Math.pow(ep.x - point.x, 2) + Math.pow(ep.y - point.y, 2));
              if (dist < minDist) minDist = dist;
            });
            
            return minDist;
          };
          
          // 1. 确定起始管道段（优先选择有焊点的管道段）
          let startPipeSegment = null;
          let startPoint = null;
          
          if (pipeEndpoints.length > 0) {
            const endpoint = pipeEndpoints[0];
            startPoint = {
              x: (endpoint.start.x + endpoint.end.x) / 2,
              y: (endpoint.start.y + endpoint.end.y) / 2
            };
            console.log(`         ✅ 使用端点策略: 从端点(${startPoint.x.toFixed(1)}, ${startPoint.y.toFixed(1)})附近开始遍历`);
            
            // 🌟 优先找有焊点的支管段
            const segsWithWelds = branchPipeSegments.map(pipeSeg => ({
              pipeSeg,
              welds: getWeldsOnBranchPipe(pipeSeg),
              distToEndpoint: Math.sqrt(
                Math.pow(getBranchPipeCenter(pipeSeg).x - startPoint.x, 2) + 
                Math.pow(getBranchPipeCenter(pipeSeg).y - startPoint.y, 2)
              )
            }));
            
            // 先找有焊点的支管段
            const segsWithWeldsOnly = segsWithWelds.filter(s => s.welds.length > 0);
            
            if (segsWithWeldsOnly.length > 0) {
              const sorted = segsWithWeldsOnly.sort((a, b) => a.distToEndpoint - b.distToEndpoint);
              startPipeSegment = sorted[0].pipeSeg;
              console.log(`         起始段: pathId=${startPipeSegment.pathId}, 距端点${sorted[0].distToEndpoint.toFixed(1)}px, ${sorted[0].welds.length}个焊点`);
            } else {
              const sorted = segsWithWelds.sort((a, b) => a.distToEndpoint - b.distToEndpoint);
              startPipeSegment = sorted[0].pipeSeg;
              console.log(`         起始段: pathId=${startPipeSegment.pathId}, 距端点${sorted[0].distToEndpoint.toFixed(1)}px, 无焊点`);
            }
          } else {
            // 🌟 无端点时，优先选择有焊点的最左上管道段
            console.log(`         ⚠️ 无端点，使用备选策略：选择最左上的有焊点管道段`);
            const segsWithWelds = branchPipeSegments.filter(pipeSeg => getWeldsOnBranchPipe(pipeSeg).length > 0);
            
            if (segsWithWelds.length > 0) {
              // 计算每个管道段的位置评分
              const segScores = segsWithWelds.map(pipeSeg => {
                const center = getBranchPipeCenter(pipeSeg);
                const score = center.x + center.y; // 越小越"左上"
                return {
                  pathId: pipeSeg.pathId,
                  center,
                  score,
                  welds: getWeldsOnBranchPipe(pipeSeg).length
                };
              }).sort((a, b) => a.score - b.score);
              
              // 显示前3个候选
              console.log(`         📊 候选管道段（按左上位置排序，前${Math.min(3, segScores.length)}个）:`);
              segScores.slice(0, 3).forEach((seg, i) => {
                console.log(`            ${i+1}. pathId=${seg.pathId}, 中心(${seg.center.x.toFixed(1)}, ${seg.center.y.toFixed(1)}), 评分=${seg.score.toFixed(1)}, ${seg.welds}个焊点${i===0 ? ' ✅选中' : ''}`);
              });
              
              startPipeSegment = segsWithWelds.reduce((best, pipeSeg) => {
                const centerA = getBranchPipeCenter(pipeSeg);
                const centerB = getBranchPipeCenter(best);
                return (centerA.x + centerA.y) < (centerB.x + centerB.y) ? pipeSeg : best;
              });
            } else {
              startPipeSegment = branchPipeSegments.reduce((best, pipeSeg) => {
                const centerA = getBranchPipeCenter(pipeSeg);
                const centerB = getBranchPipeCenter(best);
                return (centerA.x + centerA.y) < (centerB.x + centerB.y) ? pipeSeg : best;
              });
              console.log(`         ⚠️ 无焊点管道段，选择最左上的: pathId=${startPipeSegment.pathId}`);
            }
            startPoint = getBranchPipeCenter(startPipeSegment);
          }
          
          // 2. 按管道段连续遍历
          const visitedSegments = new Set();
          let currentSegment = startPipeSegment;
          let currentTailEnd = startPoint;
          const traversalOrder = []; // 记录遍历顺序
          
          while (currentSegment && visitedSegments.size < branchPipeSegments.length) {
            const segId = branchPipeSegments.indexOf(currentSegment);
            visitedSegments.add(segId);
            traversalOrder.push({
              pathId: currentSegment.pathId,
              arrayIndex: segId + 1,
              traversalOrder: visitedSegments.size
            });
            
            const segWelds = getWeldsOnBranchPipe(currentSegment);
            
            if (segWelds.length > 0) {
              const sortedSegWelds = segWelds.map(weld => ({
                ...weld,
                distToTail: Math.sqrt(
                  Math.pow(getWeldCoords(weld).x - currentTailEnd.x, 2) +
                  Math.pow(getWeldCoords(weld).y - currentTailEnd.y, 2)
                )
              })).sort((a, b) => a.distToTail - b.distToTail);
              
              sortedWelds.push(...sortedSegWelds);
              console.log(`         遍历顺序${visitedSegments.size}: pathId=${currentSegment.pathId} (数组位置${segId + 1}), ${segWelds.length}个焊点`);
            } else {
              console.log(`         遍历顺序${visitedSegments.size}: pathId=${currentSegment.pathId} (数组位置${segId + 1}), 无焊点`);
            }
            
            currentTailEnd = getBranchPipeTailEnd(currentSegment, currentTailEnd);
            
            let nextSegment = null;
            let minDist = Infinity;
            
            branchPipeSegments.forEach((pipeSeg, idx) => {
              if (visitedSegments.has(idx)) return;
              
              // 计算当前尾端到候选管道段最近端点的距离
              const dist = getDistanceToBranchNearestEndpoint(currentTailEnd, pipeSeg);
              
              if (dist < minDist) {
                minDist = dist;
                nextSegment = pipeSeg;
              }
            });
            
            currentSegment = nextSegment;
          }
          
          console.log(`         ✅ 遍历完成，访问 ${visitedSegments.size} 段`);
          console.log(`         📋 遍历映射: ${traversalOrder.map(t => `pathId${t.pathId}→遍历${t.traversalOrder}`).join(', ')}`);

          // 🔧 补偿：如果支管分组中的焊点未被上述段遍历覆盖，统一补入排序列表
          // 原因：branchPipe.segments 可能只是代表段，无法覆盖该支管上的全部 pathId
          const sortedWeldIdSet = new Set(sortedWelds.map(w => getWeldId(w)));
          const remainingWelds = pipeWelds.filter(w => !sortedWeldIdSet.has(getWeldId(w)));
          if (remainingWelds.length > 0) {
            const basePoint = startPoint || getWeldCoords(remainingWelds[0]);
            const appendSorted = remainingWelds.map(weld => ({
              ...weld,
              distanceToBase: Math.sqrt(
                Math.pow(getWeldCoords(weld).x - basePoint.x, 2) +
                Math.pow(getWeldCoords(weld).y - basePoint.y, 2)
              )
            })).sort((a, b) => a.distanceToBase - b.distanceToBase);

            sortedWelds.push(...appendSorted);
            console.log(`         ⚠️ 补偿追加 ${remainingWelds.length} 个未命中焊点`);
          }
        } else {
          // 无管道段信息：使用简单排序
          console.log(`      支管${pipeIndex + 1}: ⚠️ 无管道段信息，使用简单排序`);
          
          if (pipeEndpoints.length > 0) {
            const startEndpoint = pipeEndpoints[0];
            sortedWelds = pipeWelds.map(weld => ({
              ...weld,
              distanceToStart: getDistanceToEndpoint(weld, startEndpoint)
            })).sort((a, b) => a.distanceToStart - b.distanceToStart);
          } else {
            sortedWelds = pipeWelds.map(weld => {
              const coords = getWeldCoords(weld);
              return {
                ...weld,
                distanceToStart: coords.x + coords.y
              };
            }).sort((a, b) => a.distanceToStart - b.distanceToStart);
          }
        }
        
        // 打印焊点排序信息
        if (sortedWelds.length > 0) {
          console.log(`      支管${pipeIndex + 1}: 焊点排序（前${Math.min(3, sortedWelds.length)}个）:`);
          sortedWelds.slice(0, 3).forEach((weld, i) => {
            const coords = getWeldCoords(weld);
            console.log(`         ${i + 1}. 焊点(${coords.x.toFixed(1)}, ${coords.y.toFixed(1)}) → 编号${currentNumber + i}`);
          });
        }
        
        // 为焊点编号
        let numberedCount = 0;
        sortedWelds.forEach(weld => {
          const weldId = getWeldId(weld);
          
          // 🔧 双重保险：跳过已编号的焊点
          if (numberedWeldIds.has(weldId)) {
            return;
          }
          
          weldNumberingSequence.push({
            weld,
            number: currentNumber++,
            pipelineType: 'branch',
            pipelineId: branchPipe.id,
            pipelineIndex: pipeIndex
          });
          
          // 🔧 标记为已编号
          numberedWeldIds.add(weldId);
          numberedCount++;
        });
        
        console.log(`      支管${pipeIndex + 1}: ✅ ${numberedCount} 个焊点已编号 (${currentNumber - numberedCount} ~ ${currentNumber - 1})`);
      });
    }
    
    console.log(`   ✅ 编号完成: 共 ${weldNumberingSequence.length} 个焊点 (主管优先)`);
    console.log(`   📝 架构说明:`);
    console.log(`      - 端点检测: 基于所有${mainPipes.length}个主管段和${branchPipes.length}个支管段`);
    console.log(`      - 焊点编号: 基于${mergedMainPipe ? 1 : 0}个主管分组和${mergedBranchPipes.length}个支管分组`);
    console.log(`      - ⚠️ 端点可能属于未被包含在分组中的管道段`);
    
    // 🌐 将编号序列暴露到全局
    if (typeof window !== 'undefined') {
      window.__pipelineWeldNumberingSequence__ = weldNumberingSequence;
      console.log('   🌐 焊点编号序列已暴露到全局: window.__pipelineWeldNumberingSequence__');
    }
    
    return { 
      pipelines, 
      mainSegments, 
      branchSegments,
      teeMainSegments,   // 🌟 三通中的主管段
      teeBranchSegments, // 🌟 三通中的支管段
      tees,              // 🌟 三通信息
      flowArrows: validFlowArrows, 
      flowArrowSegments,
      mainPipes,
      branchPipes,
      topology,
      welds,  // 传递焊点数据供统计面板使用
      uniqueEdges: filteredUniqueEdges,  // 🔴 非共用宽边（已过滤相近边对）
      // 管道端点（按类型分类）
      mainEndpoints,   // 🔵 主管端点
      branchEndpoints, // 🟠 支管端点
      // 焊点编号序列
      weldNumberingSequence  // 📝 焊点编号序列（主管优先）
    };
  }, [vectors, visible]);

  const renderStats = useMemo(() => {
    if (!visible || !vectors || vectors.length === 0) {
      return EMPTY_RENDER_STATS;
    }

    const mainSegments = pipelineData.mainSegments || [];
    const branchSegments = pipelineData.branchSegments || [];
    const teeMainSegments = pipelineData.teeMainSegments || [];
    const teeBranchSegments = pipelineData.teeBranchSegments || [];
    const allSegments = [
      ...mainSegments,
      ...branchSegments,
      ...teeMainSegments,
      ...teeBranchSegments
    ];
    const totalLength = Math.round(
      allSegments.reduce((sum, segment) => sum + (segment.length || 0), 0)
    );
    const totalWidth = allSegments.reduce((sum, segment) => sum + (segment.width || 0), 0);
    const avgWidth = allSegments.length > 0
      ? Number((totalWidth / allSegments.length).toFixed(2))
      : 0;

    return {
      pipelineCount: pipelineData.pipelines?.length || 0,
      teeCount: pipelineData.tees?.length || 0,
      mainPipeCount: pipelineData.mainPipes?.length || 0,
      branchPipeCount: pipelineData.branchPipes?.length || 0,
      flowArrowCount: pipelineData.flowArrows?.length || 0,
      uniqueEdgeCount: pipelineData.uniqueEdges?.length || 0,
      mainEndpointCount: pipelineData.mainEndpoints?.length || 0,
      branchEndpointCount: pipelineData.branchEndpoints?.length || 0,
      numberedWeldCount: pipelineData.weldNumberingSequence?.length || 0,
      avgWidth,
      totalLength
    };
  }, [pipelineData, vectors, visible]);

  useEffect(() => {
    if (!visible || !vectors || vectors.length === 0 || !canvasRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // 获取父容器尺寸
    const parent = canvas.parentElement;
    const width = parent.clientWidth;
    const height = parent.clientHeight;

    // 设置 Canvas 尺寸
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // 绘制主管线段 (深蓝色加粗)
    const mainSegments = pipelineData.mainSegments || [];
    if (mainSegments.length > 0) {
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = '#0050b3'; // 深蓝色 (更深，更明显)
      ctx.lineCap = 'round';

      mainSegments.forEach(segment => {
        const { start, end, width: lineWidth } = segment;
        
        // 加粗绘制
        ctx.lineWidth = (lineWidth + 4) * scale; // 主管更粗
        
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
      });
    }

    // 🌟 绘制三通中的主管段 (深蓝色 + 黄色描边)
    const teeMainSegments = pipelineData.teeMainSegments || [];
    if (teeMainSegments.length > 0) {
      ctx.lineCap = 'round';
      
      teeMainSegments.forEach(segment => {
        const { start, end, width: lineWidth } = segment;
        
        // 先画黄色描边
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#faad14';
        ctx.lineWidth = (lineWidth + 6) * scale;
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
        
        // 再画深蓝色主体
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = '#0050b3';
        ctx.lineWidth = (lineWidth + 4) * scale;
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
      });
    }

    // 绘制支管线段 (橙色，与主管明显区分)
    const branchSegments = pipelineData.branchSegments || [];
    if (branchSegments.length > 0) {
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#fa8c16'; // 橙色 (与深蓝色形成鲜明对比)
      ctx.lineCap = 'round';

      branchSegments.forEach(segment => {
        const { start, end, width: lineWidth } = segment;
        
        // 正常绘制
        ctx.lineWidth = (lineWidth + 2) * scale;
        
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
      });
    }

    // 🌟 绘制三通中的支管段 (橙色 + 黄色描边)
    const teeBranchSegments = pipelineData.teeBranchSegments || [];
    if (teeBranchSegments.length > 0) {
      ctx.lineCap = 'round';
      
      teeBranchSegments.forEach(segment => {
        const { start, end, width: lineWidth } = segment;
        
        // 先画黄色描边
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#faad14';
        ctx.lineWidth = (lineWidth + 5) * scale;
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
        
        // 再画橙色主体
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = '#fa8c16';
        ctx.lineWidth = (lineWidth + 2) * scale;
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
      });
    }

    // 绘制流向箭头 (可视化已移除)
    /*
    const arrowSegments = pipelineData.flowArrowSegments;
    if (arrowSegments.length > 0) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#722ed1'; // 紫色
      ctx.lineCap = 'round';

      arrowSegments.forEach(segment => {
         const { start, end, width: lineWidth } = segment;
         ctx.lineWidth = (lineWidth + 2) * scale;
         ctx.beginPath();
         ctx.moveTo(start.x * scale, start.y * scale);
         ctx.lineTo(end.x * scale, end.y * scale);
         ctx.stroke();
      });
    }
    */

    // 🌟 绘制三通中心点 (红色圆点)
    const tees = pipelineData.tees || [];
    if (tees.length > 0) {
      ctx.fillStyle = '#f5222d'; // 红色
      tees.forEach(tee => {
        ctx.beginPath();
        ctx.arc(tee.center.x * scale, tee.center.y * scale, 5 * scale, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 🎯 绘制管道端点（区分主管/支管）
    const mainEndpoints = pipelineData.mainEndpoints || [];
    const branchEndpoints = pipelineData.branchEndpoints || [];
    
    ctx.globalAlpha = 1.0;
    ctx.lineCap = 'round';
    
    // 🟣 绘制主管端点（紫色，加粗）
    if (mainEndpoints.length > 0) {
      ctx.strokeStyle = '#9254de'; // 紫色
      ctx.lineWidth = 6 * scale; // 主管更粗
      mainEndpoints.forEach(edge => {
        const { start, end } = edge;
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
      });
      console.log(`   🟣 已绘制 ${mainEndpoints.length} 个主管端点（紫色）`);
    }
    
    // 🟣 绘制支管端点（紫色）
    if (branchEndpoints.length > 0) {
      ctx.strokeStyle = '#9254de'; // 紫色
      ctx.lineWidth = 4 * scale; // 支管较细
      branchEndpoints.forEach(edge => {
        const { start, end } = edge;
        ctx.beginPath();
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
      });
      console.log(`   🟣 已绘制 ${branchEndpoints.length} 个支管端点（紫色）`);
    }

  }, [vectors, scale, visible, pipelineData]);

  if (!visible || !vectors || vectors.length === 0) {
    return null;
  }

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 998, pointerEvents: 'none' }}>
      <canvas 
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
      />
      
      {/* 显示统计信息 */}
      {visible && (pipelineData.pipelines.length > 0 || pipelineData.flowArrows.length > 0) && (
        <div style={{
          position: 'absolute',
          top: '50px',
          left: '10px',
          background: 'rgba(24, 144, 255, 0.9)',
          color: 'white',
          padding: '10px 14px',
          borderRadius: '6px',
          fontSize: '12px',
          fontFamily: 'monospace',
          pointerEvents: 'none',
          lineHeight: '1.8',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
        }}>
          <div style={{fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.3)', paddingBottom: '4px'}}>
            📊 管线网络拓扑
          </div>
          
          {/* 🌟 颜色图例 */}
          <div style={{marginBottom: '8px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.2)', fontSize: '11px'}}>
            <div style={{marginBottom: '3px', opacity: 0.9}}>🎨 颜色图例:</div>
            <div style={{display: 'flex', alignItems: 'center', marginBottom: '2px'}}>
              <span style={{display: 'inline-block', width: '30px', height: '3px', background: '#0050b3', marginRight: '6px', borderRadius: '2px'}}></span>
              <span>主管</span>
            </div>
            <div style={{display: 'flex', alignItems: 'center', marginBottom: '2px'}}>
              <span style={{display: 'inline-block', width: '30px', height: '3px', background: '#fa8c16', marginRight: '6px', borderRadius: '2px'}}></span>
              <span>支管</span>
            </div>
            <div style={{display: 'flex', alignItems: 'center', marginBottom: '2px'}}>
              <span style={{display: 'inline-block', width: '30px', height: '3px', background: 'linear-gradient(to right, #faad14, #0050b3, #faad14)', marginRight: '6px', borderRadius: '2px'}}></span>
              <span>三通</span>
            </div>
            {/* 流向箭头图例已移除 */}
            <div style={{display: 'flex', alignItems: 'center'}}>
              <span style={{display: 'inline-block', width: '20px', height: '4px', background: '#1890ff', marginRight: '6px', borderRadius: '2px'}}></span>
              <span style={{fontSize: '11px'}}>主管端点</span>
              <span style={{display: 'inline-block', width: '20px', height: '3px', background: '#fa8c16', marginLeft: '12px', marginRight: '6px', borderRadius: '2px'}}></span>
              <span style={{fontSize: '11px'}}>支管端点</span>
            </div>
          </div>
          
          {/* 显示合并后的管子统计 */}
          {pipelineData.topology && pipelineData.topology.mergedPipes && (
            <div style={{marginBottom: '6px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.2)'}}>
              <div style={{fontSize: '11px', opacity: 0.8, marginBottom: '2px'}}>合并后:</div>
              <div>
                🔵 <span style={{color: '#1890ff', background: 'white', padding: '0 4px', borderRadius: '2px', fontWeight: 'bold'}}>主管</span>: 
                <span style={{fontWeight: 'bold', marginLeft: '4px'}}>1</span> 根
                {pipelineData.topology.mainPipe && (
                  <span style={{fontSize: '10px', opacity: 0.8}}>
                    ({pipelineData.topology.mainPipe.segments.length}段, {pipelineData.topology.mainPipe.welds.length}焊点)
                  </span>
                )}
              </div>
              <div>
                ⚪ <span style={{color: '#69c0ff', background: 'white', padding: '0 4px', borderRadius: '2px', fontWeight: 'bold'}}>支管</span>: 
                <span style={{fontWeight: 'bold', marginLeft: '4px'}}>{pipelineData.topology.mergedBranchPipes?.length || 0}</span> 根
              </div>
            </div>
          )}
          
          {/* 原始管道段统计 */}
          <div>
            <div style={{fontSize: '11px', opacity: 0.8, marginBottom: '2px'}}>管道段:</div>
            <div style={{fontSize: '11px'}}>
              主管段: <span style={{fontWeight: 'bold'}}>{renderStats.mainPipeCount}</span> | 
              支管段: <span style={{fontWeight: 'bold', marginLeft: '4px'}}>{renderStats.branchPipeCount}</span>
            </div>
          </div>
          
          {/* 流向箭头统计已移除 */}
          
          {/* 🌟 显示三通统计 */}
          <div>🧩 识别三通: <span style={{fontWeight: 'bold', color: '#faad14'}}>{renderStats.teeCount}</span> 个</div>
          
          {/* 🎯 显示管道端点统计 */}
          <div style={{marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.2)'}}>
            <div style={{fontSize: '11px', opacity: 0.8, marginBottom: '2px'}}>管道端点:</div>
            <div style={{fontSize: '11px'}}>
              🔵 主管: <span style={{fontWeight: 'bold', color: '#1890ff'}}>{renderStats.mainEndpointCount}</span> | 
              🟠 支管: <span style={{fontWeight: 'bold', color: '#fa8c16', marginLeft: '4px'}}>{renderStats.branchEndpointCount}</span>
            </div>
          </div>
          
          {/* 📝 显示焊点编号统计 */}
          {renderStats.numberedWeldCount > 0 && (
            <div style={{marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.2)'}}>
              <div style={{fontSize: '11px', opacity: 0.8, marginBottom: '2px'}}>焊点编号:</div>
              <div style={{fontSize: '11px'}}>
                📝 已编号: <span style={{fontWeight: 'bold', color: '#52c41a'}}>{renderStats.numberedWeldCount}</span> 个
              </div>
              <div style={{fontSize: '10px', opacity: 0.7, marginTop: '2px'}}>
                (主管优先，从端点开始)
              </div>
            </div>
          )}
          
          <div style={{marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.2)', fontSize: '11px', opacity: 0.9}}>
            <div>📏 平均线宽: {renderStats.avgWidth}</div>
            <div>📐 总长度: {renderStats.totalLength}</div>
          </div>
        </div>
      )}
    </div>
  );
};
