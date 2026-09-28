/**
 * Path 类型分类器
 * 用于识别和分类矢量图中的不同对象类型（管道、焊点、标注线等）
 */

import { PipelineDetector } from './PipelineDetector';

/**
 * Path 类型枚举
 */
export const PathType = {
  UNKNOWN: 'unknown',           // 未知类型
  PIPELINE: 'pipeline',         // 管道
  WELD: 'weld',                 // 焊点
  DIMENSION_LINE: 'dimension',  // 尺寸线/标注线
  TEXT_ELEMENT: 'text',         // 文字相关元素
  SYMBOL: 'symbol',             // 符号（阀门、设备等）
  FLOW_ARROW: 'flow_arrow',     // 流向箭头
  DECORATION: 'decoration'      // 装饰性元素
};

/**
 * Path 特征分析器
 */
class PathFeatureAnalyzer {
  /**
   * 计算 Path 的几何特征
   * @param {Object} path - Path对象 { id, segments: [...], vectorIndices: [...] }
   * @returns {Object} - 特征对象
   */
  static analyzeFeatures(path) {
    if (!path || !path.segments || path.segments.length === 0) {
      return null;
    }

    const segments = path.segments;
    
    // 1. 基础统计
    const segmentCount = segments.length;
    const lineCount = segments.filter(s => s.type === 'line').length;
    const curveCount = segments.filter(s => s.type === 'curve').length;

    // 2. 线宽统计
    const widths = segments.map(s => s.width);
    const avgWidth = widths.reduce((sum, w) => sum + w, 0) / widths.length;
    const minWidth = Math.min(...widths);
    const maxWidth = Math.max(...widths);
    const widthVariance = this.calculateVariance(widths);

    // 3. 长度统计
    const lengths = segments.map(s => 
      Math.sqrt(Math.pow(s.x2 - s.x1, 2) + Math.pow(s.y2 - s.y1, 2))
    );
    const totalLength = lengths.reduce((sum, l) => sum + l, 0);
    const avgSegmentLength = totalLength / segmentCount;
    const maxSegmentLength = Math.max(...lengths);

    // 4. 边界框
    const allX = segments.flatMap(s => [s.x1, s.x2]);
    const allY = segments.flatMap(s => [s.y1, s.y2]);
    const bbox = {
      minX: Math.min(...allX),
      maxX: Math.max(...allX),
      minY: Math.min(...allY),
      maxY: Math.max(...allY)
    };
    bbox.width = bbox.maxX - bbox.minX;
    bbox.height = bbox.maxY - bbox.minY;
    bbox.area = bbox.width * bbox.height;

    // 5. 闭合性检查
    const isClosed = this.isClosedPath(segments);

    // 6. 紧凑度（周长平方 / 面积，圆形最小）
    const compactness = bbox.area > 0 
      ? Math.pow(totalLength, 2) / bbox.area 
      : Infinity;

    // 7. 连续性检查
    const continuityGaps = this.checkContinuity(segments);
    const isContinuous = continuityGaps.length === 0;

    // 8. 方向性分析
    const directionInfo = this.analyzeDirections(segments);

    // 9. 结构宽度 (针对双线管道)
    let structuralWidth = 0;
    if (segmentCount === 4) {
      // 找出两条短边（通常是截面线）
      const sortedLengths = [...lengths].sort((a, b) => a - b);
      // 取两条最短边的平均长度作为结构宽度
      structuralWidth = (sortedLengths[0] + sortedLengths[1]) / 2;
    }

    return {
      segmentCount,
      lineCount,
      curveCount,
      avgWidth,
      minWidth,
      maxWidth,
      widthVariance,
      totalLength,
      avgSegmentLength,
      maxSegmentLength,
      structuralWidth, // 新增：结构宽度
      bbox,
      isClosed,
      compactness,
      isContinuous,
      continuityGaps,
      directionInfo,
      segments // 保留原始线段数据
    };
  }

