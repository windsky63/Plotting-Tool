import { isLineVectorType } from './vectorTypeUtils';

/**
 * 焊点检测器
 * 实现多种几何规则检测焊点特征
 * 复刻 Python 项目中的规则函数
 */

/**
 * 计算两点距离
 */
function distance(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 规则：12边形且闭合 (标准焊点)
 */
export function rule12SidedWeld(path) {
  if (path.segments.length !== 12) return false;
  
  // 检查是否全为直线
  if (!path.segments.every(seg => seg.type === 'line')) return false;
  
  // 闭合检查
  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[path.segments.length - 1].p2;
  const dist = distance(firstPoint, lastPoint);
  
  return dist < 1.0;
}

/**
 * 规则：6边形且闭合 (旧式焊点)
 */
export function rule6SidedWeld(path) {
  if (path.segments.length !== 6) return false;
  
  if (!path.segments.every(seg => seg.type === 'line')) return false;
  
  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[path.segments.length - 1].p2;
  const dist = distance(firstPoint, lastPoint);
  
  return dist < 1.0;
}

/**
 * 规则：5边形且闭合 (阀门特征)
 */
export function rule5SidedValve(path) {
  if (path.segments.length !== 5) return false;
  
  if (!path.segments.every(seg => seg.type === 'line')) return false;
  
  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[path.segments.length - 1].p2;
  const dist = distance(firstPoint, lastPoint);
  
  return dist < 1.0;
}

/**
 * 规则：小圆形 (通常由4条曲线组成)
 */
export function ruleSmallCircleWeld(path) {
  if (path.segments.length !== 4) return false;
  
  // 检查是否全是曲线
  if (!path.segments.every(seg => seg.type === 'curve')) return false;
  
  // 计算包围盒
  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  // 尺寸检查 (2.0 - 8.0)
  if (!(2.0 < width && width < 8.0 && 2.0 < height && height < 8.0)) {
    return false;
  }
  
  // 比例检查 (圆形)
  const ratio = height > 0 ? width / height : 0;
  if (!(0.8 < ratio && ratio < 1.2)) {
    return false;
  }
  
  return true;
}

/**
 * 规则：12条曲线组成的小型焊点 (手动标注特征)
 * 特征：
 * 1. 由12条贝塞尔曲线组成
 * 2. 支持圆形和各种方向的椭圆形
 * 
 * 样本特征：
 * - 圆形：2.84 x 2.84 (宽高比 1.0)
 * - 横向椭圆：3.36 x 1.81 (宽高比 1.86)
 * - 竖向椭圆：1.55 x 3.1 (宽高比 0.5)
 */
export function rule12CurveCircleWeld(path) {
  // 段数检查 (10-14条)
  const count = path.segments.length;
  if (!(10 <= count && count <= 14)) return false;
  
  // 必须全是曲线
  if (!path.segments.every(seg => seg.type === 'curve')) return false;
  
  // 尺寸检查
  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  // 综合三种样本的尺寸范围
  // 圆形样本: 2.84 x 2.84
  // 横向椭圆样本: 3.36 x 1.81
  // 竖向椭圆样本: 1.55 x 3.1
  
  // 宽度范围：1.55-3.36，设定为 1.2-4.2 留有余量
  if (!(1.2 < width && width < 4.2)) {
    return false;
  }
  
  // 高度范围：1.81-3.1，设定为 1.3-3.5 留有余量
  if (!(1.3 < height && height < 3.5)) {
    return false;
  }
  
  // 比例检查：支持竖向椭圆(~0.5)、圆形(~1.0)、横向椭圆(~1.86)
  // 设定范围 0.4 - 2.2
  const ratio = height > 0 ? width / height : 0;
  if (!(0.4 < ratio && ratio < 2.2)) {
    return false;
  }
  
  return true;
}

/**
 * 规则：多段线拟合的圆形焊点
 * 特征：
 * 1. 大量短线段(>20)
 * 2. 整体尺寸较小且接近正方形 (约4x4)
 */
export function ruleComplexCircleWeld(path) {
  if (path.segments.length < 20) return false;
  
  // 计算包围盒
  const bbox = calculateBoundingBox(path);
  
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  // 尺寸检查 (2.0 - 8.0)
  if (!(2.0 < width && width < 8.0 && 2.0 < height && height < 8.0)) {
    return false;
  }
  
  // 比例检查 (正方形/圆形)
  const ratio = height > 0 ? width / height : 0;
  if (!(0.8 < ratio && ratio < 1.2)) {
    return false;
  }
  
  return true;
}

/**
 * 规则：17段线组成的圆形焊点
 * 特征：
 * 1. 由约17条线段组成 (范围 15-19)
 * 2. 尺寸约 6.48 x 6.48
 * 3. 闭合回路
 */
export function rule17SegmentCircleWeld(path) {
  const count = path.segments.length;
  if (!(15 <= count && count <= 19)) return false;
  
  // 必须全是直线
  if (!path.segments.every(seg => seg.type === 'line')) return false;
  
  // 尺寸检查
  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  // 样本尺寸 6.48，设定范围 5.5 - 7.5
  if (!(5.5 < width && width < 7.5 && 5.5 < height && height < 7.5)) {
    return false;
  }
  
  // 比例检查
  const ratio = height > 0 ? width / height : 0;
  if (!(0.8 < ratio && ratio < 1.2)) {
    return false;
  }
  
  // 闭合检查
  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[path.segments.length - 1].p2;
  const dist = distance(firstPoint, lastPoint);
  if (dist > 2.0) return false;
  
  return true;
}

/**
 * 规则：带填充的六边形焊点
 * 特征：
 * 1. 外框是一个闭合的6边形
 * 2. 尺寸约 4.3x4.3
 */
export function ruleHexWeldWithFill(path) {
  if (path.segments.length !== 6) return false;
  
  // 必须全是直线
  if (!path.segments.every(seg => seg.type === 'line')) return false;
  
  // 闭合检查
  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[path.segments.length - 1].p2;
  const dist = distance(firstPoint, lastPoint);
  
  if (dist > 2.0) return false;
  
  // 尺寸检查
  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  // 样本尺寸 4.3，设定范围 2.0 - 10.0
  if (!(2.0 < width && width < 10.0 && 2.0 < height && height < 10.0)) {
    return false;
  }
  
  return true;
}

/**
 * 规则：黑色实心填充组件
 * 特征：
 * 1. 具有黑色填充 (暗色)
 * 2. 尺寸较小 (约 2x2 - 4x4)
 */
export function ruleBlackFilledComponent(path) {
  // 检查填充色（如果有的话）
  // 前端提取的向量数据可能不包含填充信息
  // 这个规则可能需要扩展 vectorExtractionUtils 来提取填充色
  
  if (path.segments.length < 3) return false; // 至少三角形
  
  // 尺寸检查
  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  // 设定范围 0.5 - 6.0
  if (!(0.5 < width && width < 6.0 && 0.5 < height && height < 6.0)) {
    return false;
  }
  
  return true;
}

/**
 * 规则：高密度填充型焊点 (实心焊点)
 * 特征：
 * 1. 极大量短线段 (>90条，通常是CAD实心填充)
 * 2. 极小尺寸 (<8px)
 * 3. 接近正方形/圆形 (宽高比 0.8-1.2)
 * 
 * 样本特征：
 * - 4x4 尺寸，95条线段
 * 
 * 这种焊点在 CAD 图纸中通常表示为实心圆点
 * 使用高阈值(>90)避免误判普通多边形为焊点
 */
export function ruleHighDensityFilledWeld(path) {
  // 段数检查：极高密度填充 (>90条)
  const count = path.segments.length;
  if (count <= 90) return false;
  
  // 尺寸检查：极小尺寸 (<8px)
  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  
  if (!(width < 8 && height < 8)) {
    return false;
  }
  
  // 比例检查：接近正方形/圆形
  const ratio = height > 0 ? width / height : 0;
  if (!(0.8 < ratio && ratio < 1.2)) {
    return false;
  }
  
  return true;
}

/**
 * 计算路径的包围盒
 */
function calculateBoundingBox(path) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  
  path.segments.forEach(seg => {
    // 格式: [type, x1, y1, x2, y2, color, width, id]
    minX = Math.min(minX, seg.x1, seg.x2);
    minY = Math.min(minY, seg.y1, seg.y2);
    maxX = Math.max(maxX, seg.x1, seg.x2);
    maxY = Math.max(maxY, seg.y1, seg.y2);
  });
  
  return { minX, minY, maxX, maxY };
}

