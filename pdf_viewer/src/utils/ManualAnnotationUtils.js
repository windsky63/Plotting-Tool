import { getVectorSegmentType } from './vectorTypeUtils';

/**
 * 手动标注工具
 * 用于导出用户手动选择的焊点特征，供AI分析生成新规则
 */

/**
 * 导出手动选中的路径特征（用于分析和生成规则）
 * @param {Set} selectedIndices - 选中的向量索引集合
 * @param {Array} vectors - 所有向量数据
 * @returns {Object} - 标注数据
 */
export function exportManualAnnotations(selectedIndices, vectors) {
  if (selectedIndices.size === 0) {
    console.warn('⚠️ 未选中任何对象');
    return null;
  }

  // 按 Path ID 分组选中的向量
  const pathGroups = new Map();
  
  selectedIndices.forEach(idx => {
    const vec = vectors[idx];
    if (!vec || vec.length < 8) return;
    
    const pathId = vec[7]; // Path ID
    
    if (!pathGroups.has(pathId)) {
      pathGroups.set(pathId, {
        pathId,
        vectorIndices: [],
        segments: []
      });
    }
    
    const group = pathGroups.get(pathId);
    group.vectorIndices.push(idx);
    
    const [type, x1, y1, x2, y2, color, width] = vec;
    group.segments.push({
      type: getVectorSegmentType(type),
      x1, y1, x2, y2,
      p1: { x: x1, y: y1 },
      p2: { x: x2, y: y2 },
      color,
      width
    });
  });

  // 分析每个路径的特征
  const annotations = [];
  
  pathGroups.forEach((path, pathId) => {
    const features = analyzePathFeatures(path);
    annotations.push({
      pathId,
      vectorCount: path.vectorIndices.length,
      ...features,
      segments: path.segments // 保留原始线段数据
    });
  });

  const exportData = {
    export_time: new Date().toISOString(),
    annotation_type: 'manual_weld_selection',
    total_selected_paths: annotations.length,
    total_selected_vectors: selectedIndices.size,
    instructions: '这是用户手动标注的焊点数据，请分析这些路径的共同特征并生成识别规则',
    annotations: annotations,
    statistics: generateStatistics(annotations)
  };

  return exportData;
}

/**
 * 分析路径特征
 */
function analyzePathFeatures(path) {
  const segments = path.segments;
  
  // 1. 基本特征
  const segmentCount = segments.length;
  const allLines = segments.every(seg => seg.type === 'line');
  const allCurves = segments.every(seg => seg.type === 'curve');
  const mixedTypes = !allLines && !allCurves;
  
  // 2. 几何特征
  const bbox = calculateBoundingBox(segments);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  const aspectRatio = height > 0 ? width / height : 0;
  const area = width * height;
  
  // 3. 闭合性检查
  const firstPoint = segments[0]?.p1;
  const lastPoint = segments[segments.length - 1]?.p2;
  const closeDistance = firstPoint && lastPoint ? 
    Math.sqrt(Math.pow(lastPoint.x - firstPoint.x, 2) + Math.pow(lastPoint.y - firstPoint.y, 2)) : 
    Infinity;
  const isClosed = closeDistance < 2.0; // 容差2.0
  
  // 4. 线段长度分析
  const segmentLengths = segments.map(seg => 
    Math.sqrt(Math.pow(seg.x2 - seg.x1, 2) + Math.pow(seg.y2 - seg.y1, 2))
  );
  const avgSegmentLength = segmentLengths.reduce((a, b) => a + b, 0) / segmentLengths.length;
  const minSegmentLength = Math.min(...segmentLengths);
  const maxSegmentLength = Math.max(...segmentLengths);
  const segmentLengthVariance = calculateVariance(segmentLengths);
  
  // 5. 形状规则性（线段长度是否相近）
  const isRegular = segmentLengthVariance < avgSegmentLength * 0.3; // 方差小于均值的30%
  
  // 6. 圆形度检测（如果是多边形逼近圆）
  const isCircleLike = isCircularShape(segments, bbox);
  
  // 7. 颜色和线宽
  const colors = [...new Set(segments.map(seg => seg.color))];
  const widths = [...new Set(segments.map(seg => seg.width))];
  
  return {
    // 基本特征
    segmentCount,
    allLines,
    allCurves,
    mixedTypes,
    
    // 几何特征
    boundingBox: bbox,
    width: parseFloat(width.toFixed(2)),
    height: parseFloat(height.toFixed(2)),
    aspectRatio: parseFloat(aspectRatio.toFixed(2)),
    area: parseFloat(area.toFixed(2)),
    
    // 闭合性
    isClosed,
    closeDistance: parseFloat(closeDistance.toFixed(2)),
    
    // 线段特征
    avgSegmentLength: parseFloat(avgSegmentLength.toFixed(2)),
    minSegmentLength: parseFloat(minSegmentLength.toFixed(2)),
    maxSegmentLength: parseFloat(maxSegmentLength.toFixed(2)),
    segmentLengthVariance: parseFloat(segmentLengthVariance.toFixed(2)),
    isRegular,
    
    // 形状特征
    isCircleLike,
    
    // 样式特征
    uniqueColors: colors.length,
    uniqueWidths: widths.length,
    colors: colors,
    widths: widths
  };
}

/**
 * 计算包围盒
 */