  /**
   * 检查是否为闭合路径
   */
  static isClosedPath(segments) {
    if (segments.length < 3) return false;
    
    const first = segments[0];
    const last = segments[segments.length - 1];
    const distance = Math.sqrt(
      Math.pow(last.x2 - first.x1, 2) + 
      Math.pow(last.y2 - first.y1, 2)
    );
    
    return distance < 5; // 起点和终点距离很近
  }

  /**
   * 检查路径连续性
   */
  static checkContinuity(segments, threshold = 2.0) {
    const gaps = [];
    
    for (let i = 0; i < segments.length - 1; i++) {
      const current = segments[i];
      const next = segments[i + 1];
      
      const distance = Math.sqrt(
        Math.pow(next.x1 - current.x2, 2) + 
        Math.pow(next.y1 - current.y2, 2)
      );
      
      if (distance > threshold) {
        gaps.push({
          index: i,
          distance,
          from: { x: current.x2, y: current.y2 },
          to: { x: next.x1, y: next.y1 }
        });
      }
    }
    
    return gaps;
  }

  /**
   * 分析线段方向
   */
  static analyzeDirections(segments) {
    const angles = segments.map(s => {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      return Math.atan2(dy, dx);
    });

    // 计算角度变化
    const angleChanges = [];
    for (let i = 0; i < angles.length - 1; i++) {
      let change = Math.abs(angles[i + 1] - angles[i]);
      // 规范化到 [0, π]
      if (change > Math.PI) change = 2 * Math.PI - change;
      angleChanges.push(change);
    }

    const avgAngleChange = angleChanges.length > 0
      ? angleChanges.reduce((sum, a) => sum + a, 0) / angleChanges.length
      : 0;

    // 检查是否主要是水平或垂直线段
    const horizontalCount = angles.filter(a => 
      Math.abs(a) < Math.PI / 6 || Math.abs(a) > 5 * Math.PI / 6
    ).length;
    const verticalCount = angles.filter(a => 
      Math.abs(Math.abs(a) - Math.PI / 2) < Math.PI / 6
    ).length;

    return {
      avgAngleChange,
      horizontalCount,
      verticalCount,
      isMainlyOrthogonal: (horizontalCount + verticalCount) / segments.length > 0.7
    };
  }

  /**
   * 计算方差
   */
  static calculateVariance(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((sum, d) => sum + d, 0) / values.length;
  }
}

/**
 * Path 类型分类器
 */
export class PathTypeClassifier {
  constructor(vectors, options = {}) {
    this.vectors = vectors || [];
    this.options = {
      // 管道识别参数：只需要闭合阈值，不再使用线宽/长度参数
      // 判断逻辑：4根线段 + 闭合路径 = 管道
      
      // 焊点识别参数（保留用于焊点判断）
      weldMaxSize: 50,
      weldMaxSegments: 20,
      
      // 尺寸线识别参数（保留用于尺寸线判断）
      dimensionMaxWidth: 0.5,
      
      ...options
    };

    // 缓存
    this.pathCache = new Map(); // pathId -> classification
  }

  /**
   * 对所有 Path 进行分类
   * @param {Array} paths - Path对象数组
   * @param {Set} weldPathIds - 已识别的焊点 pathId 集合（来自规则引擎）
   * @returns {Map} - pathId -> { type, confidence, features }
   */
  classifyAllPaths(paths, weldPathIds = new Set()) {
    const classifications = new Map();

    paths.forEach(path => {
      const classification = this.classifyPath(path, weldPathIds.has(path.id));
      classifications.set(path.id, classification);
    });

    // 输出统计信息
    this.logClassificationStats(classifications);

    return classifications;
  }