/**
 * 将原始向量数据转换为路径对象
 * @param {Array} vectors - 原始向量数据 [type, x1, y1, x2, y2, color, width, id]
 * @returns {Array} - 路径对象数组
 */
export function groupVectorsIntoPathsStructured(vectors) {
  const pathMap = new Map(); // pathId -> { id, segments: [] }
  
  vectors.forEach((vec, index) => {
    if (!Array.isArray(vec) || vec.length < 8) return;
    
    const [type, x1, y1, x2, y2, color, width, pathId] = vec;
    
    if (!pathMap.has(pathId)) {
      pathMap.set(pathId, {
        id: pathId,
        segments: [],
        vectorIndices: []
      });
    }
    
    const path = pathMap.get(pathId);
    path.segments.push({
      type: type === 1 ? 'line' : 'curve',
      rawType: type,
      x1, y1, x2, y2,
      p1: { x: x1, y: y1 },
      p2: { x: x2, y: y2 },
      color,
      width,
      vectorIndex: index
    });
    path.vectorIndices.push(index);
  });
  
  return Array.from(pathMap.values());
}

/**
 * 检测所有焊点
 * @param {Array} paths - 路径对象数组
 * @param {Array} enabledRules - 启用的规则函数数组
 * @param {Array} ocrTextRegions - OCR识别的文字区域（已废弃，不再使用）
 * @returns {Array} - 检测到的焊点路径索引和类型
 */
