import { groupVectorsIntoPathsStructured, detectWelds } from './WeldDetector';
import { WeldRuleManager } from './WeldRuleManager';
import { PathTypeClassifier, PathType } from './PathTypeClassifier';

/**
 * 对象识别器
 * 用于识别矢量图中的逻辑对象（如整根管道、焊点等）
 * 基于 Path ID 进行分组（复刻 PyMuPDF 的 path_idx 逻辑）
 */
export class ObjectRecognizer {
  constructor(vectors, spatialIndex) {
    this.vectors = vectors;
    this.spatialIndex = spatialIndex;
    
    // 建立 ID 索引: pathId -> Set(vectorIndices)
    this.idMap = new Map();
    this.buildIdIndex();
    
    // 焊点识别
    this.weldRuleManager = new WeldRuleManager();
    this.weldRuleManager.loadConfig(); // 加载保存的配置
    this.detectedWelds = [];
    this.weldIndicesSet = new Set(); // 快速查找
    
    // Path 类型分类
    this.pathTypeClassifier = new PathTypeClassifier(vectors);
    this.pathClassifications = new Map(); // pathId -> { type, confidence, features }
    
    // 🔧 不在构造函数中立即执行焊点识别
    // 因为可能需要传入 OCR 文字区域进行过滤
    // 外部（如 VectorVisualizer）会在准备好 textRegions 后调用 detectWelds()
    // this.detectWelds();
  }

  /**
   * 构建 ID 索引
   */
  buildIdIndex() {
    this.vectors.forEach((vec, index) => {
      if (!Array.isArray(vec) || vec.length < 8) return; // 确保包含 ID 字段
      
      // 格式: [type, x1, y1, x2, y2, color, width, id]
      const id = vec[7];
      
      if (!this.idMap.has(id)) {
        this.idMap.set(id, new Set());
      }
      this.idMap.get(id).add(index);
    });
    
    console.log(`📦 ID索引构建完成，Path数量: ${this.idMap.size}`);
  }

  /**
   * 识别点击对象（查找具有相同 ID 的所有线段）
   * @param {number} startIndex - 点击的线段索引
   * @returns {Set|Object} - 属于同一个对象的所有线段索引，或包含类型信息的对象
   */
  recognizeObject(startIndex) {
    const startVec = this.vectors[startIndex];
    if (!startVec || startVec.length < 8) return new Set([startIndex]);
    
    const targetId = startVec[7];
    const indices = this.idMap.get(targetId);
    
    if (indices) {
      // 获取该 Path 的类型信息
      const classification = this.pathClassifications.get(targetId);
      
      if (classification) {
        console.log(`🎯 找到 Path ID ${targetId}，包含 ${indices.size} 条线段 [类型: ${classification.type}, 置信度: ${classification.confidence.toFixed(2)}]`);
      } else {
        console.log(`🎯 找到 Path ID ${targetId}，包含 ${indices.size} 条线段`);
      }
      
      return indices;
    }
    
    return new Set([startIndex]);
  }

  /**
   * 获取指定 Path 的类型信息
   * @param {number} pathId - Path ID
   * @returns {Object|null} - 类型信息 { type, confidence, features, reasons }
   */
  getPathType(pathId) {
    return this.pathClassifications.get(pathId) || null;
  }

  /**
   * 根据矢量索引获取 Path 类型
   * @param {number} vectorIndex - 矢量索引
   * @returns {Object|null} - 类型信息
   */
  getPathTypeByVectorIndex(vectorIndex) {
    const vec = this.vectors[vectorIndex];
    if (!vec || vec.length < 8) return null;
    
    const pathId = vec[7];
    return this.getPathType(pathId);
  }

  /**
   * 检查指定 Path 是否为管道
   * @param {number} pathId - Path ID
   * @param {number} minConfidence - 最小置信度阈值
   * @returns {boolean}
   */
  isPipeline(pathId, minConfidence = 0.5) {
    const classification = this.pathClassifications.get(pathId);
    return classification && 
           classification.type === PathType.PIPELINE && 
           classification.confidence >= minConfidence;
  }