function calculateBoundingBox(segments) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  
  segments.forEach(seg => {
    minX = Math.min(minX, seg.x1, seg.x2);
    minY = Math.min(minY, seg.y1, seg.y2);
    maxX = Math.max(maxX, seg.x1, seg.x2);
    maxY = Math.max(maxY, seg.y1, seg.y2);
  });
  
  return { minX, minY, maxX, maxY };
}

/**
 * 计算方差
 */
function calculateVariance(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 判断是否为圆形（多边形逼近圆）
 */
function isCircularShape(segments, bbox) {
  if (segments.length < 10) return false; // 至少10条边
  
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  // 检查是否接近正方形
  const aspectRatio = height > 0 ? width / height : 0;
  if (aspectRatio < 0.8 || aspectRatio > 1.2) return false;
  
  // 计算中心点
  const centerX = (bbox.minX + bbox.maxX) / 2;
  const centerY = (bbox.minY + bbox.maxY) / 2;
  
  // 计算所有顶点到中心的距离
  const distances = [];
  segments.forEach(seg => {
    const d1 = Math.sqrt(Math.pow(seg.x1 - centerX, 2) + Math.pow(seg.y1 - centerY, 2));
    const d2 = Math.sqrt(Math.pow(seg.x2 - centerX, 2) + Math.pow(seg.y2 - centerY, 2));
    distances.push(d1, d2);
  });
  
  // 检查距离的方差是否小（圆形的顶点到中心距离应该相近）
  const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
  const variance = calculateVariance(distances);
  const relativeVariance = variance / (avgDistance * avgDistance);
  
  return relativeVariance < 0.05; // 相对方差小于5%
}

/**
 * 生成统计信息
 */
function generateStatistics(annotations) {
  if (annotations.length === 0) return {};
  
  const stats = {
    // 边数分布
    segmentCounts: {},
    segmentCountRange: {
      min: Infinity,
      max: -Infinity,
      avg: 0
    },
    
    // 尺寸分布
    widths: annotations.map(a => a.width),
    heights: annotations.map(a => a.height),
    sizeRange: {
      widthMin: Infinity,
      widthMax: -Infinity,
      heightMin: Infinity,
      heightMax: -Infinity
    },
    
    // 形状特征
    closedCount: 0,
    circularCount: 0,
    regularCount: 0,
    allLinesCount: 0,
    
    // 宽高比分布
    aspectRatios: annotations.map(a => a.aspectRatio),
    
    // 建议的规则范围
    suggestedRanges: {}
  };
  
  annotations.forEach(ann => {
    // 边数统计
    const count = ann.segmentCount;
    stats.segmentCounts[count] = (stats.segmentCounts[count] || 0) + 1;
    stats.segmentCountRange.min = Math.min(stats.segmentCountRange.min, count);
    stats.segmentCountRange.max = Math.max(stats.segmentCountRange.max, count);
    
    // 尺寸统计
    stats.sizeRange.widthMin = Math.min(stats.sizeRange.widthMin, ann.width);
    stats.sizeRange.widthMax = Math.max(stats.sizeRange.widthMax, ann.width);
    stats.sizeRange.heightMin = Math.min(stats.sizeRange.heightMin, ann.height);
    stats.sizeRange.heightMax = Math.max(stats.sizeRange.heightMax, ann.height);
    
    // 形状特征统计
    if (ann.isClosed) stats.closedCount++;
    if (ann.isCircleLike) stats.circularCount++;
    if (ann.isRegular) stats.regularCount++;
    if (ann.allLines) stats.allLinesCount++;
  });
  
  stats.segmentCountRange.avg = annotations.reduce((sum, a) => sum + a.segmentCount, 0) / annotations.length;
  
  // 生成建议的规则范围
  stats.suggestedRanges = {
    segmentCount: {
      min: Math.floor(stats.segmentCountRange.min * 0.9),
      max: Math.ceil(stats.segmentCountRange.max * 1.1),
      common: getMostCommonValue(Object.entries(stats.segmentCounts))
    },
    size: {
      width: [
        Math.floor(stats.sizeRange.widthMin * 0.8 * 10) / 10,
        Math.ceil(stats.sizeRange.widthMax * 1.2 * 10) / 10
      ],
      height: [
        Math.floor(stats.sizeRange.heightMin * 0.8 * 10) / 10,
        Math.ceil(stats.sizeRange.heightMax * 1.2 * 10) / 10
      ]
    },
    aspectRatio: {
      min: Math.min(...stats.aspectRatios) * 0.9,
      max: Math.max(...stats.aspectRatios) * 1.1
    },
    requireClosed: stats.closedCount / annotations.length > 0.8,
    requireAllLines: stats.allLinesCount / annotations.length > 0.8,
    isCircular: stats.circularCount / annotations.length > 0.5
  };
  
  return stats;
}

/**
 * 获取最常见的值
 */
function getMostCommonValue(entries) {
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * 下载标注数据
 */
export function downloadAnnotations(data, filename = 'manual_weld_annotations.json') {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  
  URL.revokeObjectURL(url);
  
  console.log('✅ 手动标注数据已导出');
  console.log(`📊 标注了 ${data.total_selected_paths} 个路径`);
  console.log('💡 请将此文件发送给AI分析，生成新的识别规则');
}