export function detectWelds(paths, enabledRules, ocrTextRegions = null) {
  const detectedWelds = [];
  
  paths.forEach((path, pathIndex) => {
    for (const rule of enabledRules) {
      try {
        if (rule.func(path)) {
          // 使用过滤后的vectorIndices（如果存在）
          const vectorIndices = path._filteredVectorIndices || path.vectorIndices;
          const bbox = calculateBoundingBox(path);
          const center = calculatePathCenter(path);
          
          detectedWelds.push({
            pathId: path.id,
            pathIndex,
            ruleId: rule.id,
            ruleName: rule.name,
            vectorIndices: vectorIndices,  // 使用过滤后的索引
            segments: path.segments,
            center: center,
            boundingBox: bbox
          });
          break; // 匹配任一规则即可
        }
      } catch (error) {
        console.error(`规则执行错误 [${rule.name}]:`, error);
      }
    }
  });
  
  // 几何去重：过滤掉位置和大小几乎完全相同的重复焊点
  // 这通常发生在 PDF 包含重复绘制指令的情况下
  const uniqueWelds = [];
  detectedWelds.forEach(weld => {
    const isDuplicate = uniqueWelds.some(existing => {
      // 1. 距离检查 (< 1px)
      const dist = Math.sqrt(
        Math.pow(weld.center.x - existing.center.x, 2) + 
        Math.pow(weld.center.y - existing.center.y, 2)
      );
      
      if (dist < 1.0) {
        // 2. 包围盒大小检查 (< 1px 差异)
        const widthDiff = Math.abs((weld.boundingBox.maxX - weld.boundingBox.minX) - (existing.boundingBox.maxX - existing.boundingBox.minX));
        const heightDiff = Math.abs((weld.boundingBox.maxY - weld.boundingBox.minY) - (existing.boundingBox.maxY - existing.boundingBox.minY));
        
        if (widthDiff < 1.0 && heightDiff < 1.0) {
          return true;
        }
      }
      return false;
    });
    
    if (!isDuplicate) {
      uniqueWelds.push(weld);
    } else {
      // console.log(`♻️ 过滤重复焊点: Path ${weld.pathId} 与现有焊点重叠`);
    }
  });
  
  if (uniqueWelds.length !== detectedWelds.length) {
    console.log(`♻️ 几何去重: ${detectedWelds.length} -> ${uniqueWelds.length} (过滤了 ${detectedWelds.length - uniqueWelds.length} 个重复焊点)`);
  }
  
  console.log(`✅ 检测到 ${uniqueWelds.length} 个焊点`);
  
  return uniqueWelds;
}

