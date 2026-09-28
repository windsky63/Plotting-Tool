/**
 * 多页批量处理服务
 * 实现：多页矢量提取 → 多页OCR文字识别 → 多页焊点识别 → 多页批量编号
 */

import { VectorExtractionUtils } from '../utils/vectorExtractionUtils';
import { VectorSpatialIndex } from '../utils/VectorSpatialIndex';
import { ObjectRecognizer } from '../utils/ObjectRecognizer';
import {
  filterWeldsOutsideTextRegions,
  convertTextDetectionToRegion,
  isPointInRegion
} from '../utils/WeldTextPositionUtils';
import { calculateWeldLayout, PDF_LAYOUT_BASE_SCALE } from '../utils/WeldLayoutEngine';
import { associateWeldsWithSingleSegmentVectors } from '../utils/PipelineNetworkUtils';
import { PathTypeClassifier, PathType } from '../utils/PathTypeClassifier';
import { groupVectorsIntoPathsStructured } from '../utils/WeldDetector';
import { analyzePipelineTopology } from '../utils/PipelineTopologyAnalyzer';
import {
  getAnnotationFrameSizeMode,
  resolveAnnotationFrameSize,
  scaleAnnotationValue
} from '../utils/pageAnnotationScale';
import {
  resolveBatchSplitUpperContent,
  extractDiameterMaterialSizesMm,
  convertMaterialSizeMmToIntegerInch,
  extractJointTypeFromMaterialDescription
} from '../utils/batchAnnotationContentUtils';
import {
  extractWeldedSupportWelds,
  extractStaticGroundingNotices,
  extractPositioningBlockNotices,
  findWeldedSupportCode,
  isStaticGroundingText,
  isStaticGroundingRetryHint,
  isPositioningBlockText
} from '../utils/weldedSupportRecognitionUtils';
import {
  applySharedWeldCandidateFilters,
  splitWeldsByConnectionConfidence
} from '../utils/weldCandidateQualityUtils';
import { buildSpatiallyContinuousWeldSequence } from '../utils/spatialWeldSequenceUtils';
import {
  sanitizeRecognizedPipelineNumber,
  enrichTextDetectionResult,
  buildPipelineStats,
  getPipelineStatsSummary,
  buildPipelineComparison,
  exportPipelineStatsCSV as exportPipelineStatsCSVFile,
  exportPipelineComparisonCSV as exportPipelineComparisonCSVFile
} from '../utils/pipelineDetectionUtils';
import ocrService from './ocrService';
import { getCanonicalWeldDisplayNumber } from '../utils/weldDisplayNumberUtils';
import { detectElbowCandidates } from '../utils/ElbowDetector';
import { detectTeeCandidates, detectBranchOutletCandidates } from '../utils/TeeDetector';
import {
  detectRadialVectorFittingCandidates,
  mergeRadialVectorFittingCandidates
} from '../utils/RadialVectorFittingDetector';
import { detectValveCandidates } from '../utils/ValveDetector';
import { fuseRuleAndAiWelds, getAiMergeDistance, getWeldPoint, AI_RULE_HIT_RADIUS } from '../utils/weldAiFusion';

class MultiPageBatchService {
  constructor() {
    // 存储多页处理结果
    this.pageVectors = {};      // 页面矢量数据 {pageNum: vectors[]}
    this.pagePdfSizes = {};     // PDF.js scale=1 页面尺寸（PDF point）
    this.pageTextDetections = {}; // 页面OCR数据 {pageNum: {detections, page_info}}
    this.pageWelds = {};        // 页面焊点数据 {pageNum: welds[]}
    this.pageWeldReviewCandidates = {};
    this.pageWeldRecognitionDiagnostics = {};
    this.pageAiWeldDetections = {};
    this.pageAiWeldDiagnostics = {};
    this.pageFittings = {};     // 页面管件识别及焊点映射 {pageNum: candidates[]}
    this.pageSpecialWeldNotices = {};
    this.pageSpecialWeldTextDetections = {};
    this.pageSupportMaterialTextDetections = {};
    this.pagePipelines = {};    // 页面管道数据 {pageNum: {pipelines, mainPipes, branchPipes, topology, ...}}
    this.allWelds = [];         // 所有页面的焊点汇总
    this.allWeldsNumbered = []; // 所有页面的焊点汇总（带智能编号）
    this.pipelineStats = [];    // 管线号核对统计
    this.pipelineReferenceData = null; // Excel 基准数据
    this.pipelineComparison = null; // 对账结果
    this.pendingBatchAnnotationRule = null; // 多段起止修正后继续使用的多页标注配置
    this.activeBatchRunId = null; // 同一次多页生成及后续补点/顺序修正共用
    this.weldRecognitionArea = null;
    
    // 🔧 缓存（用于避免重复识别）
    this.pageRecognizers = {};   // 页面识别器缓存 {pageNum: ObjectRecognizer}
    this.pagePipelineCache = new Map(); // 管道识别结果缓存 {pageNum: {allPipelines, tees}}
    
    // 处理状态
    this.isProcessing = false;
    this.currentStep = null;
    this.progress = { current: 0, total: 0, step: '' };
    
    // 回调函数
    this.onProgress = null;
    this.onStepChange = null;
    this.onError = null;
  }

  getPageInfo(pageNum, vectors = []) {
    const textData = this.pageTextDetections?.[pageNum];
    const textPageInfo = textData?.page_info;
    const textWidth = textPageInfo?.page_width || textPageInfo?.width || 0;
    const textHeight = textPageInfo?.page_height || textPageInfo?.height || 0;
    if (textWidth > 0 && textHeight > 0) {
      return {
        ...textPageInfo,
        page_width: textWidth,
        page_height: textHeight
      };
    }

    let maxX = 0;
    let maxY = 0;
    (vectors || []).forEach(vector => {
      if (Array.isArray(vector)) {
        const nums = vector.filter(value => typeof value === 'number');
        for (let i = 0; i < nums.length; i += 2) {
          maxX = Math.max(maxX, nums[i] || 0);
          maxY = Math.max(maxY, nums[i + 1] || 0);
        }
        return;
      }
      if (vector && typeof vector === 'object') {
        ['x1', 'x2', 'cx', 'x'].forEach(key => {
          if (typeof vector[key] === 'number') maxX = Math.max(maxX, vector[key] + (vector.r || 0));
        });
        ['y1', 'y2', 'cy', 'y'].forEach(key => {
          if (typeof vector[key] === 'number') maxY = Math.max(maxY, vector[key] + (vector.r || 0));
        });
      }
    });

    if (maxX > 0 && maxY > 0) {
      return {
        page_width: maxX * 1.1,
        page_height: maxY * 1.1,
        _fromVectors: true
      };
    }

    return null;
  }

  isWeldInRecognitionArea(weld, area, pageInfo) {
    if (!area || !pageInfo || !weld?.center) return true;

    const pageWidth = pageInfo.page_width || pageInfo.width || 0;
    const pageHeight = pageInfo.page_height || pageInfo.height || 0;
    if (!pageWidth || !pageHeight) return true;

    const minX = (area.x || 0) * pageWidth;
    const minY = (area.y || 0) * pageHeight;
    const maxX = minX + (area.width || 0) * pageWidth;
    const maxY = minY + (area.height || 0) * pageHeight;

    return weld.center.x >= minX &&
      weld.center.x <= maxX &&
      weld.center.y >= minY &&
      weld.center.y <= maxY;
  }

  /**
   * 设置进度回调
   */
  setCallbacks({ onProgress, onStepChange, onError }) {
    this.onProgress = onProgress;
    this.onStepChange = onStepChange;
    this.onError = onError;
  }

  /**
   * 更新进度
   */
  updateProgress(current, total, step) {
    this.progress = { current, total, step };
    if (this.onProgress) {
      this.onProgress(current, total, step);
    }
  }

  /**
   * 更新步骤
   */
  updateStep(step) {
    this.currentStep = step;
    if (this.onStepChange) {
      this.onStepChange(step);
    }
  }

  /**
   * 报告错误
   */
  reportError(error, page = null) {
    console.error(`❌ 多页处理错误${page ? ` (第${page}页)` : ''}:`, error);
    if (this.onError) {
      this.onError(error, page);
    }
  }

  /**
   * Release geometry helpers that are expensive to keep but are not part of
   * the persisted recognition result. Welds, fittings, text and numbering
   * remain available; a later re-recognition simply rebuilds these helpers.
   */
  releaseTransientRecognitionCaches(pageNumbers = null) {
    const targets = Array.isArray(pageNumbers)
      ? pageNumbers.map(Number).filter(Number.isFinite)
      : Object.keys(this.pageRecognizers || {}).map(Number).filter(Number.isFinite);
    let released = 0;
    targets.forEach(pageNum => {
      if (this.pageRecognizers?.[pageNum]) {
        delete this.pageRecognizers[pageNum];
        released += 1;
      }
    });
    if (released > 0) {
      console.log(`[MultiPage] 已释放 ${released} 页焊点识别器和空间索引`);
    }
    return released;
  }

  /**
   * 重置状态
   */
  reset() {
    this.pageVectors = {};
    this.pagePdfSizes = {};
    this.pageTextDetections = {};
    this.pageWelds = {};
    this.pageWeldReviewCandidates = {};
    this.pageWeldRecognitionDiagnostics = {};
    this.pageAiWeldDetections = {};
    this.pageAiWeldDiagnostics = {};
    this.pageFittings = {};
    this.pageSpecialWeldNotices = {};
    this.pageSpecialWeldTextDetections = {};
    this.pageSupportMaterialTextDetections = {};
    this.pagePipelines = {};
    this.allWelds = [];
    this.allWeldsNumbered = [];
    this.pipelineStats = [];
    this.pipelineReferenceData = null;
    this.pipelineComparison = null;
    this.pendingBatchAnnotationRule = null;
    this.activeBatchRunId = null;
    this.weldRecognitionArea = null;
    
    // 🔧 清理缓存
    this.pageRecognizers = {};
    this.pagePipelineCache.clear();
    
    this.isProcessing = false;
    this.currentStep = null;
    this.progress = { current: 0, total: 0, step: '' };
  }

  /**
   * 只重置编号和预览，保留本批次的矢量、文字、材料表、焊点和管道识别结果。
   */
  resetNumberingState() {
    Object.keys(this.pageWelds || {}).forEach(pageNum => {
      this.pageWelds[pageNum] = (this.pageWelds[pageNum] || []).filter(weld => (
        weld?.isManualInserted !== true && weld?.isAutoPipeLengthInserted !== true
      ));
    });
    this.allWelds = [];
    this.allWeldsNumbered = [];
    this.pipelineStats = [];
    this.pipelineComparison = null;
    this.pendingBatchAnnotationRule = null;
    this.activeBatchRunId = null;
    this.isProcessing = false;
    this.currentStep = Object.keys(this.pagePipelines || {}).length > 0
      ? 'pipelines'
      : Object.keys(this.pageWelds || {}).length > 0
        ? 'welds'
        : Object.keys(this.pageTextDetections || {}).length > 0
          ? 'ocr'
          : Object.keys(this.pageVectors || {}).length > 0
            ? 'vectors'
            : null;
    this.progress = { current: 0, total: 0, step: '' };
    return this.pageWelds;
  }

  setPipelineReferenceData(referenceData = null) {
    this.pipelineReferenceData = referenceData || null;
    this.pipelineComparison = this.pipelineReferenceData && this.pipelineStats.length > 0
      ? buildPipelineComparison(this.pipelineReferenceData, this.pipelineStats)
      : null;

    return this.pipelineReferenceData;
  }

  clearPipelineReferenceData() {
    this.pipelineReferenceData = null;
    this.pipelineComparison = null;
  }

  /**
   * 步骤1：多页矢量信息提取
   * @param {Object} pdfDocument - PDF.js文档对象
   * @param {number} startPage - 起始页码
   * @param {number} endPage - 结束页码
   * @returns {Promise<Object>} - 页面矢量数据 {pageNum: vectors[]}
   */
  async extractVectorsFromPages(pdfDocument, startPage, endPage) {
    this.updateStep('vectors');
    const total = endPage - startPage + 1;
    
    console.log(`📐 开始多页矢量提取: 第${startPage}页 到 第${endPage}页 (共${total}页)`);
    
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      try {
        this.updateProgress(pageNum - startPage + 1, total, `提取第${pageNum}页矢量信息`);
        
        // 获取页面对象
        const page = await pdfDocument.getPage(pageNum);
        const pageViewport = page.getViewport({ scale: 1 });
        this.pagePdfSizes[pageNum] = {
          width: pageViewport.width,
          height: pageViewport.height
        };
        
        // 提取矢量数据
        const vectors = await VectorExtractionUtils.extractVectors(page);
        
        this.pageVectors[pageNum] = vectors;
        
        console.log(`✅ 第${pageNum}页: 提取到 ${vectors.length} 个矢量元素`);
        // Let React paint progress and process user input between pages.
        await new Promise(resolve => setTimeout(resolve, 0));
        
      } catch (error) {
        this.reportError(error, pageNum);
        this.pageVectors[pageNum] = [];
      }
    }

    // Page vectors are now stored in pageVectors. The parsed pdf-lib source
    // document used only to slice upload pages is much larger and must not
    // remain resident for the lifetime of the tab.
    VectorExtractionUtils.releasePdfLibSourceDocument();
    
