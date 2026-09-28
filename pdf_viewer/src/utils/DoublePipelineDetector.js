/**
 * 双线管道识别器（已弃用）
 * ⚠️ 此文件包含复杂的置信度评分逻辑（线宽、长度、紧凑度等）
 * 
 * 当前推荐使用：SimplePipelineDetector
 * 判断逻辑：4根线段 + 闭合路径 = 管道
 * 
 * 保留此文件仅作为参考或高级场景使用
 */

import { groupVectorsIntoPathsStructured } from './WeldDetector';

export class DoublePipelineDetector {
  /**
   * @param {Array} vectors - 原始矢量元素数组 [type, x1, y1, x2, y2, color, width, id]
   * @param {Object} options - 配置选项
   */
  constructor(vectors, options = {}) {
    this.vectors = vectors || [];
    this.options = {
      minLineWidth: 0.2,        // 最小线宽（双线通常较细）
      maxLineWidth: 3.0,        // 最大线宽
      minSegmentLength: 3,      // 单个线段最小长度
      minTotalLength: 10,       // Path 总长度最小值
      segmentCountRange: [3, 6], // 线段数量范围（通常是4，允许3-6的变化）
      maxCompactness: 200,      // 最大紧凑度（排除圆形、方形符号）
      ...options
    };
  }

  /**
   * 识别双线管道
   * @returns {Array} - 管道 Path 列表
   */
  detectDoublePipelines() {
    if (!this.vectors || this.vectors.length === 0) {
      return [];
    }

    console.log('🔍 开始双线管道识别...');

    // 按 Path ID 分组
    const paths = groupVectorsIntoPathsStructured(this.vectors);
    console.log(`  📊 共 ${paths.length} 个 Path`);

    const pipelines = [];
    const {
      minLineWidth,
      maxLineWidth,
      minSegmentLength,
      minTotalLength,
      segmentCountRange,
      maxCompactness
    } = this.options;

    // 统计数据
    let filteredBySegmentCount = 0;
    let filteredByLineWidth = 0;
    let filteredByLength = 0;
    let filteredByCompactness = 0;

    paths.forEach(path => {
      const segments = path.segments;
      const segmentCount = segments.length;

      // 1. 线段数量检查（管道通常是4条线段）
      if (segmentCount < segmentCountRange[0] || segmentCount > segmentCountRange[1]) {
        filteredBySegmentCount++;
        return;
      }

      // 2. 线宽检查
      const avgWidth = segments.reduce((sum, s) => sum + s.width, 0) / segmentCount;
      if (avgWidth < minLineWidth || avgWidth > maxLineWidth) {
        filteredByLineWidth++;
        return;
      }

      // 3. 长度检查
      const totalLength = segments.reduce((sum, s) => {
        const len = Math.sqrt(
          Math.pow(s.x2 - s.x1, 2) + 
          Math.pow(s.y2 - s.y1, 2)
        );
        return sum + len;
      }, 0);

      if (totalLength < minTotalLength) {
        filteredByLength++;
        return;
      }

      // 4. 几何特征检查
      const bbox = this.calculateBoundingBox(segments);
      const compactness = bbox.area > 0 
        ? Math.pow(totalLength, 2) / bbox.area 
        : Infinity;

      // 排除过于紧凑的图形（圆形、方形符号）
      if (compactness < maxCompactness) {
        filteredByCompactness++;
        return;
      }

      // 5. 双线特征检查（平行性）
      const isDoubleLine = this.checkDoubleLineFeature(segments);

      pipelines.push({
        pathId: path.id,
        segmentCount,
        avgWidth,
        totalLength,
        bbox,
        compactness,
        isDoubleLine,
        vectorIndices: path.vectorIndices,
        segments: path.segments,
        confidence: this.calculateConfidence(segmentCount, avgWidth, totalLength, isDoubleLine)
      });
    });

    console.log(`✅ 双线管道识别完成:`);
    console.log(`  🎯 识别到管道: ${pipelines.length}`);
    console.log(`  📊 过滤统计:`);
    console.log(`    - 线段数量不符: ${filteredBySegmentCount}`);
    console.log(`    - 线宽不符: ${filteredByLineWidth}`);
    console.log(`    - 长度不足: ${filteredByLength}`);
    console.log(`    - 过于紧凑: ${filteredByCompactness}`);

    if (pipelines.length > 0) {
      console.log(`  📊 管道统计:`);
      const avgConfidence = pipelines.reduce((sum, p) => sum + p.confidence, 0) / pipelines.length;
      console.log(`    - 平均置信度: ${avgConfidence.toFixed(2)}`);
      
      // 按线段数量分组统计
      const countGroups = {};
      pipelines.forEach(p => {
        countGroups[p.segmentCount] = (countGroups[p.segmentCount] || 0) + 1;
      });
      console.log(`    - 线段数量分布:`, countGroups);
    }

    return pipelines;
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
    
    const width = maxX - minX;
    const height = maxY - minY;
    
    return {
      minX, maxX, minY, maxY,
      width, height,
      area: width * height
    };
  }