/**
 * 计算路径中心点
 */
function calculatePathCenter(path) {
  const bbox = calculateBoundingBox(path);
  return {
    x: (bbox.minX + bbox.maxX) / 2,
    y: (bbox.minY + bbox.maxY) / 2
  };
}

/**
 * 检查焊点候选是否与OCR文字区域重叠
 * @param {Object} bbox - 焊点的包围盒 {minX, minY, maxX, maxY}
 * @param {Object} center - 焊点中心点 {x, y}
 * @param {Array} textRegions - OCR文字区域数组
 * @returns {boolean} - 是否与文字区域重叠
 */
function isOverlappingWithTextRegions(bbox, center, textRegions) {
  for (const region of textRegions) {
    // 检查包围盒重叠
    if (isBboxOverlapping(bbox, region)) {
      return true;
    }
    
    // 检查中心点是否在文字区域内
    if (isPointInRegion(center, region)) {
      return true;
    }
  }
  
  return false;
}

/**
 * 检查两个包围盒是否重叠
 * @param {Object} bbox1 - 包围盒1 {minX, minY, maxX, maxY}
 * @param {Object} bbox2 - 包围盒2 {minX, minY, maxX, maxY}
 * @returns {boolean} - 是否重叠
 */
function isBboxOverlapping(bbox1, bbox2) {
  // 计算重叠面积
  const overlapX = Math.max(0, Math.min(bbox1.maxX, bbox2.maxX) - Math.max(bbox1.minX, bbox2.minX));
  const overlapY = Math.max(0, Math.min(bbox1.maxY, bbox2.maxY) - Math.max(bbox1.minY, bbox2.minY));
  const overlapArea = overlapX * overlapY;
  
  // 🎯 只要有任何重叠就过滤（最严格的判定）
  // 焊点的任意一点触碰到文字区域就视为重叠
  return overlapArea > 0;
}

/**
 * 检查点是否在区域内
 * @param {Object} point - 点坐标 {x, y}
 * @param {Object} region - 区域 {minX, minY, maxX, maxY}
 * @returns {boolean} - 是否在区域内
 */
function isPointInRegion(point, region) {
  return point.x >= region.minX && point.x <= region.maxX &&
         point.y >= region.minY && point.y <= region.maxY;
}

/**
 * 规则：6条曲线闭合路径 (通用焊点)
 * 特征：
 * 1. 线段数恰好为6条
 * 2. 必须全为曲线
 * 3. 路径闭合（首尾距离 < 2.0）
 * 4. 包围盒宽度和高度均大于1
 */
export function rule6SegmentClosedPath(path) {
  if (path.segments.length !== 6) return false;

  if (!path.segments.every(seg => seg.type === 'curve')) return false;

  const lengths = path.segments.map(seg => distance(seg.p1, seg.p2)).filter(length => length > 0);
  if (lengths.length !== 6) return false;
  const sortedLengths = [...lengths].sort((a, b) => a - b);
  const medianLength = (sortedLengths[2] + sortedLengths[3]) / 2;
  const maxLength = sortedLengths[sortedLengths.length - 1];
  const minLength = sortedLengths[0];

  if (medianLength <= 0) return false;

  if (maxLength / medianLength > 2.6 || maxLength / Math.max(minLength, 0.01) > 4.0) {
    return false;
  }

  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[path.segments.length - 1].p2;
  const dist = distance(firstPoint, lastPoint);

  if (dist > 2.0) return false;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  path.segments.forEach(seg => {
    minX = Math.min(minX, seg.p1.x, seg.p2.x);
    minY = Math.min(minY, seg.p1.y, seg.p2.y);
    maxX = Math.max(maxX, seg.p1.x, seg.p2.x);
    maxY = Math.max(maxY, seg.p1.y, seg.p2.y);
  });
  const width = maxX - minX;
  const height = maxY - minY;

  if (width <= 1.0 || height <= 1.0) return false;

  console.log(`✅ [6曲线闭合] Path ${path.id}: 匹配成功! (6曲线, 闭合, 首尾距离=${dist.toFixed(2)}, 宽=${width.toFixed(2)}, 高=${height.toFixed(2)})`);
  return true;
}