    return this.pageVectors;
  }

  /**
   * 步骤2：多页OCR文字识别
   * @param {string} pdfPath - PDF文件路径
   * @param {number} startPage - 起始页码
   * @param {number} endPage - 结束页码
   * @returns {Promise<Object>} - 页面OCR数据 {pageNum: {detections, page_info}}
   */
  async detectTextFromPages(pdfPath, startPage, endPage, templateData = null) {
    this.updateStep('ocr');
    const total = endPage - startPage + 1;
    
    console.log(`📝 开始多页文字识别: 第${startPage}页 到 第${endPage}页 (共${total}页)`);
    
    // 确保OCR服务已初始化
    if (!ocrService.port) {
      await ocrService.initialize();
    }
    
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      try {
        this.updateProgress(pageNum - startPage + 1, total, `识别第${pageNum}页文字`);
        
        // 调用OCR服务进行文字检测
        const textDetectionTemplate = {
          ...(templateData || {}),
          // A rejected material-table value such as a lone "1" must not skip
          // pipeline-area OCR during the text-recognition pass.
          preRecognizedPipelineNumber: sanitizeRecognizedPipelineNumber(
            this.pageTextDetections?.[pageNum]?.pipelineNumber
          ),
          preRecognizedPipeClass: sanitizeRecognizedPipelineNumber(
            this.pageTextDetections?.[pageNum]?.pipeClass ||
              this.pageTextDetections?.[pageNum]?.pipelineClass
          ),
          ...(templateData?.pipelineArea ? {
            pipelineArea: { ...templateData.pipelineArea, page: pageNum }
          } : {}),
          ...(templateData?.pipeClassArea ? {
            pipeClassArea: { ...templateData.pipeClassArea, page: pageNum }
          } : {})
        };

        const rawResult = await ocrService.detectTextOnly(pdfPath, pageNum, textDetectionTemplate);
        const result = enrichTextDetectionResult(rawResult, pageNum);
        
        this.pageTextDetections[pageNum] = result;
        
        console.log(
          `✅ 第${pageNum}页: 识别到 ${result.detections?.length || 0} 个文字区域` +
          `${result.pipelineNumber ? `，管线号 ${result.pipelineNumber}` : '，未识别到管线号'}` +
          `${result.pipeClass ? `，管道等级 ${result.pipeClass}` : (templateData?.pipeClassArea ? '，未识别到管道等级' : '')}` +
          `，来源 ${result.pipelineEngine === 'mineru' ? 'MinerU' : (result.pipelineFallbackUsed ? 'PaddleOCR回退' : 'PaddleOCR')}`
        );
        
      } catch (error) {
        this.reportError(error, pageNum);
        this.pageTextDetections[pageNum] = enrichTextDetectionResult({ detections: [], page_info: {} }, pageNum);
      }
    }
    
    return this.pageTextDetections;
  }

  /**
   * 步骤3：多页焊点识别
   * @param {number} startPage - 起始页码
   * @param {number} endPage - 结束页码
   * @param {boolean} enableOCRFilter - 是否启用OCR文字过滤
   * @returns {Promise<Object>} - 页面焊点数据 {pageNum: welds[]}
   */
  async detectWeldsFromPages(startPage, endPage, enableOCRFilter = true, weldRecognitionArea = null) {
    this.updateStep('welds');
    const total = endPage - startPage + 1;
    
    console.log(`🔥 开始多页焊点识别: 第${startPage}页 到 第${endPage}页 (共${total}页)`);
    
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      this.updateProgress(pageNum - startPage + 1, total, `识别第${pageNum}页焊点`);
      // Let React paint the latest progress and keep pointer/keyboard events
      // responsive before the CPU-heavy work for each page starts.
      await VectorExtractionUtils.yieldToMainThread();
      try {
        const vectors = this.pageVectors[pageNum];
        
        if (!vectors || vectors.length === 0) {
          console.warn(`⚠️ 第${pageNum}页没有矢量数据，跳过焊点识别`);
          this.pageWelds[pageNum] = [];
          continue;
        }
        
        // Reuse the recognizer only while the exact vector snapshot is still
        // active. This avoids rebuilding the spatial/Path indexes on repeated
        // recognition without ever carrying them across changed page data.
        let recognizer = this.pageRecognizers?.[pageNum];
        const canReuseRecognizer = recognizer?.vectors === vectors &&
          recognizer?.spatialIndex &&
          recognizer.vectors.length === vectors.length;
        if (!canReuseRecognizer) {
          const spatialIndex = new VectorSpatialIndex(vectors, 10000, 10000, 50);
          recognizer = new ObjectRecognizer(vectors, spatialIndex);
        } else if (recognizer.weldRuleManager?.loadConfig) {
          // Rules are editable between runs; refresh them while retaining only
          // the expensive geometry indexes.
          recognizer.weldRuleManager.loadConfig();
        }
        
        // 🔧 保存 recognizer 以便后续步骤复用分类结果
        if (!this.pageRecognizers) this.pageRecognizers = {};
        this.pageRecognizers[pageNum] = recognizer;
        
        // 执行焊点识别
        recognizer.detectWelds(null);
        
        // 获取识别到的焊点
        let welds = recognizer.getDetectedWelds();
        const totalWelds = welds.length;

        const sharedFilterResult = applySharedWeldCandidateFilters(welds);
        welds = sharedFilterResult.welds;
        console.log(
          `焊点统一候选过滤 第${pageNum}页: ${totalWelds} -> ${welds.length}`,
          sharedFilterResult.diagnostics
        );

        const pageInfo = this.getPageInfo(pageNum, vectors);

        if (weldRecognitionArea && pageInfo) {
          const beforeAreaFilter = welds.length;
          welds = welds.filter(weld => this.isWeldInRecognitionArea(weld, weldRecognitionArea, pageInfo));
          console.log(`📐 第${pageNum}页 焊点区域过滤后保留 ${welds.length}/${beforeAreaFilter} 个焊点`);
        }
        
        // 如果启用OCR过滤，过滤掉在文字区域内的焊点
        if (enableOCRFilter) {
          const textData = this.pageTextDetections[pageNum];
          if (textData && textData.detections && textData.detections.length > 0) {
            const filteredResults = filterWeldsOutsideTextRegions(
              welds,
              textData.detections,
              pageInfo || textData.page_info,
              'any'
            );
            welds = filteredResults.map(r => r.weld);
            
            console.log(`📝 第${pageNum}页: OCR过滤后保留 ${welds.length}/${totalWelds} 个焊点`);
          }
        }
        
        // 🔗 焊点-单线段关联（用于严格法线方向的引线布局）
        if (welds.length > 0) {
          try {
            const { segmentCandidates } = associateWeldsWithSingleSegmentVectors(welds, vectors, 15);
            const associatedCount = welds.filter(w => w.relatedSegment).length;
            console.log(`   🔗 第${pageNum}页: ${associatedCount}/${welds.length} 个焊点关联到单线段 (${segmentCandidates.length} 条候选线段)`);
            const confidenceResult = splitWeldsByConnectionConfidence(welds);
            welds = confidenceResult.welds;
            this.pageWeldReviewCandidates[pageNum] = confidenceResult.review;
            this.pageWeldRecognitionDiagnostics[pageNum] = {
              ...sharedFilterResult.diagnostics,
              rawCandidateCount: totalWelds,
              acceptedCount: welds.length,
              connectionReviewCount: confidenceResult.review.length,
              connectionCheckEnforced: confidenceResult.enforced,
              connectedCount: confidenceResult.connectedCount
            };
            if (confidenceResult.review.length > 0) {
              console.warn(`第${pageNum}页有 ${confidenceResult.review.length} 个低置信度焊点候选未自动采用，已保留供人工检查`);
            }
          } catch (error) {
            console.warn(`   ⚠️ 第${pageNum}页单线段关联失败:`, error);
            this.pageWeldReviewCandidates[pageNum] = [];
            this.pageWeldRecognitionDiagnostics[pageNum] = {
              ...sharedFilterResult.diagnostics,
              rawCandidateCount: totalWelds,
              acceptedCount: welds.length,
              connectionReviewCount: 0,
              connectionCheckEnforced: false
            };
          }
        }
        
        // 为每个焊点添加页码信息
        const pageTextData = this.pageTextDetections[pageNum] || {};
        welds = welds.map((weld, index) => ({
          ...weld,
          pageNum: pageNum,
          pageIndex: index,
          pipelineNumber: pageTextData.pipelineNumber || '',
          pipelineStatus: pageTextData.pipelineStatus || 'unresolved',
          pipelineConfidence: pageTextData.pipelineConfidence || 0,
          pipelineEngine: pageTextData.pipelineEngine || 'paddleocr',
          pipelineSource: pageTextData.pipelineSource || '',
          pipelineFallbackUsed: !!pageTextData.pipelineFallbackUsed,
          pipelineCandidateCount: Array.isArray(pageTextData.pipelineCandidates)
            ? pageTextData.pipelineCandidates.length
            : 0
        }));
        
        this.pageWelds[pageNum] = welds;
        
        console.log(`✅ 第${pageNum}页: 识别到 ${welds.length} 个焊点`);
        
      } catch (error) {
        this.reportError(error, pageNum);
        this.pageWelds[pageNum] = [];
        this.pageWeldReviewCandidates[pageNum] = [];
      }
    }

    // Give the final page result a chance to render before the following
    // fitting-recognition stage begins.
    await VectorExtractionUtils.yieldToMainThread();
    this.releaseTransientRecognitionCaches(
      Array.from(
        { length: Math.max(0, Number(endPage) - Number(startPage) + 1) },
        (_, index) => Number(startPage) + index
      )
    );
    
    return this.pageWelds;
  }

  getWeldReviewCandidateId(candidate, pageNum = null, index = 0) {
    if (candidate?.reviewId) return String(candidate.reviewId);
    if (candidate?.id) return String(candidate.id);
    const point = getWeldPoint(candidate) || { x: 0, y: 0 };
    return `review-${pageNum || candidate?.pageNum || 1}-${index}-${point.x.toFixed(2)}-${point.y.toFixed(2)}`;
  }

  /**
   * Merge remote AI detections into the current rule snapshot. AI is additive:
   * rule welds are never removed and AI-only detections require confirmation.
   */
  mergeAiWeldDetections(aiPages = {}, startPage = null, endPage = null) {
    const pageNumbers = startPage !== null && endPage !== null
      ? Array.from(
        { length: Math.max(0, Number(endPage) - Number(startPage) + 1) },
        (_, index) => Number(startPage) + index
      )
      : Object.keys(aiPages || {}).map(Number).filter(Number.isFinite);

    pageNumbers.forEach(pageNum => {
      const vectors = this.pageVectors?.[pageNum] || [];
      const pageInfo = this.getPageInfo(pageNum, vectors);
      const detections = (aiPages?.[pageNum] || aiPages?.[String(pageNum)] || [])
        .filter(detection => this.isWeldInRecognitionArea(detection, this.weldRecognitionArea, pageInfo));
      const fusion = fuseRuleAndAiWelds({
        ruleWelds: this.pageWelds?.[pageNum] || [],
        aiDetections: detections,
        pageNum,
        pageInfo
      });

      const pageTextData = this.pageTextDetections?.[pageNum] || {};
      const aiReview = fusion.reviewCandidates.map((candidate, index) => ({
        ...candidate,
        reviewId: this.getWeldReviewCandidateId(candidate, pageNum, index),
        pageNum,
        pipelineNumber: pageTextData.pipelineNumber || '',
        pipelineStatus: pageTextData.pipelineStatus || 'unresolved'
      }));
      if (aiReview.length > 0 && vectors.length > 0) {
        try {
          associateWeldsWithSingleSegmentVectors(aiReview, vectors, 15);
        } catch (error) {
          console.warn(`第${pageNum}页AI候选管线关联失败`, error?.message || error);
        }
      }

      const existingReview = (this.pageWeldReviewCandidates?.[pageNum] || [])
        .filter(candidate => candidate?.reviewSource !== 'ai')
        .map((candidate, index) => ({
          ...candidate,
          reviewId: this.getWeldReviewCandidateId(candidate, pageNum, index),
          pageNum,
          reviewSource: candidate?.reviewSource || 'rule',
          reviewReason: candidate?.reviewReason || 'low_connection_confidence'
        }));
      this.pageWelds[pageNum] = fusion.welds;
      this.pageWeldReviewCandidates[pageNum] = [...existingReview, ...aiReview];
      this.pageAiWeldDetections[pageNum] = detections;
      this.pageAiWeldDiagnostics[pageNum] = fusion.diagnostics;
      this.pageWeldRecognitionDiagnostics[pageNum] = {
        ...(this.pageWeldRecognitionDiagnostics?.[pageNum] || {}),
        ai: fusion.diagnostics
      };
    });

    return {
      welds: this.pageWelds,
      reviewCandidates: this.pageWeldReviewCandidates,
      diagnostics: this.pageAiWeldDiagnostics
    };
  }

  /**
   * Use remote AI as the primary weld source.  This intentionally does not
   * build vector indexes, infer fittings, or require a vector-to-pipe match.
   * The AI request itself is cropped to weldRecognitionArea, while the local
   * area check remains as a defensive guard when page dimensions are known.
   */
  replaceWeldsWithAiDetections(aiPages = {}, startPage = null, endPage = null) {
    const pageNumbers = startPage !== null && endPage !== null
      ? Array.from(
        { length: Math.max(0, Number(endPage) - Number(startPage) + 1) },
        (_, index) => Number(startPage) + index
      )
      : Object.keys(aiPages || {}).map(Number).filter(Number.isFinite);

    pageNumbers.forEach(pageNum => {
      const pageInfo = this.getPageInfo(pageNum, []);
      const pageTextData = this.pageTextDetections?.[pageNum] || {};
      const rawDetections = (aiPages?.[pageNum] || aiPages?.[String(pageNum)] || [])
        .filter(detection => this.isWeldInRecognitionArea(detection, this.weldRecognitionArea, pageInfo));
      const welds = [];
      rawDetections.forEach((detection, index) => {
        const point = getWeldPoint(detection);
        if (!point) return;
        // A remote model occasionally returns an overlapping duplicate box.
        // Keep the highest-confidence point within the same 5px tolerance used
        // by the assisted AI path.
        const duplicateIndex = welds.findIndex(existing => {
          const existingPoint = getWeldPoint(existing);
          return existingPoint && Math.hypot(existingPoint.x - point.x, existingPoint.y - point.y) <= AI_RULE_HIT_RADIUS;
        });
        const item = {
          ...detection,
          id: detection.id || `ai-direct-${pageNum}-${index}`,
          center: point,
          pageNum,
          pageIndex: index,
          confidence: Number(detection.confidence || detection.score || 0),
          aiConfidence: Number(detection.confidence || detection.score || 0),
          recognitionSource: 'ai-direct',
          recognitionSources: ['ai'],
          isAiDirectDetection: true,
          isAiReviewCandidate: false,
          pipelineNumber: pageTextData.pipelineNumber || '',
          pipelineStatus: pageTextData.pipelineStatus || 'unresolved',
          pipelineConfidence: pageTextData.pipelineConfidence || 0,
          pipelineEngine: pageTextData.pipelineEngine || 'paddleocr',
          pipelineSource: pageTextData.pipelineSource || '',
          pipelineFallbackUsed: !!pageTextData.pipelineFallbackUsed,
          pipelineCandidateCount: Array.isArray(pageTextData.pipelineCandidates)
            ? pageTextData.pipelineCandidates.length
            : 0
        };
        if (duplicateIndex < 0) {
          welds.push(item);
        } else if (item.aiConfidence > (welds[duplicateIndex].aiConfidence || 0)) {
          welds[duplicateIndex] = { ...item, pageIndex: duplicateIndex };
        }
      });

      this.pageWelds[pageNum] = welds;
      this.pageWeldReviewCandidates[pageNum] = [];
      this.pageAiWeldDetections[pageNum] = rawDetections;
      this.pageAiWeldDiagnostics[pageNum] = {
        mode: 'direct',
        aiCount: rawDetections.length,
        acceptedCount: welds.length,
        duplicateCount: Math.max(0, rawDetections.length - welds.length),
        vectorRecognitionSkipped: true,
        fittingRecognitionSkipped: true
      };
      this.pageWeldRecognitionDiagnostics[pageNum] = {
        ...(this.pageWeldRecognitionDiagnostics?.[pageNum] || {}),
        ai: this.pageAiWeldDiagnostics[pageNum]
      };
    });

    return {
      welds: this.pageWelds,
      reviewCandidates: this.pageWeldReviewCandidates,
      diagnostics: this.pageAiWeldDiagnostics
    };
  }

  acceptWeldReviewCandidate(pageNum, reviewId) {
    const page = Number(pageNum);
    const candidates = this.pageWeldReviewCandidates?.[page] || [];
    const candidateIndex = candidates.findIndex((candidate, index) => (
      this.getWeldReviewCandidateId(candidate, page, index) === String(reviewId)
    ));
    if (candidateIndex < 0) return this.pageWelds?.[page] || [];

    const candidate = candidates[candidateIndex];
    const point = getWeldPoint(candidate);
    if (!point) return this.pageWelds?.[page] || [];
    const current = this.pageWelds?.[page] || [];
    const pageInfo = this.getPageInfo(page, this.pageVectors?.[page] || []);
    // Use the same boundary when accepting an AI-only candidate. Otherwise a
    // candidate 6px away is unmatched above but silently discarded here.
    const duplicateDistance = candidate.reviewSource === 'ai'
      ? AI_RULE_HIT_RADIUS : getAiMergeDistance(pageInfo);
    const duplicate = current.some(weld => {
      const existingPoint = getWeldPoint(weld);
      return existingPoint && Math.hypot(existingPoint.x - point.x, existingPoint.y - point.y) <= duplicateDistance;
    });
    if (!duplicate) {
      const accepted = {
        ...candidate,
        id: candidate.id || `confirmed-${reviewId}`,
        center: point,
        pageNum: page,
        pageIndex: current.length,
        isAiReviewCandidate: false,
        isReviewConfirmed: true,
        recognitionSource: candidate.reviewSource === 'ai' ? 'ai-confirmed' : 'rule-confirmed',
        recognitionSources: Array.from(new Set([
          ...(candidate.recognitionSources || []),
          candidate.reviewSource === 'ai' ? 'ai' : 'rule',
          'human-confirmed'
        ]))
      };
      this.pageWelds[page] = [...current, accepted];
    }
    this.pageWeldReviewCandidates[page] = candidates.filter((_, index) => index !== candidateIndex);
    return this.pageWelds[page];
  }

  rejectWeldReviewCandidate(pageNum, reviewId) {
    const page = Number(pageNum);
    const candidates = this.pageWeldReviewCandidates?.[page] || [];
    this.pageWeldReviewCandidates[page] = candidates.filter((candidate, index) => (
      this.getWeldReviewCandidateId(candidate, page, index) !== String(reviewId)
    ));
    return this.pageWeldReviewCandidates[page];
  }

  getAiWeldDiagnostics(pageNum = null) {
    if (pageNum !== null && pageNum !== undefined) {
      return this.pageAiWeldDiagnostics?.[Number(pageNum)] || null;
    }
    return this.pageAiWeldDiagnostics || {};
  }

  isPointInRelativeArea(point, area, pageInfo) {
    if (!point || !area || !pageInfo) return true;
    const width = pageInfo.page_width || pageInfo.width || 0;
    const height = pageInfo.page_height || pageInfo.height || 0;
    if (!width || !height) return true;
    return point.x >= area.x * width &&
      point.x <= (area.x + area.width) * width &&
      point.y >= area.y * height &&
      point.y <= (area.y + area.height) * height;
  }

  isFittingCandidateInText(candidate, detections, pageInfo) {
    if (!candidate?.center || !Array.isArray(detections) || !pageInfo) return false;
    const box = candidate.boundingBox || {
      minX: candidate.center.x - 9,
      minY: candidate.center.y - 9,
      maxX: candidate.center.x + 9,
      maxY: candidate.center.y + 9
    };
    const candidateArea = Math.max(1, (box.maxX - box.minX) * (box.maxY - box.minY));
    return detections.some(detection => {
      const region = convertTextDetectionToRegion(detection, pageInfo);
      if (!region) return false;
      if (isPointInRegion(candidate.center, region)) return true;
      const overlapWidth = Math.max(0, Math.min(box.maxX, region.maxX) - Math.max(box.minX, region.minX));
      const overlapHeight = Math.max(0, Math.min(box.maxY, region.maxY) - Math.max(box.minY, region.minY));
      return (overlapWidth * overlapHeight) / candidateArea >= 0.75;
    });
  }

  getWeldIdentity(weld) {
    return weld?.id || weld?.pathId || weld?.sourceStableKey || weld?.stableKey || null;
  }

  findNearestPageWeld(welds, point, excluded = new Set(), maxDistance = Infinity) {
    if (!point) return null;
    const match = (welds || [])
      .filter(weld => !excluded.has(this.getWeldIdentity(weld)))
      .map(weld => ({
        weld,
        distance: Math.hypot(
          Number(weld?.center?.x || 0) - Number(point.x || 0),
          Number(weld?.center?.y || 0) - Number(point.y || 0)
        )
      }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
    return match && match.distance <= maxDistance ? match : null;
  }

  applyFittingEvidenceToPageWelds(pageNum, candidates, pageInfo) {
    const sourceWelds = this.pageWelds?.[pageNum] || [];
    if (!sourceWelds.length || !Array.isArray(candidates) || !candidates.length) return sourceWelds;
    const welds = sourceWelds.map(weld => ({
      ...weld,
      detectedFittings: Array.isArray(weld.detectedFittings) ? [...weld.detectedFittings] : []
    }));
    const diagonal = Math.hypot(
      Number(pageInfo?.page_width || pageInfo?.width || 0),
      Number(pageInfo?.page_height || pageInfo?.height || 0)
    ) || 1000;
    const defaultMaxDistance = Math.max(24, Math.min(70, diagonal * 0.035));
    const attach = (weld, evidence) => {
      if (!weld) return;
      const key = `${evidence.type}:${evidence.role || ''}:${evidence.candidateIndex}`;
      if (!weld.detectedFittings.some(item => `${item.type}:${item.role || ''}:${item.candidateIndex}` === key)) {
        weld.detectedFittings.push(evidence);
      }
    };

    candidates.forEach((candidate, candidateIndex) => {
      const type = candidate.branchOutlet
        ? 'branch-outlet'
        : candidate.type === 'tee-fitting'
          ? 'tee-fitting'
          : candidate.type === 'valve-fitting'
            ? 'valve-fitting'
            : 'elbow';
      const common = {
        type,
        candidateIndex,
        confidence: candidate.confidence || candidate.score || null,
        nominalAngle: candidate.nominalAngle || candidate.elbowAngle || null
      };

      if (candidate.branchOutlet) {
        const findByIdentity = identity => {
          if (!identity) return null;
          const weld = welds.find(item => this.getWeldIdentity(item) === identity);
          return weld ? { weld, distance: 0 } : null;
        };
        // The detector has already resolved the two physical connections.
        // Preserve that decision instead of guessing again from transformed
        // coordinates; nearest-point matching remains compatible with older
        // cached candidates that do not carry weld identities.
        const mainMatch = findByIdentity(candidate.mainConnectionWeldId) ||
          this.findNearestPageWeld(
            welds,
            candidate.mainConnectionPoint || candidate.center,
            new Set(),
            defaultMaxDistance
          );
        const excluded = new Set(mainMatch ? [this.getWeldIdentity(mainMatch.weld)] : []);
        const branchByIdentity = findByIdentity(candidate.branchConnectionWeldId);
        const branchMatch = branchByIdentity && !excluded.has(this.getWeldIdentity(branchByIdentity.weld))
          ? branchByIdentity
          : this.findNearestPageWeld(
            welds,
            candidate.branchConnectionPoint || candidate.center,
            excluded,
            defaultMaxDistance
          );
        if (mainMatch) {
          attach(mainMatch.weld, { ...common, role: 'main-connection', jointType: 'OL' });
          // A user/per-segment correction already stored on the weld must win.
          if (mainMatch.weld.annotationJointTypeText === undefined) {
            mainMatch.weld.annotationJointTypeText = 'OL';
            mainMatch.weld.annotationContentSource = 'branch-outlet-main';
          }
        }
        if (branchMatch) {
          attach(branchMatch.weld, { ...common, role: 'branch-connection' });
        }
        return;
      }

      const requiredCount = type === 'tee-fitting' ? 3 : 2;
      const excluded = new Set();
      const connectionPoints = Array.isArray(candidate.connectionPoints)
        ? candidate.connectionPoints.slice(0, requiredCount)
        : [];
      const connectionMaxDistance = connectionPoints.length > 0
        ? Math.max(4, Math.min(18, diagonal * 0.0045))
        : defaultMaxDistance;
      for (let index = 0; index < requiredCount; index += 1) {
        const match = this.findNearestPageWeld(
          welds,
          connectionPoints[index] || candidate.center,
          excluded,
          connectionMaxDistance
        );
        if (!match) break;
        excluded.add(this.getWeldIdentity(match.weld));
        attach(match.weld, { ...common, role: `connection-${index + 1}` });
      }
    });

    this.pageWelds[pageNum] = welds;
    return welds;
  }

  async detectFittingsFromPages(startPage, endPage, weldRecognitionArea = null, materialRowsByPage = {}) {
    // Fitting recognition is a sub-stage of weld recognition in the existing
    // five-step UI. Publishing a new unknown step makes the panel map it to 0.
    this.updateStep('welds');
    const firstPage = Number(startPage);
    const lastPage = Number(endPage);
    const total = lastPage - firstPage + 1;

    for (let pageNum = firstPage; pageNum <= lastPage; pageNum += 1) {
      this.updateProgress(pageNum - firstPage + 1, total, `识别第${pageNum}页管件`);
      try {
        const vectors = this.pageVectors?.[pageNum] || [];
        const welds = this.pageWelds?.[pageNum] || [];
        const pageInfo = this.getPageInfo(pageNum, vectors);
        const pageDiagonal = Math.hypot(
          Number(pageInfo?.page_width || pageInfo?.width || 0),
          Number(pageInfo?.page_height || pageInfo?.height || 0)
        ) || 1000;
        if (!vectors.length) {
          this.pageFittings[pageNum] = [];
          continue;
        }
        const pageMaterialRows = materialRowsByPage?.[pageNum] || materialRowsByPage?.[String(pageNum)] || [];
        const materialValueText = value => {
          if (Array.isArray(value)) return value.map(materialValueText).join(' ');
          if (!value || typeof value !== 'object') return String(value ?? '');
          if (value.text !== undefined) return materialValueText(value.text);
          return Object.values(value).map(materialValueText).join(' ');
        };
        const materialRowText = row => materialValueText(row);
        const branchOutletMaterialPattern = /支管台|焊接支管座|\bWELD(?:ING)?\s*OUTLET\b|\bWELDOLET\b|\bOLET\b/;
        const branchOutletMaterialRows = pageMaterialRows.filter(row => (
          branchOutletMaterialPattern.test(materialRowText(row).toUpperCase())
        ));
        const materialText = pageMaterialRows
          .map(materialRowText)
          .join(' ')
          .toUpperCase();
        const hasBranchOutletMaterial = branchOutletMaterialPattern.test(materialText);
        const parseOutletQuantity = row => {
          const rawRow = Array.isArray(row?.rawLogicalRow) ? row.rawLogicalRow : (Array.isArray(row) ? row : []);
          const values = [row?.qty, row?.QTY, row?.quantity, rawRow[5]];
          for (const value of values) {
            const match = /^\s*(\d+(?:\.0+)?)\s*(?:EA|PCS|件)?\s*$/i.exec(String(value ?? ''));
            if (match) return Math.max(0, Math.round(Number(match[1])));
          }
          return null;
        };
        const outletQuantityValues = branchOutletMaterialRows
          .map(parseOutletQuantity)
          .filter(value => Number.isFinite(value));
        const expectedBranchOutletCount = outletQuantityValues.length > 0
          ? outletQuantityValues.reduce((sum, value) => sum + value, 0)
          : null;
        const ruleFittingCandidates = [
          ...detectElbowCandidates(vectors, {
            includeSharpElbows: true,
            elbowGeometryMode: 'auto-exclusive',
            welds
          }),
          ...detectTeeCandidates(vectors),
          ...(hasBranchOutletMaterial ? detectBranchOutletCandidates(vectors, { welds }) : []),
          ...detectValveCandidates(vectors)
        ];
        const radialVectorCandidates = detectRadialVectorFittingCandidates(vectors, welds, pageInfo);
        let candidates = mergeRadialVectorFittingCandidates(
          ruleFittingCandidates,
          radialVectorCandidates,
          pageInfo
        );
        // Paddle may return tiny empty boxes around linework.  They are not
        // text and must not suppress a fitting candidate; meaningful text
        // boxes continue to participate in the existing filter.
        const textDetections = (this.pageTextDetections?.[pageNum]?.detections || [])
          .filter(detection => String(detection?.text || '').trim().length > 0);
        if (textDetections.length > 0 && pageInfo) {
          candidates = candidates.filter(candidate => (
            !this.isFittingCandidateInText(candidate, textDetections, pageInfo)
          ));
        }
        if (weldRecognitionArea && pageInfo) {
          candidates = candidates.filter(candidate => (
            this.isPointInRelativeArea(candidate.center, weldRecognitionArea, pageInfo)
          ));
        }

        // Material QTY is the upper bound for branch outlets on this page.
        // Prefer candidates with two connected welds, then stronger connector
        // topology and detector score.  This prevents other compact closed
        // symbols from consuming OL when the table says there is only one.
        if (Number.isFinite(expectedBranchOutletCount)) {
          const rankedOutlets = candidates
            .filter(candidate => candidate.branchOutlet)
            .slice()
            .sort((left, right) => {
              const leftTwoWelds = Number(Boolean(left.mainConnectionWeldId && left.branchConnectionWeldId));
              const rightTwoWelds = Number(Boolean(right.mainConnectionWeldId && right.branchConnectionWeldId));
              const leftSize = Math.max(1, Number(left.boundingBox?.width || 0), Number(left.boundingBox?.height || 0));
              const rightSize = Math.max(1, Number(right.boundingBox?.width || 0), Number(right.boundingBox?.height || 0));
              const leftDistance = Math.max(
                Number(left.mainConnectionCenterDistance || 0),
                Number(left.branchConnectionCenterDistance || 0)
              ) / leftSize;
              const rightDistance = Math.max(
                Number(right.mainConnectionCenterDistance || 0),
                Number(right.branchConnectionCenterDistance || 0)
              ) / rightSize;
              return rightTwoWelds - leftTwoWelds ||
                Number(Boolean(left.recoveredFromWeldPair)) - Number(Boolean(right.recoveredFromWeldPair)) ||
                leftDistance - rightDistance ||
                Number(right.connectorCount || 0) - Number(left.connectorCount || 0) ||
                Number(right.score || 0) - Number(left.score || 0);
            });
          const retainedOutlets = new Set();
          const occupiedWeldIds = new Set();
          for (const outlet of rankedOutlets) {
            if (retainedOutlets.size >= expectedBranchOutletCount) break;
            const weldIds = [outlet.mainConnectionWeldId, outlet.branchConnectionWeldId].filter(Boolean);
            if (weldIds.some(id => occupiedWeldIds.has(id))) continue;
            retainedOutlets.add(outlet);
            weldIds.forEach(id => occupiedWeldIds.add(id));
          }
          candidates = candidates.filter(candidate => !candidate.branchOutlet || retainedOutlets.has(candidate));
        }

        // The hexagonal outlet is a more specific interpretation than a tee at
        // the same location. Keep only the outlet to avoid double assignment.
        const outlets = candidates.filter(candidate => candidate.branchOutlet);
        candidates = candidates.filter(candidate => (
          candidate.branchOutlet || !outlets.some(outlet => (
            Math.hypot(
              Number(candidate.center?.x || 0) - Number(outlet.center?.x || 0),
              Number(candidate.center?.y || 0) - Number(outlet.center?.y || 0)
            ) <= Math.max(8, pageDiagonal * 0.008)
          ))
        ));
        this.pageFittings[pageNum] = candidates.map((candidate, index) => ({
          ...candidate,
          pageNum,
          candidateIndex: index
        }));
        this.applyFittingEvidenceToPageWelds(pageNum, this.pageFittings[pageNum], pageInfo);
        console.log(`[MultiPageFitting] 第${pageNum}页识别 ${candidates.length} 个管件`, {
          elbows: candidates.filter(item => item.type !== 'tee-fitting' && item.type !== 'valve-fitting').length,
          tees: candidates.filter(item => item.type === 'tee-fitting' && !item.branchOutlet).length,
          branchOutlets: outlets.length,
          expectedBranchOutlets: expectedBranchOutletCount,
          valves: candidates.filter(item => item.type === 'valve-fitting').length,
          radialVectorCandidates: radialVectorCandidates.length,
          radialValidatedCandidates: candidates.filter(item => item.radialVectorInferred).length
        });
      } catch (error) {
        console.warn(`[MultiPageFitting] 第${pageNum}页识别失败`, error);
        this.pageFittings[pageNum] = [];
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return this.pageFittings;
  }

  async detectSpecialWeldNoticesFromAreas(
    pdfPathOrFile,
    startPage,
    endPage,
    materialArea,
    weldRecognitionArea,
    pdfDocument = null
  ) {
    const noticesByPage = {};
    const firstPage = Number(startPage);
    const lastPage = Number(endPage);
    if (!materialArea || !weldRecognitionArea) {
      throw new Error('支架/静电接地识别需要材料表区域和焊点区域');
    }

    // Most engineering PDFs already contain selectable vector text. Reading
    // that text locally is much faster than uploading two OCR jobs. OCR is now
    // only a fallback for pages whose requested area has no text layer.
    if (pdfDocument?.getPage) {
      this.updateProgress(0, lastPage - firstPage + 1, '读取本地 PDF 文字层');
      const [localMaterialResults, localWeldResults] = await Promise.all([
        this.extractPdfTextFromAreaPages(pdfDocument, firstPage, lastPage, materialArea),
        this.extractPdfTextFromAreaPages(pdfDocument, firstPage, lastPage, weldRecognitionArea)
      ]);
      for (let pageNum = firstPage; pageNum <= lastPage; pageNum += 1) {
        const materialResult = localMaterialResults?.[pageNum];
        const weldResult = localWeldResults?.[pageNum];
        if (!this.pageSupportMaterialTextDetections[pageNum] && materialResult?.detections?.length > 0) {
          this.pageSupportMaterialTextDetections[pageNum] = materialResult;
        }
        if (!this.pageSpecialWeldTextDetections[pageNum] && weldResult?.detections?.length > 0) {
          this.pageSpecialWeldTextDetections[pageNum] = weldResult;
        }
      }
    }

    const missingMaterialPages = [];
    const missingWeldPages = [];
    for (let pageNum = firstPage; pageNum <= lastPage; pageNum += 1) {
      if (!this.pageSupportMaterialTextDetections[pageNum]) missingMaterialPages.push(pageNum);
      if (!this.pageSpecialWeldTextDetections[pageNum]) missingWeldPages.push(pageNum);
    }

    if (missingMaterialPages.length > 0 || missingWeldPages.length > 0) {
      this.updateProgress(0, Math.max(missingMaterialPages.length, missingWeldPages.length), '识别材料表支架文案和静电接地文字');
      const [materialResults, weldResults] = await Promise.all([
        missingMaterialPages.length > 0
          ? ocrService.recognizeScaffoldAreaPages(pdfPathOrFile, materialArea, firstPage, lastPage, missingMaterialPages)
          : Promise.resolve({}),
        missingWeldPages.length > 0
          ? ocrService.recognizeScaffoldAreaPages(pdfPathOrFile, weldRecognitionArea, firstPage, lastPage, missingWeldPages)
          : Promise.resolve({})
      ]);
      missingMaterialPages.forEach(pageNum => {
        this.pageSupportMaterialTextDetections[pageNum] = materialResults?.[pageNum] || {
          detections: [],
          page_info: {},
          source: 'material-area-support-ocr-batch'
        };
      });
      missingWeldPages.forEach(pageNum => {
        this.pageSpecialWeldTextDetections[pageNum] = weldResults?.[pageNum] || {
          detections: [],
          page_info: {},
          source: 'weld-area-grounding-ocr-batch'
        };
      });
    }

    for (let pageNum = firstPage; pageNum <= lastPage; pageNum += 1) {
      const vectors = this.pageVectors[pageNum] || [];
      const fallbackPageInfo = this.getPageInfo(pageNum, vectors) || {};
      const materialTextData = this.pageSupportMaterialTextDetections[pageNum] || {};
      const weldTextData = this.pageSpecialWeldTextDetections[pageNum] || {};
      const supportWelds = extractWeldedSupportWelds({
        detections: materialTextData.detections || [],
        pageInfo: materialTextData.page_info || fallbackPageInfo,
        pageNum,
        recognitionArea: null
      });
      const groundingNotices = extractStaticGroundingNotices({
        detections: weldTextData.detections || [],
        pageInfo: weldTextData.page_info || fallbackPageInfo,
        pageNum,
        recognitionArea: null
      });
      const positioningNotices = extractPositioningBlockNotices({
        detections: materialTextData.detections || [],
        pageInfo: materialTextData.page_info || fallbackPageInfo,
        pageNum,
        recognitionArea: null
      });
      const notices = [];
      if (supportWelds.length > 0) {
        notices.push({
          type: 'welded-support',
          pageNum,
          label: '焊接支架',
          codes: [...new Set(supportWelds.map(item => item.supportCode))],
          sourceItems: supportWelds
        });
      }
      notices.push(...groundingNotices);
      notices.push(...positioningNotices);
      if (notices.length > 0) noticesByPage[pageNum] = notices;
      console.log(`第${pageNum}页特殊焊点声明:`, notices.map(item => item.type));
    }
    this.pageSpecialWeldNotices = noticesByPage;
    return noticesByPage;
  }

  getSpecialWeldNotices(pageNum = null) {
    if (pageNum == null) return this.pageSpecialWeldNotices || {};
    return this.pageSpecialWeldNotices?.[Number(pageNum)] || [];
  }

  detectSupportNoticesFromMaterialResults(materialPageResults = {}, startPage, endPage) {
    const collectTexts = (value, texts, depth = 0) => {
      if (depth > 8 || value == null) return;
      if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();
        if (text) texts.push(text);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(item => collectTexts(item, texts, depth + 1));
        return;
      }
      if (typeof value === 'object') {
        Object.values(value).forEach(item => collectTexts(item, texts, depth + 1));
      }
    };

    const nextNotices = { ...(this.pageSpecialWeldNotices || {}) };
    for (let pageNum = Number(startPage); pageNum <= Number(endPage); pageNum += 1) {
      const pageResult = materialPageResults?.[pageNum] || materialPageResults?.[String(pageNum)] || {};
      const texts = [];
      collectTexts(pageResult.materials || [], texts);
      collectTexts(pageResult.sourceLogicalRows || [], texts);
      collectTexts(pageResult.rawLogicalRows || [], texts);
      const matches = texts.map(text => ({ text, code: findWeldedSupportCode(text) })).filter(item => item.code);
      const positioningMatches = texts.filter(isPositioningBlockText);
      const preserved = (nextNotices[pageNum] || []).filter(item => (
        item.type !== 'welded-support' && item.type !== 'positioning-block'
      ));
      if (matches.length > 0) {
        preserved.unshift({
          type: 'welded-support',
          pageNum,
          label: '焊接支架',
          codes: [...new Set(matches.map(item => item.code))],
          sourceItems: matches.map((item, index) => ({
            id: `material-support-${pageNum}-${index}`,
            pageNum,
            supportCode: item.code,
            supportSourceText: item.text,
            source: 'saved-material-recognition'
          }))
        });
      }
      if (positioningMatches.length > 0) {
        preserved.push({
          type: 'positioning-block',
          pageNum,
          label: 'JPLATE',
          sourceTexts: positioningMatches,
          source: 'saved-material-recognition'
        });
      }
      if (preserved.length > 0) nextNotices[pageNum] = preserved;
      else delete nextNotices[pageNum];
    }
    this.pageSpecialWeldNotices = nextNotices;
    return nextNotices;
  }

  async detectStaticGroundingNoticesFromArea(pdfPathOrFile, startPage, endPage, weldRecognitionArea, pdfDocument = null) {
    if (!weldRecognitionArea) throw new Error('特殊块识别需要焊点区域');
    const firstPage = Number(startPage);
    const lastPage = Number(endPage);
    const pageNums = Array.from(
      { length: Math.max(0, lastPage - firstPage + 1) },
      (_, index) => firstPage + index
    );
    const collectTexts = (value, texts, depth = 0) => {
      if (depth > 10 || value == null) return;
      if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();
        if (text) texts.push(text);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(item => collectTexts(item, texts, depth + 1));
        return;
      }
      if (typeof value === 'object') {
        Object.values(value).forEach(item => collectTexts(item, texts, depth + 1));
      }
    };

    // Special blocks only need a keyword check.  Run one source page per job
    // through the normal MinerU API so page mapping remains exact and this
    // flow no longer depends on the IDF tool's twelve-page upload batches.
    const mineruResults = await ocrService.recognizeSpecialBlockAreasDirectWithMinerU(
      pdfPathOrFile,
      weldRecognitionArea,
      pageNums,
      progress => this.updateProgress(
        Math.round(Number(progress?.percentage || 0) * 0.9),
        100,
        progress?.phase || '特殊块 MinerU 直接识别'
      )
    );

    const parseMineruPage = (pageNum, mineruItem, previousContent = '') => {
        const texts = [];
        if (previousContent) collectTexts(previousContent, texts);
        const rawMineruContent = mineruItem?.content;
        let parsedMineruContent = rawMineruContent;
        if (typeof rawMineruContent === 'string') {
          try {
            parsedMineruContent = JSON.parse(rawMineruContent);
          } catch (error) {
            parsedMineruContent = rawMineruContent;
          }
        }
        collectTexts(parsedMineruContent, texts);
        const findMatchedText = matcher => {
          let matchedText = texts.find(matcher);
          for (let index = 0; index < texts.length && !matchedText; index += 1) {
            for (let count = 2; count <= 4 && index + count <= texts.length; count += 1) {
              const combined = texts.slice(index, index + count).join(' ');
              if (matcher(combined)) {
                matchedText = combined;
                break;
              }
            }
          }
          return matchedText;
        };
        const matchedTexts = [findMatchedText(isStaticGroundingText)].filter(Boolean);
        const pageInfo = this.getPageInfo(pageNum, this.pageVectors[pageNum] || []) || {};
        const width = Number(pageInfo.page_width || pageInfo.width || 1);
        const height = Number(pageInfo.page_height || pageInfo.height || 1);
        const normalizedPageInfo = {
          ...pageInfo,
          page_width: width,
          page_height: height,
          width,
          height
        };
        this.pageSpecialWeldTextDetections[pageNum] = {
          detections: matchedTexts.map(matchedText => ({
            text: matchedText,
            box: [[0, 0], [width, 0], [width, height], [0, height]],
            score: 1,
            engine: 'mineru'
          })),
          page_info: normalizedPageInfo,
          source: mineruItem?.source || 'special-block-direct-mineru',
          rawTexts: texts,
          rawContent: texts.join('\n')
        };
        return {
          matched: matchedTexts.length > 0,
          retryHint: isStaticGroundingRetryHint(texts.join('\n'))
        };
      };

    const retryPages = [];
    pageNums.forEach(pageNum => {
      const parsed = parseMineruPage(pageNum, mineruResults?.[pageNum]);
      if (!parsed.matched && parsed.retryHint) retryPages.push(pageNum);
    });

    if (retryPages.length > 0) {
      const area = weldRecognitionArea || {};
      const padX = Math.max(0.015, Number(area.width || 0) * 0.05);
      const padY = Math.max(0.015, Number(area.height || 0) * 0.05);
      const retryArea = {
        ...area,
        x: Math.max(0, Number(area.x || 0) - padX),
        y: Math.max(0, Number(area.y || 0) - padY)
      };
      retryArea.width = Math.min(1 - retryArea.x, Number(area.width || 1) + padX * 2);
      retryArea.height = Math.min(1 - retryArea.y, Number(area.height || 1) + padY * 2);

      const retryResults = await ocrService.recognizeSpecialBlockAreasDirectWithMinerU(
        pdfPathOrFile,
        retryArea,
        retryPages,
        progress => this.updateProgress(
          90 + Math.round(Number(progress?.percentage || 0) * 0.1),
          100,
          `特殊块候选页补识别：${progress?.phase || `${retryPages.length} 页`}`
        )
      );
      retryPages.forEach(pageNum => {
        parseMineruPage(
          pageNum,
          {
            ...(retryResults?.[pageNum] || {}),
            source: 'special-block-direct-mineru-retry'
          },
          this.pageSpecialWeldTextDetections[pageNum]?.rawContent || ''
        );
      });
    }
    this.updateProgress(100, 100, '特殊块识别完成');

    const nextNotices = { ...(this.pageSpecialWeldNotices || {}) };
    pageNums.forEach(pageNum => {
      const vectors = this.pageVectors[pageNum] || [];
      const textData = this.pageSpecialWeldTextDetections[pageNum] || {};
      const grounding = extractStaticGroundingNotices({
        detections: textData.detections || [],
        pageInfo: textData.page_info || this.getPageInfo(pageNum, vectors) || {},
        pageNum,
        recognitionArea: null
      });
      // JPLATE is declared from the saved material-table recognition result.
      // The expensive weld-area MinerU pass is reserved for SEG-PIP only.
      const preserved = (nextNotices[pageNum] || []).filter(item => item.type !== 'static-grounding');
      const merged = [...preserved, ...grounding];
      if (merged.length > 0) nextNotices[pageNum] = merged;
      else delete nextNotices[pageNum];
    });
    this.pageSpecialWeldNotices = nextNotices;
    return nextNotices;
  }

  async extractPdfTextFromAreaPages(pdfDocument, startPage, endPage, area) {
    if (!pdfDocument?.getPage || !area) return {};
    const pageNums = Array.from(
      { length: Math.max(0, Number(endPage) - Number(startPage) + 1) },
      (_, index) => Number(startPage) + index
    );
    const results = {};
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < pageNums.length) {
        const index = nextIndex;
        nextIndex += 1;
        const pageNum = pageNums[index];
        const page = await pdfDocument.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const minX = Number(area.x || 0) * viewport.width;
        const minY = Number(area.y || 0) * viewport.height;
        const maxX = minX + Number(area.width || 0) * viewport.width;
        const maxY = minY + Number(area.height || 0) * viewport.height;

        const detections = (textContent?.items || []).map((item, itemIndex) => {
          const text = String(item?.str || '').trim();
          if (!text || !Array.isArray(item?.transform)) return null;
          const [viewportX, viewportY] = viewport.convertToViewportPoint(
            Number(item.transform[4] || 0),
            Number(item.transform[5] || 0)
          );
          const width = Math.max(1, Math.abs(Number(item.width || 0)));
          const height = Math.max(4, Math.abs(Number(item.height || item.transform[3] || 0)));
          const centerX = viewportX + width / 2;
          const centerY = viewportY - height / 2;
          if (centerX < minX || centerX > maxX || centerY < minY || centerY > maxY) return null;
          return {
            id: `pdf-text-${pageNum}-${itemIndex}`,
            text,
            box: [
              [viewportX, viewportY - height],
              [viewportX + width, viewportY - height],
              [viewportX + width, viewportY],
              [viewportX, viewportY]
            ],
            score: 1,
            _centerY: centerY,
            _minX: viewportX,
            _height: height
          };
        }).filter(Boolean);

        // PDF text is often split into separate words. Add merged line
        // detections so phrases such as "SEQ DETAIL A" still match.
        const lines = [];
        detections.forEach(detection => {
          let line = lines.find(candidate => (
            Math.abs(candidate.centerY - detection._centerY) <= Math.max(3, detection._height * 0.7)
          ));
          if (!line) {
            line = { centerY: detection._centerY, items: [] };
            lines.push(line);
          }
          line.items.push(detection);
        });
        const mergedLines = lines.map((line, lineIndex) => {
          const items = [...line.items].sort((a, b) => a._minX - b._minX);
          if (items.length < 2) return null;
          const xs = items.flatMap(item => item.box.map(point => point[0]));
          const ys = items.flatMap(item => item.box.map(point => point[1]));
          const left = Math.min(...xs);
          const right = Math.max(...xs);
          const top = Math.min(...ys);
          const bottom = Math.max(...ys);
          return {
            id: `pdf-text-line-${pageNum}-${lineIndex}`,
            text: items.map(item => item.text).join(' '),
            box: [[left, top], [right, top], [right, bottom], [left, bottom]],
            score: 1
          };
        }).filter(Boolean);

        results[pageNum] = {
          detections: [...detections, ...mergedLines],
          page_info: {
            page_width: viewport.width,
            page_height: viewport.height,
            page_index: pageNum
          },
          source: 'pdf-text-layer'
        };
      }
    };

    await Promise.all(Array.from({ length: Math.min(4, pageNums.length) }, () => worker()));
    return results;
  }

  /**
   * 步骤4：多页管道识别（区分主管/支管，用于智能编号）
   * @param {number} startPage - 起始页码
   * @param {number} endPage - 结束页码
   * @returns {Promise<Object>} - 页面管道数据 {pageNum: {pipelines, mainPipes, branchPipes, ...}}
   */
  async detectPipelinesFromPages(startPage, endPage) {
    this.updateStep('pipelines');
    const total = endPage - startPage + 1;
    
    console.log(`🔗 开始多页管道识别: 第${startPage}页 到 第${endPage}页 (共${total}页)`);
    console.log(`⚠️ 管道识别已临时禁用，返回空数据以使用空间顺序编号`);
    
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      this.updateProgress(pageNum - startPage + 1, total, `跳过第${pageNum}页管道识别`);
      this.pagePipelines[pageNum] = { pipelines: [], mainPipes: [], branchPipes: [], mainEndpoints: [], branchEndpoints: [] };
    }
    
    return this.pagePipelines;
  }

  /**
   * 识别管道端点（用于智能编号排序）
   * 与单页版 PipelineOverlay 逻辑完全一致
   */
  detectPipelineEndpoints(pipelines, mainPipes, branchPipes, vectors) {
    const mainPipeIds = new Set(mainPipes.map(p => p.pathId));
    const branchPipeIds = new Set(branchPipes.map(p => p.pathId));
    
    // 收集所有管道的宽边
    const allWidthEdges = [];
    pipelines.forEach(pipeline => {
      // 🔧 跳过三通部分的管道段（三通内部的端点不应被识别为管道端点）
      if (pipeline.isTeePart) {
        return;
      }
      
      const edges = this.getPipelineEdges(pipeline, vectors);
      edges.forEach(edge => {
        if (edge.isWidthEdge) {
          allWidthEdges.push({
            ...edge,
            pipelineId: pipeline.pathId,
            pipelineType: mainPipeIds.has(pipeline.pathId) ? 'main' : 
                         branchPipeIds.has(pipeline.pathId) ? 'branch' : 'unknown'
          });
        }
      });
    });
    
    console.log(`   📏 共收集到 ${allWidthEdges.length} 条宽边`);
    
    // 步骤1：标记每条宽边是否被共用，找出非共用的宽边
    const uniqueEdges = [];
    allWidthEdges.forEach((edge, index) => {
      let isShared = false;
      
      for (let i = 0; i < allWidthEdges.length; i++) {
        if (i === index) continue;
        const otherEdge = allWidthEdges[i];
        
        // 只有不同管道的边才算共用
        if (otherEdge.pipelineId !== edge.pipelineId) {
          if (this.areEdgesShared(edge, otherEdge, 10)) {
            isShared = true;
            break;
          }
        }
      }
      
      if (!isShared) {
        uniqueEdges.push({ ...edge, originalIndex: index });
      }
    });
    
    console.log(`   🔴 初步识别到 ${uniqueEdges.length} 条非共用的宽边`);
    
    // 步骤2：过滤掉相近的非共用宽边对（可能有阀门或流向箭头）
    // ⚠️ 重要：只过滤不同管道之间的相近宽边
    // ⭐ 改进：基于距离优先配对，而不是先到先得（与单页版一致）
    
    // 找出所有可能的配对及其距离
    const possiblePairs = [];
    for (let i = 0; i < uniqueEdges.length; i++) {
      for (let j = i + 1; j < uniqueEdges.length; j++) {
        const edge1 = uniqueEdges[i];
        const edge2 = uniqueEdges[j];
        
        // 只考虑不同管道之间的宽边
        if (edge1.pipelineId !== edge2.pipelineId) {
          const distance = this.getEdgeDistance(edge1, edge2);
          const isParallel = this.areEdgesParallel(edge1, edge2);
          
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
    
    // 按距离排序，优先配对距离最近的
    possiblePairs.sort((a, b) => a.distance - b.distance);
    
    // 依次配对，确保每条边只被配对一次
    const pairedEdgeIds = new Set();
    possiblePairs.forEach(pair => {
      if (!pairedEdgeIds.has(pair.index1) && !pairedEdgeIds.has(pair.index2)) {
        pairedEdgeIds.add(pair.index1);
        pairedEdgeIds.add(pair.index2);
        console.log(`   ⚠️ 过滤相近宽边对: 管道${pair.edge1.pipelineId} ↔ 管道${pair.edge2.pipelineId}, 距离=${pair.distance.toFixed(1)}px`);
      }
    });
    
    // 步骤3：保留未被配对的边作为真正的端点
    const filteredUniqueEdges = [];
    uniqueEdges.forEach((edge, index) => {
      if (!pairedEdgeIds.has(index)) {
        filteredUniqueEdges.push(edge);
      }
    });
    
    console.log(`   ✅ 最终识别到 ${filteredUniqueEdges.length} 条真正的非共用宽边（已排除 ${pairedEdgeIds.size} 条配对边）`);
    
    // 步骤4：分类处理主管和支管的端点
    const mainEndpoints = filteredUniqueEdges.filter(e => e.pipelineType === 'main');
    const branchEndpoints = filteredUniqueEdges.filter(e => e.pipelineType === 'branch');
    
    console.log(`   🔵 主管端点: ${mainEndpoints.length} 个`);
    console.log(`   🟠 支管端点: ${branchEndpoints.length} 个`);
    
    return { mainEndpoints, branchEndpoints };
  }

  /**
   * 计算两条边之间的距离（使用中点）
   */
  getEdgeDistance(edge1, edge2) {
    const mid1 = {
      x: (edge1.start.x + edge1.end.x) / 2,
      y: (edge1.start.y + edge1.end.y) / 2
    };
    const mid2 = {
      x: (edge2.start.x + edge2.end.x) / 2,
      y: (edge2.start.y + edge2.end.y) / 2
    };
    
    return Math.sqrt(Math.pow(mid1.x - mid2.x, 2) + Math.pow(mid1.y - mid2.y, 2));
  }

  /**
   * 判断两条边是否平行
   */
  areEdgesParallel(edge1, edge2, angleThreshold = 15) {
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
  }

  /**
   * 获取管道的所有边（与单页版 PipelineOverlay 完全一致）
   * 直接从 vectors 中获取，并区分长边和宽边
   */
  getPipelineEdges(pipeline, vectors) {
    const edges = [];
    const pathId = pipeline.pathId;
    
    // 从 vectors 中提取该管道的所有边
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
    
    // 区分长边和宽边（与单页版完全一致）
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
  }

  /**
   * 判断两条边是否共用
   */
  areEdgesShared(edge1, edge2, threshold = 5) {
    const dist1 = Math.sqrt(Math.pow(edge1.start.x - edge2.start.x, 2) + Math.pow(edge1.start.y - edge2.start.y, 2));
    const dist2 = Math.sqrt(Math.pow(edge1.end.x - edge2.end.x, 2) + Math.pow(edge1.end.y - edge2.end.y, 2));
    
    if (dist1 < threshold && dist2 < threshold) return true;
    
    const dist3 = Math.sqrt(Math.pow(edge1.start.x - edge2.end.x, 2) + Math.pow(edge1.start.y - edge2.end.y, 2));
    const dist4 = Math.sqrt(Math.pow(edge1.end.x - edge2.start.x, 2) + Math.pow(edge1.end.y - edge2.start.y, 2));
    
    if (dist3 < threshold && dist4 < threshold) return true;
    
    return false;
  }

  /**
   * 步骤5：汇总所有焊点并生成智能编号（主管优先，从端点开始）
   * @param {number} startPage - 起始页码
   * @param {number} endPage - 结束页码
   * @param {number} startNumber - 起始编号
   * @param {string} prefix - 编号前缀
   * @returns {Array} - 带编号的焊点列表
   */
  generateWeldNumbers(startPage, endPage, startNumber = 1, prefix = '', suffix = '') {
    this.updateStep('numbering');
    this.activeBatchRunId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    console.log(`🔢 开始生成多页焊点智能编号: 第${startPage}页 到 第${endPage}页`);
    console.log(`   📊 编号策略: 主管优先，从端点开始，逐页处理`);
    
    this.allWelds = [];
    this.allWeldsNumbered = [];
    let currentNumber = startNumber;
    let currentSupportNumber = 601;
    let lastPipelineNumber = null;
    const normalizePipelineNumber = (value) => String(value || '').trim().replace(/\s+/g, '');
    
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const pageWelds = this.pageWelds[pageNum] || [];
      const pipelineData = this.pagePipelines[pageNum] || {};
      const pagePipelineNumber = normalizePipelineNumber(this.pageTextDetections[pageNum]?.pipelineNumber);
      const pagePipeClass = String(
        this.pageTextDetections[pageNum]?.pipeClass ||
        this.pageTextDetections[pageNum]?.pipelineClass ||
        ''
      ).trim();
      const pipelineChanged = pagePipelineNumber && lastPipelineNumber && pagePipelineNumber !== lastPipelineNumber;

      if (pipelineChanged) {
        console.log(`   管线号变化: ${lastPipelineNumber} -> ${pagePipelineNumber}，焊口编号重置为 ${startNumber}`);
        currentNumber = startNumber;
        currentSupportNumber = 601;
      }
      if (pagePipelineNumber) {
        lastPipelineNumber = pagePipelineNumber;
      }
      
      if (pageWelds.length === 0) {
        console.log(`   第${pageNum}页: 无焊点，跳过`);
        continue;
      }
      
      console.log(`   📄 处理第${pageNum}页: ${pageWelds.length} 个焊点`);
      const regularPageWelds = pageWelds.filter(weld => weld.isWeldedSupport !== true);
      const supportPageWelds = pageWelds.filter(weld => weld.isWeldedSupport === true);
      
      // 检查是否有管道数据
      const hasPipelineData = pipelineData.mainPipes && pipelineData.mainPipes.length > 0;
      
      if (hasPipelineData && regularPageWelds.length > 0) {
        // 使用智能编号（主管优先，从端点开始）
        const pageNumberingSequence = this.generatePageSmartNumbering(
          regularPageWelds,
          pipelineData,
          currentNumber,
          prefix,
          pageNum
        );
        
        pageNumberingSequence.forEach(item => {
          const numberedItem = {
            ...item,
            batchRunId: this.activeBatchRunId,
            displayNumber: `${prefix}${item.weldNumber}${suffix}`,
            pipelineNumber: pagePipelineNumber || item.pipelineNumber || '',
            pipeClass: pagePipeClass,
            pipelineClass: pagePipeClass
          };
          this.allWelds.push(numberedItem);
          this.allWeldsNumbered.push(numberedItem);
        });
        
        if (pageNumberingSequence.length > 0) {
          currentNumber = pageNumberingSequence[pageNumberingSequence.length - 1].weldNumber + 1;
        }
        
        console.log(`      ✅ 智能编号: ${pageNumberingSequence.length} 个焊点`);
      } else {
        // 回退到简单顺序编号
        console.log(`      ⚠️ 无管道数据，使用简单顺序编号（已添加空间排序）`);

        // 连续焊点距离作为强空间约束，避免旧的 x+y 扫描在两排焊点之间反复跳跃。
        const spatialSequence = buildSpatiallyContinuousWeldSequence(regularPageWelds, {
          pageInfo: this.getPageInfo(pageNum, this.pageVectors[pageNum] || []) || {}
        });
        const sortedPageWelds = spatialSequence.welds;
        if (spatialSequence.breaks.length > 0) {
          console.warn(
            `      ⚠️ 第${pageNum}页发现 ${spatialSequence.breaks.length} 次连续焊点距离过大，` +
            `最大合理距离 ${spatialSequence.maxDistance.toFixed(1)}；已按最近可用焊点继续排序。`
          );
        }
      
        sortedPageWelds.forEach((weld, pageIndex) => {
          const number = currentNumber++;
          const displayNumber = `${prefix}${number}${suffix}`;
        
          const numberedWeld = {
            ...weld,
            batchRunId: this.activeBatchRunId,
            globalIndex: this.allWelds.length,
            weldNumber: number,
            displayNumber: displayNumber,
            pageNum: pageNum,
            pageIndex: pageIndex,
            pipelineNumber: pagePipelineNumber || '',
            pipeClass: pagePipeClass,
            pipelineClass: pagePipeClass,
            pipelineType: 'unknown'
          };
        
          this.allWelds.push(numberedWeld);
          this.allWeldsNumbered.push(numberedWeld);
        });
      }

      const sortedSupportWelds = [...supportPageWelds].sort((a, b) => {
        const coordsA = a.center || { x: 0, y: 0 };
        const coordsB = b.center || { x: 0, y: 0 };
        return (coordsA.x + coordsA.y) - (coordsB.x + coordsB.y);
      });
      sortedSupportWelds.forEach((weld, supportIndex) => {
        const number = currentSupportNumber++;
        const numberedWeld = {
          ...weld,
          batchRunId: this.activeBatchRunId,
          globalIndex: this.allWelds.length,
          weldNumber: number,
          displayNumber: String(number),
          pageNum,
          pageIndex: regularPageWelds.length + supportIndex,
          pipelineNumber: pagePipelineNumber || weld.pipelineNumber || '',
          pipeClass: pagePipeClass,
          pipelineClass: pagePipeClass,
          pipelineType: 'welded-support'
        };
        this.allWelds.push(numberedWeld);
        this.allWeldsNumbered.push(numberedWeld);
      });
    }
    
    this.pipelineStats = buildPipelineStats(
      this.pageTextDetections,
      this.allWelds,
      startPage,
      endPage
    );
    this.pipelineComparison = this.pipelineReferenceData
      ? buildPipelineComparison(this.pipelineReferenceData, this.pipelineStats)
      : null;
    const pipelineSummary = getPipelineStatsSummary(this.pipelineStats);
    
    this.updateProgress(1, 1, `完成! 共 ${this.allWelds.length} 个焊点`);
    
    console.log(`✅ 多页焊点智能编号完成: 共 ${this.allWelds.length} 个焊点`);
    console.log(
      `🧾 管线核对统计: ${pipelineSummary.totalGroups} 组，` +
      `${pipelineSummary.matchedGroups} 组已匹配，` +
      `${pipelineSummary.unresolvedGroups} 组未识别`
    );
    if (this.pipelineComparison) {
      console.log(
        `📘 Excel对账结果: ${this.pipelineComparison.summary.matchedCount} 条一致，` +
        `${this.pipelineComparison.summary.countMismatchCount} 条数量异常，` +
        `${this.pipelineComparison.summary.missingInPdfCount} 条PDF缺失，` +
        `${this.pipelineComparison.summary.missingInExcelCount} 条Excel缺失，` +
        `${this.pipelineComparison.summary.unresolvedCount} 条未识别`
      );
    }
    console.log(`📊 各页分布:`);
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const count = this.allWelds.filter(w => w.pageNum === pageNum).length;
      if (count > 0) {
      console.log(`   第${pageNum}页: ${count} 个焊点`);
      }
    }
    
    return this.allWelds;
  }

  /**
   * 为单页生成智能编号序列（主管优先，从端点开始）
   * 🔧 修复：使用合并后的主管/支管进行编号，而不是按管道段逐个处理
   * 🔧 修复：防止同一焊点被重复编号（焊点可能同时靠近主管和支管）
   * 🔧 修复：焊点分配给距离最近的管道（三通竖杠上的焊点属于支管）
   */
  generatePageSmartNumbering(welds, pipelineData, startNumber, prefix, pageNum) {
    const { mainEndpoints, branchEndpoints, mergedMainPipe, mergedBranchPipes, mainPipes, branchPipes } = pipelineData;
    const weldNumberingSequence = [];
    let currentNumber = startNumber;
    
    // 🔧 关键：跟踪已编号的焊点ID，防止重复编号
    const numberedWeldIds = new Set();
    
    // 辅助函数：获取焊点唯一标识
    const getWeldId = (weld) => weld.pathId || weld.id || `${weld.center?.x || 0}_${weld.center?.y || 0}`;
    
    // 辅助函数：获取焊点坐标
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
      return { x: 0, y: 0 };
    };
    
    // 辅助函数：计算焊点到端点的距离
    const getDistanceToEndpoint = (weld, endpoint) => {
      const weldCoords = getWeldCoords(weld);
      const endpointCenter = {
        x: (endpoint.start.x + endpoint.end.x) / 2,
        y: (endpoint.start.y + endpoint.end.y) / 2
      };
      return Math.sqrt(Math.pow(weldCoords.x - endpointCenter.x, 2) + Math.pow(weldCoords.y - endpointCenter.y, 2));
    };
    
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
    
    // 辅助函数：计算焊点到线段数组的最短距离（用于新的编号逻辑）
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
    
    // 🔍 调试信息
    const mainPipeWeldCount = mergedMainPipe?.welds?.length || 0;
    const branchPipeCount = mergedBranchPipes?.length || 0;
    const branchWeldCount = mergedBranchPipes?.reduce((sum, p) => sum + (p.welds?.length || 0), 0) || 0;
    
    console.log(`   🔍 第${pageNum}页数据检查:`);
    console.log(`      焊点数: ${welds.length}`);
    console.log(`      合并后主管: ${mergedMainPipe ? 1 : 0} 根, ${mainPipeWeldCount} 个焊点`);
    console.log(`      合并后支管: ${branchPipeCount} 根, ${branchWeldCount} 个焊点`);
    console.log(`      主管端点: ${mainEndpoints?.length || 0}, 支管端点: ${branchEndpoints?.length || 0}`);
    
    // 🔧 关键：重新分配焊点到距离最近的管道（解决三通交汇点焊点归属问题）
    // 焊点应该属于距离它最近的管道，而不是被多个管道同时收集
    const reassignedMainWelds = [];
    const reassignedBranchWelds = {}; // {branchIndex: welds[]}
    
    // 🔧 使用所有主管段（包括未被合并的），而不仅仅是 mergedMainPipe.segments
    // 因为 mergedMainPipe 可能只包含从三通开始追踪的连通部分
    const allMainPipes = mainPipes || [];
    
    if (allMainPipes.length > 0 || (mergedBranchPipes && mergedBranchPipes.length > 0)) {
      console.log(`   🔧 重新分配焊点到最近的管道...`);
      console.log(`      使用所有主管段: ${allMainPipes.length} 个`);
      
      // 辅助函数：计算焊点到线段数组的最短距离
      const getDistanceToSegments = (weld, segments) => {
        const weldCoords = getWeldCoords(weld);
        let minDist = Infinity;
        
        segments.forEach(seg => {
          const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
          const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
          const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
          const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
          // 修复：参数顺序为 (点, 线段起点, 线段终点)
          const dist = getDistancePointToSegment(weldCoords, { x: x1, y: y1 }, { x: x2, y: y2 });
          if (dist < minDist) minDist = dist;
        });
        
        return minDist;
      };
      
      // 🔧 关键修复：先定义 allBranchPipes，使用 branchPipes（所有支管段），而不是 mergedBranchPipes.segments（合并后的段）
      const allBranchPipes = branchPipes || [];
      
      // 收集所有管道信息（使用所有主管段，而不仅仅是合并后的）
      const allPipes = [];
      
      // 添加所有主管段
      allMainPipes.forEach(pipe => {
        if (pipe.segments && pipe.segments.length > 0) {
          allPipes.push({ type: 'main', index: -1, pipeSegments: pipe.segments });
        }
      });
      
      // 🔧 添加所有支管段
      if (allBranchPipes.length > 0) {
        reassignedBranchWelds[0] = []; // 所有支管焊点归属到第一个支管组
        
        allBranchPipes.forEach(pipe => {
          if (pipe.segments && pipe.segments.length > 0) {
            allPipes.push({ type: 'branch', index: 0, pipeSegments: pipe.segments });
          }
        });
      }
      
      console.log(`      收集到 ${allPipes.length} 个管道用于焊点分配`);
      
      // 🔧 创建管道PathID到管道类型的映射
      const pipeIdToType = new Map();
      
      // 映射所有主管段
      allMainPipes.forEach(pipe => {
        pipeIdToType.set(pipe.pathId, { type: 'main', index: -1 });
      });
      
      console.log(`      🔍 主管PathID映射: ${Array.from(pipeIdToType.keys()).join(', ')}`);
      
      if (allBranchPipes.length > 0) {
        allBranchPipes.forEach(pipe => {
          // 支管段归属到第一个合并后的支管（idx=0）
          pipeIdToType.set(pipe.pathId, { type: 'branch', index: 0 });
        });
        console.log(`      🔍 支管PathID映射: ${Array.from(pipeIdToType.entries()).filter(([k, v]) => v.type === 'branch').map(([k]) => k).join(', ')}`);
      }
      
      console.log(`      📋 总共映射了 ${pipeIdToType.size} 个管道PathID`)
      
      // 对每个焊点进行分配
      let reassignCount = 0;
      welds.forEach(weld => {
        let targetPipe = null;
        
        // 🌟 策略1：优先保留原有的 relatedPipelineId 关联
        if (weld.relatedPipelineId !== undefined && pipeIdToType.has(weld.relatedPipelineId)) {
          targetPipe = pipeIdToType.get(weld.relatedPipelineId);
        } else {
          // 策略2：如果原关联不存在，才基于距离重新分配
          const coords = getWeldCoords(weld);
          
          if (weld.relatedPipelineId !== undefined) {
            console.log(`      🔍 焊点 (${coords.x.toFixed(1)}, ${coords.y.toFixed(1)}) relatedPipelineId=${weld.relatedPipelineId} 未在映射中找到，需要重新分配`);
          }
          
          let closestPipe = null;
          let closestDist = Infinity;
          
          allPipes.forEach(pipeInfo => {
            const dist = getDistanceToSegments(weld, pipeInfo.pipeSegments);
            if (dist < closestDist) {
              closestDist = dist;
              closestPipe = pipeInfo;
            }
          });
          
          if (closestPipe) {
            targetPipe = closestPipe;
            reassignCount++;
            
            // 输出重新分配的警告
            if (closestDist > 50) {
              console.log(`      ⚠️ 焊点 (${coords.x.toFixed(1)}, ${coords.y.toFixed(1)}) 重新分配到距离${closestDist.toFixed(1)}px的${closestPipe.type}管道`);
            }
          }
        }
        
        // 执行分配
        if (targetPipe) {
          if (targetPipe.type === 'main') {
            reassignedMainWelds.push(weld);
          } else {
            reassignedBranchWelds[targetPipe.index].push(weld);
          }
        }
      });
      
      console.log(`      ✅ 重新分配结果: 主管 ${reassignedMainWelds.length} 个焊点`);
      Object.keys(reassignedBranchWelds).forEach(idx => {
        console.log(`         支管${parseInt(idx) + 1}: ${reassignedBranchWelds[idx].length} 个焊点`);
      });
      console.log(`      📊 其中 ${reassignCount} 个焊点通过距离重新分配，${welds.length - reassignCount} 个焊点保留原关联`);
      
      // 检查是否有焊点未被分配
      const totalAssigned = reassignedMainWelds.length + 
        Object.values(reassignedBranchWelds).reduce((sum, arr) => sum + arr.length, 0);
      if (totalAssigned < welds.length) {
        console.log(`      ⚠️ 有 ${welds.length - totalAssigned} 个焊点未被分配（没有可用管道）`);
      } else {
        console.log(`      ✅ 所有 ${welds.length} 个焊点已分配到管道`);
      }
    }
    
    // 🔵 处理主管焊点编号（按管道段连续遍历）
    const mainWelds = reassignedMainWelds.length > 0 ? reassignedMainWelds : (mergedMainPipe?.welds || []);
    if (mainWelds.length > 0 && allMainPipes.length > 0) {
      console.log('   🔵 处理主管焊点编号（按管道段连续遍历）...');
      
      // 🔧 找到主管的端点 - 使用所有主管段的pathIds，而不仅仅是mergedMainPipe的
      const mainPipePathIds = new Set(allMainPipes.map(p => p.pathId));
      const pipeEndpoints = (mainEndpoints || []).filter(e => mainPipePathIds.has(e.pipelineId));
      console.log(`      主管共 ${mainWelds.length} 个焊点, ${allMainPipes.length} 个管道段, ${pipeEndpoints.length} 个端点`);
      
      // 辅助函数：计算管道段的中心点
      const getPipeSegmentCenter = (pipe) => {
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
      };
      
      // 辅助函数：计算管道段的尾端点（最远端）
      const getPipeSegmentTailEnd = (pipe, fromPoint) => {
        if (!pipe.segments || pipe.segments.length === 0) {
          return { x: 0, y: 0 };
        }
        
        // 收集所有端点
        const allPoints = [];
        pipe.segments.forEach(seg => {
          const x1 = seg.x1 ?? seg.p1?.x ?? seg.start?.x ?? 0;
          const y1 = seg.y1 ?? seg.p1?.y ?? seg.start?.y ?? 0;
          const x2 = seg.x2 ?? seg.p2?.x ?? seg.end?.x ?? 0;
          const y2 = seg.y2 ?? seg.p2?.y ?? seg.end?.y ?? 0;
          allPoints.push({ x: x1, y: y1 }, { x: x2, y: y2 });
        });
        
        // 找到离 fromPoint 最远的点作为尾端
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
      
      // 辅助函数：获取管道段的所有端点
      const getPipeSegmentEndpoints = (pipe) => {
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
      const getDistanceToNearestPipeEndpoint = (point, pipe) => {
        const endpoints = getPipeSegmentEndpoints(pipe);
        if (endpoints.length === 0) return Infinity;
        
        let minDist = Infinity;
        endpoints.forEach(ep => {
          const dist = Math.sqrt(Math.pow(ep.x - point.x, 2) + Math.pow(ep.y - point.y, 2));
          if (dist < minDist) minDist = dist;
        });
        
        return minDist;
      };
      
      // 辅助函数：获取管道段上的焊点
      const getWeldsOnPipe = (pipe) => {
        // 🔧 修复：使用第一阶段的精确关联关系，不重新计算距离
        // 避免收集附近其他管道段的焊点
        return mainWelds.filter(weld => {
          return weld.relatedPipelineId === pipe.pathId;
        });
      };
      
      // 1. 确定起始管道段：选择离端点最近的有焊点的管道段
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
        const pipesWithWelds = allMainPipes.map(pipe => ({
          pipe,
          welds: getWeldsOnPipe(pipe),
          distToEndpoint: Math.sqrt(
            Math.pow(getPipeSegmentCenter(pipe).x - startPoint.x, 2) + 
            Math.pow(getPipeSegmentCenter(pipe).y - startPoint.y, 2)
          )
        }));
        
        // 先找有焊点的管道段
        const pipesWithWeldsOnly = pipesWithWelds.filter(p => p.welds.length > 0);
        
        if (pipesWithWeldsOnly.length > 0) {
          const sorted = pipesWithWeldsOnly.sort((a, b) => a.distToEndpoint - b.distToEndpoint);
          startPipe = sorted[0].pipe;
          console.log(`      ✅ 起始管道段（有焊点）: pathId=${startPipe.pathId}, 距端点 ${sorted[0].distToEndpoint.toFixed(1)}px, ${sorted[0].welds.length} 个焊点`);
        } else {
          const sorted = pipesWithWelds.sort((a, b) => a.distToEndpoint - b.distToEndpoint);
          startPipe = sorted[0].pipe;
          console.log(`      ⚠️ 起始管道段（无焊点）: pathId=${startPipe.pathId}, 距端点 ${sorted[0].distToEndpoint.toFixed(1)}px`);
        }
      } else {
        // 无端点：选择最左上的有焊点管道段
        console.log(`      ⚠️ 无端点，选择最左上的有焊点管道段`);
        
        const pipesWithWelds = allMainPipes.filter(pipe => getWeldsOnPipe(pipe).length > 0);
        
        if (pipesWithWelds.length > 0) {
          startPipe = pipesWithWelds.reduce((best, pipe) => {
            const centerA = getPipeSegmentCenter(pipe);
            const centerB = getPipeSegmentCenter(best);
            return (centerA.x + centerA.y) < (centerB.x + centerB.y) ? pipe : best;
          });
        } else {
          startPipe = allMainPipes.reduce((best, pipe) => {
            const centerA = getPipeSegmentCenter(pipe);
            const centerB = getPipeSegmentCenter(best);
            return (centerA.x + centerA.y) < (centerB.x + centerB.y) ? pipe : best;
          });
        }
        startPoint = getPipeSegmentCenter(startPipe);
      }
      
      // 2. 按管道段连续遍历编号
      const visitedPipes = new Set();
      let currentPipe = startPipe;
      let currentTailEnd = startPoint;
      let sortedWelds = [];
      
      console.log(`      🔄 开始沿管道段遍历...`);
      
      while (currentPipe && visitedPipes.size < allMainPipes.length) {
        visitedPipes.add(currentPipe.pathId);
        
        // 获取当前管道段上的焊点
        const pipeWelds = getWeldsOnPipe(currentPipe);
        
        if (pipeWelds.length > 0) {
          // 按距离当前尾端的距离排序（近的优先）
          const sortedPipeWelds = pipeWelds.map(weld => ({
            ...weld,
            distToTail: Math.sqrt(
              Math.pow(getWeldCoords(weld).x - currentTailEnd.x, 2) +
              Math.pow(getWeldCoords(weld).y - currentTailEnd.y, 2)
            )
          })).sort((a, b) => a.distToTail - b.distToTail);
          
          // 🔧 关键修复：只添加尚未在序列中的焊点（避免三通位置的焊点重复）
          const addedWeldIds = new Set(sortedWelds.map(w => getWeldId(w)));
          const newWelds = sortedPipeWelds.filter(weld => !addedWeldIds.has(getWeldId(weld)));
          
          sortedWelds.push(...newWelds);
          console.log(`         管道段 ${currentPipe.pathId}: ${pipeWelds.length} 个焊点 (新增 ${newWelds.length} 个)`);
        } else {
          console.log(`         管道段 ${currentPipe.pathId}: 无焊点，继续下一段`);
        }
        
        // 计算当前管道段的尾端
        currentTailEnd = getPipeSegmentTailEnd(currentPipe, currentTailEnd);
        
        // 找到离当前尾端最近的未访问管道段
        let nextPipe = null;
        let minDist = Infinity;
        
        allMainPipes.forEach(pipe => {
          if (visitedPipes.has(pipe.pathId)) return;
          
          // 计算当前尾端到候选管道段最近端点的距离
          const dist = getDistanceToNearestPipeEndpoint(currentTailEnd, pipe);
          
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
      
      // 打印前5个焊点的排序信息
      console.log(`      主管焊点排序（前${Math.min(5, sortedWelds.length)}个）:`);
      sortedWelds.slice(0, 5).forEach((weld, i) => {
        const coords = getWeldCoords(weld);
        console.log(`         ${i + 1}. 焊点(${coords.x.toFixed(1)}, ${coords.y.toFixed(1)}) → 编号${currentNumber + i}`);
      });
      
      // 为主管焊点编号
      sortedWelds.forEach(weld => {
        const weldId = getWeldId(weld);
        
        // 🔧 跳过已编号的焊点
        if (numberedWeldIds.has(weldId)) {
          console.log(`      ⚠️ 焊点 ${weldId} 已被编号，跳过`);
          return;
        }
        
        const number = currentNumber++;
        const displayNumber = prefix ? `${prefix}${number}` : `${number}`;
        
        weldNumberingSequence.push({
          ...weld,
          weldNumber: number,
          displayNumber: displayNumber,
          pageNum: pageNum,
          pipelineType: 'main',
          pipelineId: weld.relatedPipelineId || 'main'
        });
        
        // 🔧 标记为已编号
        numberedWeldIds.add(weldId);
      });
      
      console.log(`      ✅ 主管 ${sortedWelds.length} 个焊点已编号 (${currentNumber - sortedWelds.length} ~ ${currentNumber - 1})`);
    }
    
    // 🟠 处理支管焊点编号（使用重新分配后的支管列表）
    if (mergedBranchPipes && mergedBranchPipes.length > 0) {
      console.log('   🟠 处理支管焊点编号...');
      
      mergedBranchPipes.forEach((branchPipe, pipeIndex) => {
        // 🔧 使用重新分配的焊点列表，如果没有则使用原始列表
        const allBranchWelds = (reassignedBranchWelds[pipeIndex] && reassignedBranchWelds[pipeIndex].length > 0)
          ? reassignedBranchWelds[pipeIndex]
          : (branchPipe.welds || []);
        
        // 🔧 关键：过滤掉已经被编号的焊点（可能已在主管中被编号）
        const branchWelds = allBranchWelds.filter(weld => {
          const weldId = getWeldId(weld);
          return !numberedWeldIds.has(weldId);
        });
        
        const skippedCount = allBranchWelds.length - branchWelds.length;
        if (skippedCount > 0) {
          console.log(`      支管${pipeIndex + 1}: ⚠️ 跳过 ${skippedCount} 个已编号的焊点`);
        }
        
        if (branchWelds.length === 0) {
          console.log(`      支管${pipeIndex + 1}: ❌ 无待编号焊点，跳过`);
          return;
        }
        
        const branchPipePathIds = new Set(branchPipe.pathIds || []);
        const teeCenter = branchPipe.teeCenter; // 🔧 三通中心位置
        
        // 🔧 关键修复：将该支管焊点关联到的 pathId 也纳入支管段集合
        // 避免 branchPipe.segments 仅保留"代表段"导致遍历段数偏少
        const branchPipeById = new Map((branchPipes || []).map(p => [p.pathId, p]));
        const weldRelatedPathIds = new Set();
        branchWelds.forEach(weld => {
          const pid = weld.relatedPipelineId;
          if (pid !== undefined && pid !== null && branchPipeById.has(pid)) {
            weldRelatedPathIds.add(pid);
          }
        });
        weldRelatedPathIds.forEach(pid => branchPipePathIds.add(pid));
        
        // 找到该支管的端点（基于扩展后的 pathId 集合）
        let pipeEndpoints = (branchEndpoints || []).filter(e => branchPipePathIds.has(e.pipelineId));
        console.log(`      支管${pipeIndex + 1}: ${branchWelds.length} 个焊点, ${pipeEndpoints.length} 个端点`);
        
        // 🔧 修复：如果当前支管没有匹配到端点，尝试使用全局支管端点
        if (pipeEndpoints.length === 0 && branchEndpoints && branchEndpoints.length > 0) {
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
        // 这样编号从支管外端开始，与单页处理一致
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
        
        // 🔧 获取该支管的所有管道段（使用扩展后的 pathId 集合）
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
        let sortedWelds = [];
        
        if (branchPipeSegments.length > 0) {
          console.log(`      支管${pipeIndex + 1}: 按管道段连续遍历 (${branchPipeSegments.length} 段)`);
          
          // 辅助函数：获取支管管道段上的焊点
          const getWeldsOnBranchPipe = (pipeSegment) => {
            // 🔧 修复：使用第一阶段的精确关联关系，不重新计算距离
            return branchWelds.filter(weld => {
              return weld.relatedPipelineId === pipeSegment.pathId;
            });
          };
          
          // 辅助函数：获取管道段中心
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
          
          // 辅助函数：计算管道段的尾端
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
          
          while (currentSegment && visitedSegments.size < branchPipeSegments.length) {
            const segId = branchPipeSegments.indexOf(currentSegment);
            visitedSegments.add(segId);
            
            // 获取当前管道段上的焊点
            const segWelds = getWeldsOnBranchPipe(currentSegment);
            
            if (segWelds.length > 0) {
              // 按距离当前尾端排序
              const sortedSegWelds = segWelds.map(weld => ({
                ...weld,
                distToTail: Math.sqrt(
                  Math.pow(getWeldCoords(weld).x - currentTailEnd.x, 2) +
                  Math.pow(getWeldCoords(weld).y - currentTailEnd.y, 2)
                )
              })).sort((a, b) => a.distToTail - b.distToTail);
              
              // 🔧 关键修复：只添加尚未在序列中的焊点（避免三通位置的焊点重复）
              const addedWeldIds = new Set(sortedWelds.map(w => getWeldId(w)));
              const newWelds = sortedSegWelds.filter(weld => !addedWeldIds.has(getWeldId(weld)));
              
              sortedWelds.push(...newWelds);
              console.log(`         段${segId + 1}: ${segWelds.length} 个焊点 (新增 ${newWelds.length} 个)`);
            }
            
            // 计算当前段的尾端
            currentTailEnd = getBranchPipeTailEnd(currentSegment, currentTailEnd);
            
            // 找到离当前尾端最近的未访问管道段
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
          
          console.log(`         遍历完成，访问 ${visitedSegments.size} 段`);
        } else {
          // 无管道段信息：使用旧逻辑（按距离端点排序）
          console.log(`      支管${pipeIndex + 1}: ⚠️ 无管道段信息，使用简单排序`);
          
          if (pipeEndpoints.length > 0) {
            const startEndpoint = pipeEndpoints[0];
            sortedWelds = branchWelds.map(weld => ({
              ...weld,
              distanceToStart: getDistanceToEndpoint(weld, startEndpoint)
            })).sort((a, b) => a.distanceToStart - b.distanceToStart);
          } else {
            sortedWelds = branchWelds.map(weld => {
              const coords = getWeldCoords(weld);
              return {
                ...weld,
                distanceToStart: coords.x + coords.y
              };
            }).sort((a, b) => a.distanceToStart - b.distanceToStart);
          }
        }
        
        // 为支管焊点编号
        sortedWelds.forEach(weld => {
          const weldId = getWeldId(weld);
          
          // 🔧 跳过已编号的焊点（双重保险）
          if (numberedWeldIds.has(weldId)) {
            return;
          }
          
          const number = currentNumber++;
          const displayNumber = prefix ? `${prefix}${number}` : `${number}`;
          
          weldNumberingSequence.push({
            ...weld,
            weldNumber: number,
            displayNumber: displayNumber,
            pageNum: pageNum,
            pipelineType: 'branch',
            pipelineId: weld.relatedPipelineId || `branch-${pipeIndex}`
          });
          
          // 🔧 标记为已编号
          numberedWeldIds.add(weldId);
        });
        
        console.log(`      支管${pipeIndex + 1}: ✅ ${sortedWelds.length} 个焊点已编号 (${currentNumber - sortedWelds.length} ~ ${currentNumber - 1})`);
      });
    }
    
    // 🔴 关键：处理未被关联到主管/支管的焊点
    // 这些焊点可能距离主管/支管超过20px阈值，或位于未被识别的管道上
    // 🔧 使用已有的 numberedWeldIds 集合，而不是重新创建
    const unnumberedWelds = welds.filter(weld => {
      const weldId = getWeldId(weld);
      return !numberedWeldIds.has(weldId);
    });
    
    if (unnumberedWelds.length > 0) {
      console.log(`   ⚠️ 发现 ${unnumberedWelds.length} 个未关联到主管/支管的焊点，添加到编号序列末尾`);
      
      // 按默认顺序排序（从左上到右下）
      const sortedUnumbered = unnumberedWelds.map(weld => {
        const coords = getWeldCoords(weld);
        return {
          ...weld,
          distanceToStart: coords.x + coords.y
        };
      }).sort((a, b) => a.distanceToStart - b.distanceToStart);
      
      sortedUnumbered.forEach((weld, index) => {
        const number = currentNumber++;
        const displayNumber = prefix ? `${prefix}${number}` : `${number}`;
        const coords = getWeldCoords(weld);
        
        weldNumberingSequence.push({
          ...weld,
          weldNumber: number,
          displayNumber: displayNumber,
          pageNum: pageNum,
          pipelineType: 'unassociated',
          pipelineId: weld.relatedPipelineId || 'unknown'
        });
        
        if (index < 3) {
          console.log(`      ${index + 1}. 未关联焊点(${coords.x.toFixed(1)}, ${coords.y.toFixed(1)}) → 编号${number}`);
        }
      });
      
      console.log(`      ✅ ${unnumberedWelds.length} 个未关联焊点已编号 (${currentNumber - unnumberedWelds.length} ~ ${currentNumber - 1})`);
    }
    
    console.log(`   ✅ 第${pageNum}页编号完成: 共 ${weldNumberingSequence.length} 个焊点 (主管优先)`);
    console.log(`   📝 架构说明:`);
    console.log(`      - 端点检测: 基于所有管道段（主管+支管）`);
    console.log(`      - 焊点编号: 基于merged分组（主管分组+支管分组）`);
    console.log(`      - 🔧 端点可能属于未被包含在分组中的管道段，已自动匹配最近端点`);
    
    return weldNumberingSequence;
  }

  /**
   * 一键执行完整的多页处理流程
   * @param {Object} pdfDocument - PDF.js文档对象
   * @param {string} pdfPath - PDF文件路径
   * @param {number} startPage - 起始页码
   * @param {number} endPage - 结束页码
   * @param {Object} options - 选项
   * @returns {Promise<Object>} - 处理结果
   */
  async runFullProcess(pdfDocument, pdfPath, startPage, endPage, options = {}) {
    const {
      enableOCRFilter = true,
      startNumber = 1,
      prefix = '',
      templateData = null
    } = options;
    const weldRecognitionArea = options.weldRecognitionArea || templateData?.weldRecognitionArea || null;
    this.weldRecognitionArea = weldRecognitionArea;
    
    if (this.isProcessing) {
      throw new Error('已有处理任务在进行中');
    }
    
    this.isProcessing = true;
    this.reset();
    
    const startTime = performance.now();
    
    try {
      console.log('═'.repeat(60));
      console.log(`🚀 开始多页批量处理: 第${startPage}页 到 第${endPage}页`);
      console.log('═'.repeat(60));
      
      // 步骤1：多页矢量提取
      console.log('\n📐 步骤1/4: 多页矢量信息提取...');
      await this.extractVectorsFromPages(pdfDocument, startPage, endPage);
      
      // 步骤2：多页OCR文字识别
      console.log('\n📝 步骤2/4: 多页文字识别...');
      await this.detectTextFromPages(pdfPath, startPage, endPage, templateData);
      
      // 步骤3：多页焊点识别
      console.log('\n🔥 步骤3/5: 多页焊点识别...');
      await this.detectWeldsFromPages(startPage, endPage, enableOCRFilter, weldRecognitionArea);
      // 步骤4：多页管道识别（区分主管/支管，用于智能编号）
      console.log('\n🔗 步骤4/5: 多页管道识别...');
      await this.detectPipelinesFromPages(startPage, endPage);
      
      // 步骤5：生成编号
      console.log('\n🔢 步骤5/5: 生成焊点编号...');
      this.generateWeldNumbers(startPage, endPage, startNumber, prefix);
      
      const endTime = performance.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);
      
      console.log('\n' + '═'.repeat(60));
      console.log(`✅ 多页批量处理完成! 耗时: ${duration}秒`);
      console.log(`📊 总计: ${this.allWelds.length} 个焊点`);
      console.log('═'.repeat(60));
      
      this.updateStep('completed');
      
      return {
        success: true,
        pageVectors: this.pageVectors,
        pageTextDetections: this.pageTextDetections,
        pageWelds: this.pageWelds,
        pageSpecialWeldNotices: this.pageSpecialWeldNotices,
        allWelds: this.allWelds,
        pipelineStats: this.pipelineStats,
        statistics: {
          totalPages: endPage - startPage + 1,
          totalWelds: this.allWelds.length,
          duration: parseFloat(duration),
          pageStats: this.getPageStats(startPage, endPage),
          pipelineStats: this.pipelineStats
        }
      };
      
    } catch (error) {
      console.error('❌ 多页批量处理失败:', error);
      this.updateStep('error');
      return {
        success: false,
        error: error.message
      };
      
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 获取各页统计信息
   */
  getPageStats(startPage, endPage) {
    const stats = [];
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      stats.push({
        pageNum,
        vectorCount: (this.pageVectors[pageNum] || []).length,
        textCount: (this.pageTextDetections[pageNum]?.detections || []).length,
        weldCount: (this.pageWelds[pageNum] || []).length,
        specialWeldNotices: this.pageSpecialWeldNotices[pageNum] || [],
        pipelineNumber: this.pageTextDetections[pageNum]?.pipelineNumber || '',
        pipelineStatus: this.pageTextDetections[pageNum]?.pipelineStatus || 'unresolved',
        pipelineCandidateCount: (this.pageTextDetections[pageNum]?.pipelineCandidates || []).length,
        pipelineEngine: this.pageTextDetections[pageNum]?.pipelineEngine || 'paddleocr',
        pipelineFallbackUsed: !!this.pageTextDetections[pageNum]?.pipelineFallbackUsed
      });
    }
    return stats;
  }

  /**
   * 将焊点数据转换为标注格式
   * @param {number} scale - 当前缩放比例
   * @param {Object} annotationRule - 当前标注规则
   * @param {string} sortStrategy - 排序策略（可选）
   * @param {Array} flowArrows - 流向箭头列表（可选）
   * @returns {Array} - 标注对象数组
   */
  convertWeldsToAnnotations(
    scale,
    annotationRule = null,
    sortStrategy = null,
    flowArrows = null,
    layoutContext = null
  ) {
    if (!this.allWelds || this.allWelds.length === 0) {
      console.warn('没有焊点数据可转换');
      return [];
    }
    
    console.log(`🔄 开始转换焊点为标注，共 ${this.allWelds.length} 个焊点，scale=${scale}`);
    
    const annotations = [];
    const requestedColor = annotationRule?.color || '#ff0000';
    const baseColor = String(requestedColor).toLowerCase() === '#ff4d4f'
      ? '#ff0000'
      : requestedColor;
    const baseFontSize = annotationRule?.fontSize || 34;
    const baseFrameSize = annotationRule?.frameSize || 56.7;
    const baseFrameSizeMode = getAnnotationFrameSizeMode(annotationRule);
    const borderShape = annotationRule?.borderShape || 'circle';
    const batchContent = annotationRule?.batchContent || {};
    
    // 按页面分组处理焊点
    const weldsByPage = {};
    const pipelinesByPage = {}; // 同时收集每页的管道数据
    
    this.allWelds.forEach(weld => {
      if (!weldsByPage[weld.pageNum]) {
        weldsByPage[weld.pageNum] = [];
      }
      weldsByPage[weld.pageNum].push(weld);
      
      // 收集管道信息
      if (weld.relatedPipeline && !pipelinesByPage[weld.pageNum]) {
        pipelinesByPage[weld.pageNum] = [];
      }
      if (weld.relatedPipeline) {
        // 避免重复添加同一管道
        const exists = pipelinesByPage[weld.pageNum].some(p => p.pathId === weld.relatedPipeline.pathId);
        if (!exists) {
          pipelinesByPage[weld.pageNum].push(weld.relatedPipeline);
        }
      }
    });
    
    // 对每一页的焊点进行布局计算
    Object.keys(weldsByPage).forEach(pageNum => {
      const pageWelds = weldsByPage[pageNum];
      const pagePipelines = pipelinesByPage[pageNum] || [];
      const pageVectors = layoutContext?.pageVectors?.[pageNum] || this.pageVectors[pageNum] || [];
      const pageOcrData = layoutContext?.pageTextDetections?.[pageNum] || this.pageTextDetections[pageNum];
      const overridePageInfo = pageOcrData?.page_info;
      const overrideWidth = overridePageInfo?.page_width || overridePageInfo?.width || 0;
      const overrideHeight = overridePageInfo?.page_height || overridePageInfo?.height || 0;
      const pageInfo = overrideWidth > 0 && overrideHeight > 0
        ? {
          ...overridePageInfo,
          page_width: overrideWidth,
          page_height: overrideHeight
        }
        : this.getPageInfo(pageNum, pageVectors);
      const annotationPageSize = {
        width: pageInfo?.page_width || pageInfo?.width,
        height: pageInfo?.page_height || pageInfo?.height,
        _fromVectors: pageInfo?._fromVectors === true
      };
      const scaledFontSize = scaleAnnotationValue(baseFontSize, annotationPageSize, baseFontSize);
      const pageFrameSetting = pageWelds.find(weld => Number.isFinite(Number(weld?.annotationFrameSize)));
      const pageFrameSizeMode = pageFrameSetting?.annotationFrameSizeMode || baseFrameSizeMode;
      const pageFrameSize = resolveAnnotationFrameSize({
        annotation: {
          borderShape,
          frameSize: Number(pageFrameSetting?.annotationFrameSize) || baseFrameSize,
          frameSizeMode: pageFrameSizeMode
        },
        pageSize: this.pagePdfSizes[pageNum] || annotationPageSize,
        fallbackMode: baseFrameSizeMode,
        fallbackSize: baseFrameSize
      });
      const pageMaterialRows = batchContent.materialRowsByPage?.[pageNum] ||
        batchContent.materialRowsByPage?.[String(pageNum)] || [];
      const materialText = row => [
        row?.description,
        row?.materialDescription,
        row?.DESCRIPTION,
        row?.rawMaterial?.DESCRIPTION,
        row?.rawLogicalRow
      ].flat(Infinity).filter(Boolean).join(' ').normalize('NFKC').toUpperCase();
      const fittingMaterialRowsByType = {
        'branch-outlet': pageMaterialRows.filter(row => (
          /支管台|焊接支管座|\bWELD(?:ING)?\s*OUTLET\b|\bWELDOLET\b|\bOLET\b/.test(materialText(row))
        )),
        elbow: pageMaterialRows.filter(row => /弯头|弯管|\bELBOW\b|\bBEND\b/.test(materialText(row))),
        'tee-fitting': pageMaterialRows.filter(row => (
          (/三通|\bTEE\b/.test(materialText(row))) &&
          !/\bWELD(?:ING)?\s*OUTLET\b|\bWELDOLET\b|\bOLET\b/.test(materialText(row))
        )),
        'valve-fitting': pageMaterialRows.filter(row => /阀|\bVALVE\b/.test(materialText(row)))
      };
      const fittingMaterialContentByType = Object.fromEntries(
        Object.entries(fittingMaterialRowsByType).map(([type, rows]) => {
          const diameters = Array.from(new Set(rows
            .flatMap(extractDiameterMaterialSizesMm)
            .map(convertMaterialSizeMmToIntegerInch)
            .filter(Boolean)));
          const jointTypes = Array.from(new Set(rows
            .map(row => extractJointTypeFromMaterialDescription(materialText(row)))
            .filter(Boolean)));
          return [type, {
            diameter: diameters.length === 1 ? diameters[0] : '',
            jointType: jointTypes.length === 1 ? jointTypes[0] : '',
            ambiguousDiameter: diameters.length > 1,
            ambiguousJointType: jointTypes.length > 1,
            materialRowCount: rows.length
          }];
        })
      );
      
      console.log(`📄 处理第 ${pageNum} 页，共 ${pageWelds.length} 个焊点, ${pagePipelines.length} 根管道`);
      console.log(`   排序策略: ${sortStrategy || 'default'}`);
      console.log(`   前3个焊点编号:`, pageWelds.slice(0, 3).map(w => w.weldNumber || w.number));
      
      // 从当前页 OCR 数据派生文字区域，用于标注圆避让
      const pageTextRegions = (() => {
        if (!pageOcrData?.page_info) return null;
        const pi = pageOcrData.page_info;
        const pw = pi.page_width || pi.width || 0;
        const ph = pi.page_height || pi.height || 0;
        if (!pw || !ph) return null;
        return ObjectRecognizer.convertOCRDetectionsToTextRegions(
          pageOcrData.detections || [], { width: pw, height: ph }
        );
      })();

      // 使用 calculateWeldLayout 计算布局（与单独按钮一致）
      // 固定在 PDF 基准坐标（PDF原始点 * 2.0）下计算
      // 传入排序策略、管道数据、流向箭头、文字区域
      const layoutData = calculateWeldLayout(
        pageWelds, 
        PDF_LAYOUT_BASE_SCALE, 
        sortStrategy, 
        null,
        flowArrows,
        pageTextRegions,
        {
          normalizedPlacementArea: layoutContext?.weldRecognitionArea !== undefined
            ? layoutContext.weldRecognitionArea
            : this.weldRecognitionArea,
          pageSize: annotationPageSize._fromVectors ? null : annotationPageSize,
          graphicVectors: pageVectors,
          circleDiameter: pageFrameSize,
          allowLeaderThroughGraphics: true,
          allowLeaderCrossing: false
        }
      );
      
      console.log(`   布局后前3个焊点编号:`, layoutData.slice(0, 3).map(w => w.weldNumber || w.number));
      
      // 转换为标注对象
      // 🔑 关键：layoutData 中的每个 item 已经包含了完整的 weld 数据
      // 不要使用 pageWelds[index]，因为 calculateWeldLayout 可能已经重新排序
      layoutData.forEach((item, index) => {
        const weld = item; // 直接使用 layoutData 中的数据，它已经包含了原始焊点的所有信息
        const canonicalDisplayNumber = getCanonicalWeldDisplayNumber(weld);
        const stableWeldKey = weld.sourceStableKey || weld.stableKey || (weld.manualInsertId
          ? `manual:${weld.manualInsertId}`
          : (
            weld.id !== undefined && weld.id !== null && weld.id !== ''
              ? `id:${weld.id}`
              : `path:${weld.pathId ?? 'none'}:center:${Number(weld.center?.x || 0).toFixed(2)}:${Number(weld.center?.y || 0).toFixed(2)}`
          ));
        const upperSource = batchContent.upperSource || 'rule';
        let topText = '';
        let jointTypeText = '';
        let resolvedUpperContent = null;
        const usesStructuredSplitContent = !!(
          batchContent.diameterSource ||
          batchContent.jointTypeSource
        );
        if (usesStructuredSplitContent) {
          resolvedUpperContent = resolveBatchSplitUpperContent({
            batchContent,
            pageNum,
            pipelineNumber: weld.pipelineNumber || '',
            weldNumber: weld.weldNumber
          });
          topText = resolvedUpperContent.diameter;
          jointTypeText = resolvedUpperContent.jointType;
        } else if (upperSource === 'fixed') {
          topText = String(batchContent.fixedUpperText || '');
        } else if (upperSource === 'pipeline') {
          topText = String(weld.pipelineNumber || '');
        } else if (upperSource === 'page') {
          topText = `第${pageNum}页`;
        } else if (upperSource === 'rule') {
          jointTypeText = String(annotationRule?.jointTypeText || '');
        }
        const fittingEvidence = (Array.isArray(weld.detectedFittings) ? weld.detectedFittings : [])
          .slice()
          .sort((left, right) => (
            Number(right.type === 'branch-outlet') - Number(left.type === 'branch-outlet')
          ))[0] || null;
        if (fittingEvidence) {
          const fittingContent = fittingMaterialContentByType[fittingEvidence.type] || {};
          if (fittingContent.diameter) topText = fittingContent.diameter;
          if (fittingEvidence.type === 'branch-outlet' && fittingEvidence.role === 'main-connection') {
            jointTypeText = 'OL';
          } else if (fittingContent.jointType) {
            jointTypeText = fittingContent.jointType;
          }
          resolvedUpperContent = {
            ...(resolvedUpperContent || {}),
            diameter: topText,
            jointType: jointTypeText,
            fittingType: fittingEvidence.type,
            fittingRole: fittingEvidence.role || '',
            fittingMaterialRowCount: fittingContent.materialRowCount || 0,
            fittingMaterialAmbiguous: !!(
              fittingContent.ambiguousDiameter || fittingContent.ambiguousJointType
            ),
            source: fittingContent.materialRowCount > 0
              ? 'multi-page-fitting-material'
              : 'multi-page-fitting-geometry'
          };
        }
        if (weld.isWeldedSupport === true) {
          topText = '';
          jointTypeText = 'AW';
          resolvedUpperContent = {
            diameter: '',
            jointType: 'AW',
            source: 'welded-support',
            supportCode: weld.supportCode || ''
          };
        }
        if (weld.annotationTopText !== undefined) {
          topText = String(weld.annotationTopText || '');
        }
        if (weld.annotationJointTypeText !== undefined) {
          jointTypeText = String(weld.annotationJointTypeText || '');
        }
        
        const resolvedBorderShape = weld.isWeldedSupport === true
          ? 'split-circle'
          : (weld.annotationBorderShape || borderShape);
        const annotation = {
          id: `weld-batch-${pageNum}-${index}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: 'text',
          page: parseInt(pageNum),
          
          // layoutData 直接输出 PDF 基准坐标（PDF原始点 * 2.0）
          startX: item.startX,
          startY: item.startY,
          endX: item.endX,
          endY: item.endY,
          
          // 最终结果强制跟随当前规范编号，旧缓存仅用于保留前后缀格式。
          text: canonicalDisplayNumber,
          color: weld.annotationColor || baseColor,
          fontSize: Number(weld.annotationFontSize) || scaledFontSize,
          frameSize: pageFrameSize,
          frameSizeMode: weld.annotationFrameSizeMode || pageFrameSizeMode,
          borderShape: resolvedBorderShape,
          topText,
          jointTypeText,
          batchMaterialContent: resolvedUpperContent,
          layoutDiagnostics: weld.layoutDiagnostics || null,
          topFontSize: Number(weld.annotationTopFontSize) || annotationRule?.topFontSize,
          bottomFontSize: Number(weld.annotationBottomFontSize) || annotationRule?.bottomFontSize,
          hasLeaderLine: true,
          remark: batchContent.remark ?? annotationRule?.remark ?? '批量自动生成',
          ruleId: annotationRule?.id,
          ruleName: annotationRule?.name,
          pipelineNumber: weld.pipelineNumber || '',
          pipelineNumberRaw: weld.pipelineNumberRaw || weld.pipelineNumber || '',
          pipelineNumberSource: weld.pipelineNumberSource || (
            pageOcrData?.pipelineSource ? 'inferred' : 'business_data'
          ),
          pipeClass: weld.pipeClass || weld.pipelineClass || pageOcrData?.pipeClass || pageOcrData?.pipelineClass || '',
          pipelineClass: weld.pipeClass || weld.pipelineClass || pageOcrData?.pipeClass || pageOcrData?.pipelineClass || '',
          batchRunId: this.activeBatchRunId,
          replacementSourceAnnotationIds: Array.isArray(weld.replacementSourceAnnotationIds)
            ? weld.replacementSourceAnnotationIds.filter(Boolean)
            : [],
          isWeldedSupport: weld.isWeldedSupport === true,
          supportCode: weld.supportCode || '',
          isUploaded: false,
          
          // 额外信息
          weldData: {
            stableKey: stableWeldKey,
            sourceAnnotationId: weld.sourceAnnotationId || null,
            pathId: weld.pathId,
            manualInsertId: weld.manualInsertId || null,
            isManualInserted: !!weld.isManualInserted,
            isWeldedSupport: weld.isWeldedSupport === true,
            supportCode: weld.supportCode || '',
            ruleName: weld.ruleName,
            center: weld.center,
            boundingBox: weld.boundingBox,
            globalIndex: weld.globalIndex,
            weldNumber: weld.weldNumber,
            pageNum: weld.pageNum,
            pageIndex: weld.pageIndex,
            pipelineNumber: weld.pipelineNumber || '',
            pipelineNumberRaw: weld.pipelineNumberRaw || weld.pipelineNumber || '',
            pipelineNumberSource: weld.pipelineNumberSource || (
              pageOcrData?.pipelineSource ? 'inferred' : 'business_data'
            ),
            pipeClass: weld.pipeClass || weld.pipelineClass || pageOcrData?.pipeClass || pageOcrData?.pipelineClass || '',
            pipelineClass: weld.pipeClass || weld.pipelineClass || pageOcrData?.pipeClass || pageOcrData?.pipelineClass || ''
          }
        };
        
        annotations.push(annotation);
      });
    });
    
    console.log(`✅ 转换完成: ${annotations.length} 个焊点标注`);
    
    // 打印第一个标注的坐标用于调试
    if (annotations.length > 0) {
      console.log('📍 第一个标注坐标示例:', {
        text: annotations[0].text,
        page: annotations[0].page,
        startX: annotations[0].startX,
        startY: annotations[0].startY,
        endX: annotations[0].endX,
        endY: annotations[0].endY,
        weldCenter: this.allWelds[0].center
      });
    }
    
    return annotations;
  }

  /**
   * 获取指定页面的焊点列表
   */
  getPageWelds(pageNum) {
    return this.pageWelds[pageNum] || [];
  }

  getPageFittings(pageNum = null) {
    if (pageNum !== null && pageNum !== undefined) {
      return this.pageFittings[pageNum] || [];
    }
    return this.pageFittings || {};
  }

  getWeldReviewCandidates(pageNum = null) {
    if (pageNum !== null && pageNum !== undefined) {
      return this.pageWeldReviewCandidates[pageNum] || [];
    }
    return this.pageWeldReviewCandidates;
  }

  getWeldRecognitionDiagnostics(pageNum = null) {
    if (pageNum !== null && pageNum !== undefined) {
      return this.pageWeldRecognitionDiagnostics[pageNum] || null;
    }
    return this.pageWeldRecognitionDiagnostics;
  }

  /**
   * Replace one page's live weld result without touching any other page.
   */
  setPageWelds(pageNum, welds) {
    const normalizedPage = Number(pageNum);
    if (!Number.isFinite(normalizedPage)) return [];
    const normalizedWelds = Array.isArray(welds) ? welds : [];
    this.pageWelds[normalizedPage] = normalizedWelds;
    return normalizedWelds;
  }

  /**
   * 获取所有焊点
   */
  getAllWelds() {
    return this.allWelds;
  }

  setPendingBatchAnnotationRule(rule) {
    this.pendingBatchAnnotationRule = rule || null;
  }

  getPendingBatchAnnotationRule() {
    return this.pendingBatchAnnotationRule;
  }

  setCorrectedNumberedWelds(welds) {
    const next = Array.isArray(welds) ? welds : [];
    const restoredBatchRunId = next.find(weld => weld?.batchRunId)?.batchRunId;
    if (restoredBatchRunId) {
      this.activeBatchRunId = restoredBatchRunId;
    }
    this.allWelds = next;
    this.allWeldsNumbered = next;
    return next;
  }

  /**
   * 获取管线号核对统计
   */
  getPipelineStats() {
    return this.pipelineStats || [];
  }

  getPipelineReferenceData() {
    return this.pipelineReferenceData || null;
  }

  getPipelineComparison() {
    return this.pipelineComparison || null;
  }

  /**
   * 导出管线号核对统计 CSV
   */
  exportPipelineStatsCSV(pdfFileName = 'document') {
    if (this.pipelineComparison?.items?.length) {
      return exportPipelineComparisonCSVFile(this.pipelineComparison, pdfFileName);
    }

    return exportPipelineStatsCSVFile(this.pipelineStats || [], pdfFileName);
  }

  /**
   * 获取当前处理状态
   */
  getStatus() {
    return {
      isProcessing: this.isProcessing,
      currentStep: this.currentStep,
      progress: this.progress
    };
  }
}

// 导出单例实例
export const multiPageBatchService = new MultiPageBatchService();
export default multiPageBatchService;
