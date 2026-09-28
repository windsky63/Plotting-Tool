import { getVectorSegmentType } from './vectorTypeUtils';

/**
 * 管道识别工具
 * 用于从矢量元素中识别管道线段
 */

export class PipelineDetector {
  /**
   * @param {Array} vectors - 原始矢量元素数组 [type, x1, y1, x2, y2, color, width, id]
   * @param {Object} options - 配置选项
   */
  constructor(vectors, options = {}) {
    this.vectors = vectors || [];
    this.options = {
      // 不再进行线宽和长度过滤
      // 管道判断只基于：4根线段 + 闭合路径
      ...options
    };
  }

  /**
   * 识别管道线段
   * @returns {Array} 识别到的管道线段数组
   */
  detectPipelineSegments() {
    if (!this.vectors || this.vectors.length === 0) {
      return [];
    }

    const pipelineSegments = [];

    // 不做任何过滤，返回所有线段
    // 管道判断逻辑在 SimplePipelineDetector 中（按 Path 判断：4线段+闭合）
    this.vectors.forEach((vec, index) => {
      if (!Array.isArray(vec) || vec.length < 8) return;

      const [type, x1, y1, x2, y2, color, width, pathId] = vec;
      
      const length = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));

      pipelineSegments.push({
        vectorIndex: index,
        type: getVectorSegmentType(type),
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        color,
        width,
        pathId,
        length
      });
    });

    console.log(`🔍 管道线段提取完成: 总矢量 ${this.vectors.length}, 提取线段 ${pipelineSegments.length}`);

    return pipelineSegments;
  }

}