/**
 * 规则：差连识别 (15-17线段路径，自动过滤干扰线段)
 * 特征：
 * 1. 线段数：15-17条（排除干扰线段后）
 * 2. 自动剔除：过长的直线、远离主体的线段
 * 
 * 样本特征：
 * - 线段数：15 (原始样本)
 * - 线段数：15+1远离线段 (自动过滤)
 */
export function rule15SegmentClosedPath(path) {
  if (path.segments.length < 2) return false;
  
  // 计算每个segment的中点和长度
  const segmentInfo = path.segments.map(seg => {
    const dx = seg.p2.x - seg.p1.x;
    const dy = seg.p2.y - seg.p1.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const centerX = (seg.p1.x + seg.p2.x) / 2;
    const centerY = (seg.p1.y + seg.p2.y) / 2;
    return { seg, length, centerX, centerY };
  });
  
  // 计算所有线段中点的质心（几何中心）
  const avgX = segmentInfo.reduce((sum, info) => sum + info.centerX, 0) / segmentInfo.length;
  const avgY = segmentInfo.reduce((sum, info) => sum + info.centerY, 0) / segmentInfo.length;
  
  // 计算每个线段中点到质心的距离
  const distancesToCenter = segmentInfo.map(info => {
    const dx = info.centerX - avgX;
    const dy = info.centerY - avgY;
    return Math.sqrt(dx * dx + dy * dy);
  });
  
  // 计算平均距离和平均长度
  const avgDistance = distancesToCenter.reduce((a, b) => a + b, 0) / distancesToCenter.length;
  const avgLength = segmentInfo.reduce((sum, info) => sum + info.length, 0) / segmentInfo.length;
  
  // 收集要过滤的向量索引
  const filteredIndices = [];
  // 收集过滤后的线段，用于计算包围盒和闭合性
  const filteredSegments = [];
  
  path.vectorIndices.forEach((vectorIdx, i) => {
    const seg = path.segments[i];
    const info = segmentInfo[i];
    const distance = distancesToCenter[i];
    
    // 1. 过滤过长的直线（可能是指示线）
    if (seg.type === 'line' && info.length > avgLength * 5) {
      console.log(`🔧 [差连识别] Path ${path.id}: 过滤长直线 (长度=${info.length.toFixed(1)})`);
      return;
    }
    
    // 2. 过滤远离主体的线段（距离超过平均距离的10倍）
    if (distance > avgDistance * 10) {
      console.log(`🔧 [差连识别] Path ${path.id}: 过滤远离线段 (距离=${distance.toFixed(1)}, 平均=${avgDistance.toFixed(1)})`);
      return;
    }
    
    filteredIndices.push(vectorIdx);
    filteredSegments.push(seg);
  });
  
  // 使用过滤后的线段数
  const count = filteredIndices.length;
  const originalCount = path.segments.length;
  
  if (originalCount !== count) {
    console.log(`🔍 [差连识别] Path ${path.id}: 原始${originalCount}段 → 过滤后${count}段`);
    // 将过滤后的索引存储到path对象上，供后续使用
    path._filteredVectorIndices = filteredIndices;
  } else {
    // console.log(`🔍 [差连识别] Path ${path.id}: 线段数=${count}`);
  }
  
  // 1. 线段数检查（14-16条）
  if (!(14 <= count && count <= 16)) {
    // console.log(`❌ [差连识别] Path ${path.id}: 线段数不符合 (需要14-16条)`);
    return false;
  }

  // 计算过滤后线段的包围盒
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  
  filteredSegments.forEach(seg => {
    minX = Math.min(minX, seg.x1, seg.x2);
    minY = Math.min(minY, seg.y1, seg.y2);
    maxX = Math.max(maxX, seg.x1, seg.x2);
    maxY = Math.max(maxY, seg.y1, seg.y2);
  });
  
  const width = maxX - minX;
  const height = maxY - minY;
  
  // 2. 尺寸检查 (宽度 2.5 附近，高度 2.6 附近)
  // 允许误差 ±0.8
  const widthTarget = 2.5;
  const heightTarget = 2.6;
  const tolerance = 0.8;
  
  if (!(Math.abs(width - widthTarget) <= tolerance)) {
    // console.log(`❌ [差连识别] Path ${path.id}: 宽度不符合 (${width.toFixed(2)} != ${widthTarget})`);
    return false;
  }
  
  if (!(Math.abs(height - heightTarget) <= tolerance)) {
    // console.log(`❌ [差连识别] Path ${path.id}: 高度不符合 (${height.toFixed(2)} != ${heightTarget})`);
    return false;
  }
  
  // 3. 闭合检查
  // 如果是闭合路径，所有线段应该首尾相连形成回路
  // 简单检查：计算所有线段端点的最大距离，或者检查首尾距离（如果是有序的）
  // 由于segments可能无序，这里使用一种简单的闭合性检查：
  // 检查是否所有端点都至少与另一个端点重合（度数为2）
  
  // 更简单的方法：如果是svg path解析出来的，通常是有序的
  // 检查首尾距离
  if (filteredSegments.length > 0) {
    const firstPoint = filteredSegments[0].p1;
    const lastPoint = filteredSegments[filteredSegments.length - 1].p2;
    const dist = distance(firstPoint, lastPoint);
    
    // 如果首尾距离较大，可能不是闭合的，或者顺序不对
    // 尝试更严格的闭合检查：检查是否能形成回路
    // 这里使用较宽松的判定：首尾距离 < 2.0 (类似其他规则)
    if (dist > 2.0) {
       // console.log(`❌ [差连识别] Path ${path.id}: 路径未闭合 (首尾距离=${dist.toFixed(2)})`);
       return false;
    }
  }
  
  console.log(`✅ [差连识别] Path ${path.id}: 匹配成功! (14-16线段, 2.5x2.6, 闭合)`);
  return true;
}