  /**
   * 对单个 Path 进行分类
   * @param {Object} path - Path对象
   * @param {boolean} isWeldByRule - 是否已被焊点规则识别
   * @returns {Object} - { type, confidence, features, reasons }
   */
  classifyPath(path, isWeldByRule = false) {
    // 分析特征
    const features = PathFeatureAnalyzer.analyzeFeatures(path);
    
    if (!features) {
      return {
        type: PathType.UNKNOWN,
        confidence: 0,
        features: null,
        reasons: ['特征分析失败']
      };
    }

    // 如果已被焊点规则识别，直接标记为焊点
    if (isWeldByRule) {
      return {
        type: PathType.WELD,
        confidence: 0.95,
        features,
        reasons: ['匹配焊点识别规则']
      };
    }

    // 依次检查各种类型
    // ⚠️ 顺序很重要！管道判断（4线段+闭合+结构宽度过滤）应该优先，
    // 因为它的几何特征最稳定
    const checks = [
      this.checkPipeline(features),      // 1. 优先：管道（4线段+闭合+结构宽度）
      this.checkFlowArrow(features),      // 2. 流向箭头 (3线段+闭合)
      this.checkWeld(features),           // 3. 焊点
      this.checkDimensionLine(features),  // 4. 尺寸线
      this.checkSymbol(features)          // 5. 符号
    ];

    // 找出置信度最高的分类
    const bestMatch = checks.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    );