  /**
   * 检查是否具有双线特征（两条平行线）
   */
  checkDoubleLineFeature(segments) {
    if (segments.length !== 4) return false;

    // 对于4线段，检查是否有两组平行线
    // 简化检查：看是否有两对线段方向相近
    const angles = segments.map(s => {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      return Math.atan2(dy, dx);
    });

    // 按角度排序
    const sortedAngles = [...angles].sort();
    
    // 检查是否有两对相近的角度
    const angleDiffs = [];
    for (let i = 0; i < sortedAngles.length - 1; i++) {
      angleDiffs.push(Math.abs(sortedAngles[i + 1] - sortedAngles[i]));
    }

    // 如果有两对角度差异很小（< 15度），认为是双线
    const smallDiffs = angleDiffs.filter(d => d < Math.PI / 12).length;
    return smallDiffs >= 2;
  }

  /**
   * 计算置信度
   */
  calculateConfidence(segmentCount, avgWidth, totalLength, isDoubleLine) {
    let score = 0;

    // 线段数量为4：最高分
    if (segmentCount === 4) {
      score += 0.4;
    } else if (segmentCount >= 3 && segmentCount <= 5) {
      score += 0.2;
    }

    // 线宽合理
    if (avgWidth >= 0.3 && avgWidth <= 2.0) {
      score += 0.2;
    } else if (avgWidth >= 0.2 && avgWidth <= 3.0) {
      score += 0.1;
    }

    // 长度合理
    if (totalLength >= 20) {
      score += 0.2;
    } else if (totalLength >= 10) {
      score += 0.1;
    }

    // 双线特征
    if (isDoubleLine) {
      score += 0.2;
    }

    return score;
  }

  /**
   * 获取管道的矢量索引集合
   * @param {Array} pipelines - 识别到的管道列表
   * @param {number} minConfidence - 最小置信度阈值
   * @returns {Set} - 矢量索引集合
   */
  static getPipelineVectorIndices(pipelines, minConfidence = 0.5) {
    const indices = new Set();
    
    pipelines.forEach(pipeline => {
      if (pipeline.confidence >= minConfidence) {
        pipeline.vectorIndices.forEach(idx => indices.add(idx));
      }
    });
    
    return indices;
  }

  /**
   * 获取管道的 Path ID 集合
   * @param {Array} pipelines - 识别到的管道列表
   * @param {number} minConfidence - 最小置信度阈值
   * @returns {Set} - Path ID 集合
   */
  static getPipelinePathIds(pipelines, minConfidence = 0.5) {
    const pathIds = new Set();
    
    pipelines.forEach(pipeline => {
      if (pipeline.confidence >= minConfidence) {
        pathIds.add(pipeline.pathId);
      }
    });
    
    return pathIds;
  }
}