/**
 * 规则：12线段长闭合路径
 * 特征：
 * 1. 线段数恰好为12条
 * 2. 路径闭合（首尾距离 < 2.0）
 * 3. 所有线段总长度大于29
 */
export function rule12SegmentLongClosedPath(path) {
  if (path.segments.length !== 12) return false;

  // 闭合检查
  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[path.segments.length - 1].p2;
  const dist = distance(firstPoint, lastPoint);

  if (dist > 2.0) return false;

  // 计算总长度
  let totalLength = 0;
  path.segments.forEach(seg => {
    // 使用两端点距离作为线段长度的近似值
    totalLength += distance(seg.p1, seg.p2);
  });

  if (totalLength <= 29) return false;

  console.log(`✅ [福海创焊口] Path ${path.id}: 匹配成功! (12线段, 闭合, 总长度=${totalLength.toFixed(2)})`);
  return true;
}

/**
 * 规则：新加坡焊点
 * 特征：
 * 1. 线段数大于27且小于38 (即 28-37 条)
 * 2. 路径闭合（首尾距离 < 2.0）
 * 3. 连续（每个线段的终点与下一个线段的起点距离较小）
 * 4. 所有线段总长度小于20
 */
export function ruleSingaporeWeld(path) {
  const count = path.segments.length;
  if (!(count > 27 && count < 38)) return false;

  // 闭合检查
  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[count - 1].p2;
  const dist = distance(firstPoint, lastPoint);

  if (dist > 2.0) return false;

  // 连续性检查：每个线段的终点与下一个线段的起点距离较小
  // 同时计算总长度
  let totalLength = 0;
  for (let i = 0; i < count; i++) {
    const seg = path.segments[i];
    totalLength += distance(seg.p1, seg.p2);
    
    if (i < count - 1) {
      const currentEnd = seg.p2;
      const nextStart = path.segments[i + 1].p1;
      if (distance(currentEnd, nextStart) > 2.0) {
        return false;
      }
    }
  }

  if (totalLength >= 20) return false;

  console.log(`✅ [新加坡焊点] Path ${path.id}: 匹配成功! (${count}线段, 闭合, 连续, 总长度=${totalLength.toFixed(2)})`);
  return true;
}
/**
 * Malaysia project weld rule.
 * Based on the sample annotations in D:\pdf_viewer\模拟:
 * a small, flat, closed 12-line path rather than the longer 12-line weld rule.
 */