  /**
   * 执行焊点识别和 Path 类型分类
   * @param {Array} ocrTextRegions - OCR识别的文字区域（已废弃，不再使用）
   */
  detectWelds(ocrTextRegions = null) {
    console.log('🔍 开始焊点识别和 Path 类型分类...');
    
    // 将向量数据按 Path ID 分组
    const paths = groupVectorsIntoPathsStructured(this.vectors);
    console.log(`📊 共 ${paths.length} 个路径`);
    
    // 获取启用的规则
    const enabledRules = this.weldRuleManager.getEnabledRules();
    console.log(`✅ 启用的规则数: ${enabledRules.length}`);
    
    // 执行焊点检测（不再使用OCR文字区域过滤）
    this.detectedWelds = detectWelds(paths, enabledRules, null);
    
    // 建立快速查找索引
    this.weldIndicesSet.clear();
    const weldPathIds = new Set();
    this.detectedWelds.forEach(weld => {
      weld.vectorIndices.forEach(idx => this.weldIndicesSet.add(idx));
      weldPathIds.add(weld.pathId);
    });
    
    if (this.detectedWelds.length > 0) {
      console.log(`🎯 检测到 ${this.detectedWelds.length} 个焊点对象 (显示前5个):`);
      this.detectedWelds.slice(0, 5).forEach((weld, i) => {
        console.log(`  ${i + 1}. Path ID ${weld.pathId} - ${weld.ruleName} (${weld.vectorIndices.length}条线段)`);
      });
      if (this.detectedWelds.length > 5) {
        console.log(`  ... 以及其他 ${this.detectedWelds.length - 5} 个焊点`);
      }
    } else {
      console.log('⚠️ 未检测到符合当前规则的焊点');
    }

    // 执行 Path 类型分类
    console.log('🔍 开始 Path 类型分类...');
    this.pathClassifications = this.pathTypeClassifier.classifyAllPaths(paths, weldPathIds);
    console.log(`✅ Path 类型分类完成，共分类 ${this.pathClassifications.size} 个路径`);
  }

  /**
   * 判断某个向量索引是否是焊点的一部分
   */
  isWeldSegment(vectorIndex) {
    return this.weldIndicesSet.has(vectorIndex);
  }

  /**
   * 获取所有焊点
   */
  getDetectedWelds() {
    return this.detectedWelds;
  }

  /**
   * 获取规则管理器（用于UI配置）
   */
  getRuleManager() {
    return this.weldRuleManager;
  }

  /**
   * 获取所有管道 Path ID
   * @param {number} minConfidence - 最小置信度阈值
   * @returns {Set} - 管道 pathId 集合
   */
  getPipelinePathIds(minConfidence = 0.5) {
    return PathTypeClassifier.getPipelinePathIds(this.pathClassifications, minConfidence);
  }

  /**
   * 获取所有分类结果
   * @returns {Map} - pathId -> classification
   */
  getAllClassifications() {
    return this.pathClassifications;
  }

  /**
   * 重新执行焊点识别（规则变更后调用）
   * @param {Array} ocrTextRegions - OCR识别的文字区域（已废弃，不再使用）
   */
  redetectWelds(ocrTextRegions = null) {
    this.weldRuleManager.saveConfig();
    this.detectWelds(null);
  }

  /**
   * 将OCR detections转换为文字区域格式
   * @param {Array} detections - OCR检测结果
   * @param {Object} pageSize - 页面尺寸 {width, height}
   * @returns {Array} - 文字区域数组，格式: [{minX, minY, maxX, maxY}, ...]
   */
  static convertOCRDetectionsToTextRegions(detections, pageSize) {
    const pageWidth = pageSize?.width || 0;
    const pageHeight = pageSize?.height || 0;
    const textRegions = [];

    if (pageWidth > 0 && pageHeight > 0) {
      textRegions.__pageBounds = {
        minX: 0,
        minY: 0,
        maxX: pageWidth,
        maxY: pageHeight
      };
    }

    if (!detections || detections.length === 0) {
      return textRegions;
    }
    
    detections.forEach(detection => {
      if (!detection.box || !Array.isArray(detection.box) || detection.box.length !== 4) {
        return;
      }

      // 判断是否为相对坐标（0-1）
      const maxCoord = Math.max(...detection.box.flat());
      const isRelative = maxCoord <= 1.1;

      if (isRelative && (!pageWidth || !pageHeight)) {
        return;
      }

      const xCoords = detection.box.map(point => isRelative ? point[0] * pageWidth : point[0]);
      const yCoords = detection.box.map(point => isRelative ? point[1] * pageHeight : point[1]);
      
      const minX = Math.min(...xCoords);
      const maxX = Math.max(...xCoords);
      const minY = Math.min(...yCoords);
      const maxY = Math.max(...yCoords);
      
      // 🎯 添加 padding (缓冲区域)，确保紧贴边缘的焊点也能被过滤
      const padding = 3.0;

      textRegions.push({
        minX: minX - padding,
        minY: minY - padding,
        maxX: maxX + padding,
        maxY: maxY + padding,
        text: detection.text || ''
      });
    });
    
    console.log(`📝 转换了 ${textRegions.length} 个OCR文字区域`);
    return textRegions;
  }
}