    return bestMatch;
  }

  /**
   * 检查是否为流向箭头
   */
  checkFlowArrow(features) {
    const reasons = [];
    let score = 0;

    // 模式1: 经典三角形箭头 (3线段 + 闭合)
    if (features.segmentCount === 3 && features.isClosed) {
      score += 0.5;
      reasons.push('三角形 (3线段+闭合)');

      // 尺寸极小
      const width = features.bbox.width;
      const height = features.bbox.height;
      // 箭头通常很小 (比如 < 10x10)
      if (width < 10 && height < 10) {
        score += 0.3;
        reasons.push(`尺寸微小 (${width.toFixed(1)}x${height.toFixed(1)})`);
      } else {
        reasons.push(`尺寸偏大 (${width.toFixed(1)}x${height.toFixed(1)})`);
      }
  
      // 宽高比合理 (不会太扁或太细)
      const ratio = height > 0 ? width / height : 0;
      if (ratio > 0.3 && ratio < 3.0) {
        score += 0.2;
        reasons.push(`比例合理 (${ratio.toFixed(2)})`);
      }
    } 
    // 模式2: 填充型箭头 (多线段密集填充)
    // 针对用户反馈：线段25，密度高，尺寸小
    else if (features.segmentCount > 8) {
       const area = features.bbox.area;
       const density = area > 0 ? features.totalLength / area : 0;
       
       // 尺寸限制：箭头头部通常较小 (< 20x20)
       const isSmallSize = features.bbox.width < 20 && features.bbox.height < 20;
       
       // 密度判断：填充区域密度通常较高 (> 1.5)
       // 例如：3.5x10的区域里有124长度，密度≈3.5
       if (isSmallSize && density > 1.5) {
         score = 0.85; // 给一个较高的基础分，确保超过尺寸线
         reasons.push(`填充型箭头 (密度 ${density.toFixed(1)})`);
         reasons.push(`尺寸小 (${features.bbox.width.toFixed(1)}x${features.bbox.height.toFixed(1)})`);
         
         // 检查是否为极小正方形 (可能是实心焊点)
         const width = features.bbox.width;
         const height = features.bbox.height;
         const ratio = height > 0 ? width / height : 0;
         
         // 如果是极小正方形 (<8x8, 比例接近1)，很可能是实心焊点，降低流向箭头置信度
         if (width < 8 && height < 8 && ratio > 0.8 && ratio < 1.2 && density > 5.0) {
            score = 0.6; // 降分，让位给焊点识别
            reasons.push('疑似实心焊点(降权)');
         } else if (density > 3.0) {
           // 只有不被判定为疑似焊点时，才因高密度加分
           score += 0.1;
           reasons.push('高密度填充');
         }
       }
    }

    return {
      type: PathType.FLOW_ARROW,
      confidence: score,
      features,
      reasons: reasons.length > 0 ? reasons : ['不符合流向箭头特征']
    };
  }

  /**
   * 检查是否为尺寸线/标注线
   */
  checkDimensionLine(features) {
    const reasons = [];
    let score = 0;

    // 1. 线宽很细
    if (features.avgWidth < this.options.dimensionMaxWidth) {
      score += 0.4;
      reasons.push(`线宽细 (${features.avgWidth.toFixed(2)})`);
    }

    // 2. 线段数量少
    if (features.segmentCount <= 5) {
      score += 0.2;
      reasons.push(`线段少 (${features.segmentCount})`);
    }

    // 3. 长度中等
    if (features.totalLength > 10 && features.totalLength < 200) {
      score += 0.2;
      reasons.push(`长度适中 (${features.totalLength.toFixed(1)})`);
    }

    // 4. 连续性好
    if (features.isContinuous) {
      score += 0.2;
      reasons.push('路径连续');
    }

    // 5. 负面特征：线段过多 (尺寸线通常很简单)
    if (features.segmentCount > 10) {
      score -= 0.5;
      reasons.push(`线段过多 (${features.segmentCount})`);
    }

    return {
      type: PathType.DIMENSION_LINE,
      confidence: score,
      features,
      reasons
    };
  }

  /**
   * 检查是否为焊点
   */
  checkWeld(features) {
    const reasons = [];
    let score = 0;

    // 新增：高密度填充型焊点识别 (针对 4x4, 95段线 这种实心点)
    // 这种通常是 CAD 图纸中的实心焊点
    const width = features.bbox.width;
    const height = features.bbox.height;
    const ratio = height > 0 ? width / height : 0;
    
    // 特征：极小尺寸 (<8) + 正方形 (0.8-1.2) + 高线段数(>15, 表示填充)
    if (width < 8 && height < 8 && 
        ratio > 0.8 && ratio < 1.2 && 
        features.segmentCount > 15) {
        
      score = 0.98; // 给予极高置信度，超过流向箭头
      reasons.push(`填充型焊点 (尺寸${width.toFixed(1)}x${height.toFixed(1)}, 线段${features.segmentCount})`);
      
      return {
        type: PathType.WELD,
        confidence: score,
        features,
        reasons
      };
    }

    // 1. 闭合或近闭合
    if (features.isClosed) {
      score += 0.3;
      reasons.push('闭合路径');
    }

    // 2. 尺寸小
    if (features.bbox.width < this.options.weldMaxSize && 
        features.bbox.height < this.options.weldMaxSize) {
      score += 0.3;
      reasons.push(`尺寸小 (${features.bbox.width.toFixed(1)}×${features.bbox.height.toFixed(1)})`);
    }

    // 3. 紧凑
    if (features.compactness < 50) {
      score += 0.2;
      reasons.push(`紧凑 (${features.compactness.toFixed(1)})`);
    }

    // 4. 线段数量适中
    if (features.segmentCount >= 3 && features.segmentCount <= this.options.weldMaxSegments) {
      score += 0.2;
      reasons.push(`线段数 (${features.segmentCount})`);
    }

    return {
      type: PathType.WELD,
      confidence: score,
      features,
      reasons
    };
  }

  /**
   * 检查是否为管道
   * 当前逻辑：4根线段 + 闭合路径 + 结构宽度在 1.0~2.0
   */
  checkPipeline(features) {
    const reasons = [];
    let score = 0;

    // 核心规则：4根线段组成的闭合路径，且结构宽度符合细管范围
    const is4Segments = features.segmentCount === 4;
    const isClosed = features.isClosed;

    // 1. 必须是4根线段
    if (!is4Segments) {
      return {
        type: PathType.PIPELINE,
        confidence: 0,
        features,
        reasons: [`线段数不是4 (${features.segmentCount})`]
      };
    }
    score += 0.5;
    reasons.push('线段数=4');

    // 2. 必须闭合
    if (!isClosed) {
      return {
        type: PathType.PIPELINE,
        confidence: 0,
        features,
        reasons: ['线段数=4 但不闭合']
      };
    }
    score += 0.5;
    reasons.push('闭合路径');

    // 3. 管径检查 (必须在 1.0 ~ 2.0 之间)
    // 避免识别到过细的标注线或过粗的符号框
    if (features.structuralWidth < 1.0) {
      return {
        type: PathType.PIPELINE,
        confidence: 0,
        features,
        reasons: [`管径过小 (${features.structuralWidth.toFixed(2)} < 1.0)`]
      };
    }
    if (features.structuralWidth > 2.0) {
      return {
        type: PathType.PIPELINE,
        confidence: 0,
        features,
        reasons: [`管径过大 (${features.structuralWidth.toFixed(2)} > 2.0)`]
      };
    }
    reasons.push(`管径合适 (${features.structuralWidth.toFixed(2)})`);

    // ✅ 符合条件：4根线段 + 闭合 + 结构宽度合适 = 管道
    return {
      type: PathType.PIPELINE,
      confidence: 1.0,  // 完全符合，置信度100%
      features,
      reasons
    };
  }

  /**
   * 检查是否为符号（阀门、设备等）
   */
  checkSymbol(features) {
    const reasons = [];
    let score = 0;

    // 1. 中等尺寸
    const size = Math.max(features.bbox.width, features.bbox.height);
    if (size > 15 && size < 80) {
      score += 0.3;
      reasons.push(`尺寸适中 (${size.toFixed(1)})`);
    }

    // 2. 包含曲线
    if (features.curveCount > 0) {
      score += 0.3;
      reasons.push(`包含曲线 (${features.curveCount})`);
    }

    // 3. 线段数量适中
    if (features.segmentCount >= 5 && features.segmentCount <= 30) {
      score += 0.2;
      reasons.push(`线段数适中 (${features.segmentCount})`);
    }

    // 4. 紧凑但不闭合
    if (features.compactness < 100 && !features.isClosed) {
      score += 0.2;
      reasons.push('结构紧凑');
    }

    return {
      type: PathType.SYMBOL,
      confidence: score,
      features,
      reasons
    };
  }

  /**
   * 输出分类统计信息
   */
  logClassificationStats(classifications) {
    const stats = new Map();
    
    classifications.forEach(classification => {
      const type = classification.type;
      if (!stats.has(type)) {
        stats.set(type, { count: 0, totalConfidence: 0 });
      }
      const stat = stats.get(type);
      stat.count++;
      stat.totalConfidence += classification.confidence;
    });

    console.log('📊 Path 类型分类统计:');
    stats.forEach((stat, type) => {
      const avgConfidence = stat.count > 0 ? stat.totalConfidence / stat.count : 0;
      console.log(`  ${type}: ${stat.count} 个 (平均置信度: ${avgConfidence.toFixed(2)})`);
    });
  }

  /**
   * 获取指定类型的所有 Path ID
   * @param {Map} classifications - 分类结果
   * @param {string} type - Path类型
   * @param {number} minConfidence - 最小置信度阈值
   * @returns {Set} - pathId集合
   */
  static getPathIdsByType(classifications, type, minConfidence = 0.5) {
    const pathIds = new Set();
    
    classifications.forEach((classification, pathId) => {
      if (classification.type === type && classification.confidence >= minConfidence) {
        pathIds.add(pathId);
      }
    });
    
    return pathIds;
  }

  /**
   * 获取管道 Path ID 集合
   */
  static getPipelinePathIds(classifications, minConfidence = 0.5) {
    return this.getPathIdsByType(classifications, PathType.PIPELINE, minConfidence);
  }

  /**
   * 获取焊点 Path ID 集合
   */
  static getWeldPathIds(classifications, minConfidence = 0.5) {
    return this.getPathIdsByType(classifications, PathType.WELD, minConfidence);
  }
}