export function ruleMalaysiaWeld(path) {
  const count = path.segments.length;
  if (count !== 12) return false;

  if (!path.segments.every(seg => seg.p1 && seg.p2)) return false;

  const firstPoint = path.segments[0].p1;
  const lastPoint = path.segments[count - 1].p2;
  const closeDistance = distance(firstPoint, lastPoint);
  if (closeDistance > 1.2) return false;

  for (let i = 0; i < count - 1; i++) {
    const currentEnd = path.segments[i].p2;
    const nextStart = path.segments[i + 1].p1;
    if (distance(currentEnd, nextStart) > 1.2) return false;
  }

  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  if (width < 2.3 || width > 5.8) return false;
  if (height < 2.2 || height > 5.2) return false;

  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide < 2.3 || shortSide > 4.4) return false;
  if (longSide < 3.8 || longSide > 5.2) return false;

  const area = width * height;
  if (area < 10.5 || area > 18.5) return false;

  const aspectRatio = height > 0 ? width / height : 0;
  const normalizedAspectRatio = shortSide > 0 ? longSide / shortSide : 0;
  if (aspectRatio < 0.48 || aspectRatio > 1.95) return false;
  if (normalizedAspectRatio < 1.0 || normalizedAspectRatio > 2.1) return false;

  const lengths = path.segments.map(seg => distance(seg.p1, seg.p2)).filter(length => length > 0);
  if (lengths.length !== 12) return false;

  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const maxLength = Math.max(...lengths);
  const minLength = Math.min(...lengths);

  if (totalLength < 21.5 || totalLength > 24.5) return false;
  if (maxLength / Math.max(minLength, 0.01) > 4.8) return false;

  console.log(`[Malaysia Weld] Path ${path.id}: matched (${count} lines, ${width.toFixed(2)}x${height.toFixed(2)}, total=${totalLength.toFixed(2)})`);
  return true;
}

/**
 * 申远焊口。
 * 六组人工样本均为24条均匀短直线组成的闭合小圆，尺寸约6.5×6.5。
 */
export function ruleShenyuanWeld(path) {
  const segments = Array.isArray(path?.segments) ? path.segments : [];
  if (segments.length !== 24) return false;
  if (!segments.every(segment => (
    (segment?.type === 'line' || isLineVectorType(segment?.rawType)) &&
    segment.p1 && segment.p2
  ))) return false;

  const continuityTolerance = 0.25;
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    const next = segments[(index + 1) % segments.length];
    if (distance(current.p2, next.p1) > continuityTolerance) return false;
  }

  const bbox = calculateBoundingBox(path);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  if (width < 5.9 || width > 7.1 || height < 5.9 || height > 7.1) return false;

  const aspectRatio = height > 0 ? width / height : 0;
  if (aspectRatio < 0.94 || aspectRatio > 1.06) return false;

  const lengths = segments.map(segment => distance(segment.p1, segment.p2));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const averageLength = totalLength / lengths.length;
  const minLength = Math.min(...lengths);
  const maxLength = Math.max(...lengths);
  if (averageLength < 0.72 || averageLength > 1.0) return false;
  if (minLength < 0.5 || maxLength > 1.25) return false;
  if (maxLength / Math.max(minLength, 0.01) > 1.8) return false;
  if (totalLength < 18 || totalLength > 24) return false;

  console.log(`[申远焊口] Path ${path.id}: 匹配成功 (24线段, ${width.toFixed(2)}x${height.toFixed(2)}, 周长=${totalLength.toFixed(2)})`);
  return true;
}
