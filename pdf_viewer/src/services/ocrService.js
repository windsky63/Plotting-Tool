/**
 * OCR服务模块 - 处理所有OCR相关的API调用和数据处理
 */

import { message } from 'antd';
import { isElectron } from '../utils/platformDetect';
import { configAdapter } from '../adapters/configAdapter';
import {
  enrichTextDetectionResult,
  sanitizeRecognizedPipelineNumber
} from '../utils/pipelineDetectionUtils';
import { DEFAULT_OCR_SERVER_HOST, DEFAULT_OCR_SERVER_PORT, normalizeOcrServerHost } from '../config/ocrServer';
import { parseMineruExcelLogicalRows } from '../utils/mineruExcelUtils';

const LOCAL_MINERU_BASE_URL = 'http://192.168.32.61:8081';

const OCR_HEALTH_CACHE_MS = 15000;
const OCR_HEALTH_FAILURE_LIMIT = 3;
const OCR_HEALTH_PAUSE_MS = 60000;
const OCR_HEALTH_TIMEOUT_MS = 10000;
const OCR_HEALTH_LAST_GOOD_GRACE_MS = 90000;
const OCR_REQUEST_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;

const releaseResponseReader = async (reader) => {
  if (!reader) return;
  try {
    await reader.cancel();
  } catch (error) {
    // The stream may already be closed or aborted.
  }
  try {
    reader.releaseLock();
  } catch (error) {
    // The lock may already have been released.
  }
};

class OCRService {
  constructor() {
    // 自动检测基础 URL
    if (typeof window !== 'undefined' && !isElectron()) {
      // Web 模式：使用当前页面的 hostname
      this.baseUrl = `http://${DEFAULT_OCR_SERVER_HOST}`;
      console.log('🌐 Web模式: 自动检测到OCR服务地址:', this.baseUrl);
    } else {
      this.baseUrl = `http://${DEFAULT_OCR_SERVER_HOST}`;
      // Electron 模式：默认本地
      this.baseUrl = `http://${DEFAULT_OCR_SERVER_HOST}`;
    }
    this.port = DEFAULT_OCR_SERVER_PORT; // 默认端口，会被配置覆盖
    this.ocrServerBaseUrl = null;
    if (this.isSameOriginProxyRuntime()) {
      const sameOrigin = this.getSameOriginHostPort();
      this.baseUrl = sameOrigin.baseUrl;
      this.port = sameOrigin.port;
    }
    this.mineruStopRequested = false;
    this.mineruStopRequested = false;
    this.healthCheckPromise = null;
    this.healthCheckCache = null;
    this.healthCheckCacheAt = 0;
    this.lastHealthyResult = null;
    this.lastHealthyAt = 0;
    this.healthFailureCount = 0;
    this.healthCircuitOpenUntil = 0;
    this.activeOcrWebSockets = new Set();
    this.inFlightBatchOcr = new Map();
    if (typeof window !== 'undefined') {
      const closeActiveSockets = () => {
        this.activeOcrWebSockets.forEach(socket => this.closeWebSocket(socket));
      };
      window.addEventListener('pagehide', closeActiveSockets);
      window.addEventListener('beforeunload', closeActiveSockets);
    }
  }

  isSameOriginProxyRuntime() {
    if (typeof window === 'undefined' || isElectron()) return false;
    const host = window.location?.hostname;
    if (!host) return false;
    return !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host);
  }

  getSameOriginBaseUrl() {
    if (typeof window === 'undefined') return '';
    return window.location.origin.replace(/\/+$/, '');
  }

  getSameOriginHostPort() {
    if (typeof window === 'undefined') return null;
    const url = new URL(window.location.origin);
    return {
      baseUrl: `${url.protocol}//${url.hostname}`,
      port: url.port || (url.protocol === 'https:' ? '443' : '80')
    };
  }

  getOcrBaseUrl() {
    return (this.ocrServerBaseUrl || `${this.baseUrl}:${this.port}`).replace(/\/+$/, '');
  }

  getOcrUrl(path = '') {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${this.getOcrBaseUrl()}${suffix}`;
  }

  getOcrWebSocketUrl(path = '') {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${this.getOcrBaseUrl().replace(/^http/i, 'ws')}${suffix}`;
  }

  async getMineruBaseUrl() {
    const isWebRuntime = typeof window !== 'undefined' && !isElectron();
    if (this.isSameOriginProxyRuntime()) {
      return `${this.getSameOriginBaseUrl()}/mineru`;
    }
    const resolveLoopbackHost = (configuredUrl) => {
      if (!isWebRuntime) return configuredUrl;
      const host = window.location?.hostname;
      if (!host) return configuredUrl;

      try {
        const parsed = new URL(configuredUrl);
        const loopbackHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);
        if (loopbackHosts.has(parsed.hostname)) {
          const port = parsed.port || '8081';
          return `${parsed.protocol}//${host}:${port}`;
        }
      } catch (error) {
        // If the configured URL is malformed, fall through to the original value.
      }

      return configuredUrl;
    };

    try {
      const config = await configAdapter.getConfig();
      const configured = config?.mineru_base_url || config?.mineruBaseUrl;
      if (configured) {
        return resolveLoopbackHost(String(configured).replace(/\/+$/, ''));
      }
    } catch (error) {
      console.warn('[MinerU] 读取配置失败，回退到默认地址:', error);
    }

    return isWebRuntime ? LOCAL_MINERU_BASE_URL : `http://${DEFAULT_OCR_SERVER_HOST}:8081`;
  }

  async stopMinerURecognition() {
    this.mineruStopRequested = true;
    const MINERU_BASE = await this.getMineruBaseUrl();
    try {
      await fetch(`${MINERU_BASE}/admin/stop`, { method: 'POST' });
    } catch (e) {
      console.warn('[MinerU] stop request interrupted:', e.message);
    }
    return { success: true, message: 'MinerU 识别已停止' };
  }

  formatTextDetectionResult(result, currentPage = 1) {
    return enrichTextDetectionResult({
      ...(result || {}),
      detections: result?.detections || [],
      page_info: result?.page_info || {
        page_width: 0,
        page_height: 0,
        page_index: currentPage
      }
    }, currentPage);
  }

  composeTextDetectionResult(rawTextResult, currentPage = 1, mineruPipelineResult = null, mineruAttempted = false) {
    const fallbackResult = this.formatTextDetectionResult({
      ...(rawTextResult || {}),
      pipelineSource: 'paddleocr-full-page-ocr',
      pipelineEngine: 'paddleocr',
      pipelineFallbackUsed: false
    }, currentPage);

    const mineruPipelineNumber = sanitizeRecognizedPipelineNumber(mineruPipelineResult?.pipelineNumber);
    const hasMineruMatch = mineruPipelineResult?.pipelineStatus === 'matched' && mineruPipelineNumber;
    if (hasMineruMatch) {
      return this.formatTextDetectionResult({
        ...(rawTextResult || {}),
        pipelineNumber: mineruPipelineNumber,
        pipelineStatus: mineruPipelineResult.pipelineStatus || 'matched',
        pipelineConfidence: mineruPipelineResult.pipelineConfidence || 0,
        pipelineCandidates: mineruPipelineResult.pipelineCandidates || [],
        pipelineSource: mineruPipelineResult.pipelineSource || 'mineru-full-page',
        pipelineEngine: 'mineru',
        pipelineFallbackUsed: false
      }, currentPage);
    }

    return this.formatTextDetectionResult({
      ...fallbackResult,
      pipelineSource: 'paddleocr-full-page-ocr',
      pipelineEngine: 'paddleocr',
      pipelineFallbackUsed: mineruAttempted
    }, currentPage);
  }

  hasValidOcrArea(area) {
    return !!area &&
      typeof area.x === 'number' &&
      typeof area.y === 'number' &&
      typeof area.width === 'number' &&
      typeof area.height === 'number' &&
      area.width > 0 &&
      area.height > 0;
  }

  normalizePipelineArea(area, currentPage = 1) {
    if (!this.hasValidOcrArea(area)) return null;
    return {
      ...area,
      page: area.page || currentPage
    };
  }

  createPipelineAreaResult(text, currentPage = 1, source = 'paddleocr-pipeline-area') {
    const normalizedText = String(text || '').trim();
    return {
      success: true,
      pipelineNumber: normalizedText,
      pipelineStatus: normalizedText ? 'matched' : 'unresolved',
      pipelineConfidence: normalizedText ? 1 : 0,
      pipelineSource: source,
      pipelineCandidates: normalizedText ? [{
        text: normalizedText,
        normalizedText,
        score: 1,
        confidence: 1,
        source
      }] : [],
      pageIndex: currentPage
    };
  }

  async extractPipelineWithOcrArea(
    pdfPathOrFile,
    currentPage = 1,
    pipelineArea = null
  ) {
    const normalizedArea = this.normalizePipelineArea(pipelineArea, currentPage);
    if (!normalizedArea) {
      throw new Error('pipelineArea is empty');
    }

    const templateForServer = {
      materialArea: null,
      pipelineArea: normalizedArea,
      drawingNumberArea: null,
      pageNumberArea: null,
      scaffoldArea: null,
      columns: [],
      start_page: currentPage,
      end_page: currentPage,
      page_range: [currentPage],
      _pipelineAreaOnly: true
    };

    const isFileObject = pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob;
    const isValidPath = typeof pdfPathOrFile === 'string' &&
      pdfPathOrFile.length > 0 &&
      !pdfPathOrFile.startsWith('blob:');

    if (!isFileObject && isValidPath) {
      const result = await this.recognizeSinglePageInternal(pdfPathOrFile, templateForServer, currentPage);
      const recognizedText = sanitizeRecognizedPipelineNumber(result?.pipelineNumber);
      return this.createPipelineAreaResult(recognizedText, currentPage);
    }

    const pdfFile = isFileObject ? pdfPathOrFile : window.__lastOpenedPdfFile__;
    if (!pdfFile || !(pdfFile instanceof File || pdfFile instanceof Blob)) {
      throw new Error('No PDF file is available for pipeline area OCR');
    }

    let uploadFile = pdfFile;
    let uploadFileName = pdfFile.name || 'document.pdf';
    const uploadTemplate = { ...templateForServer };

    try {
      const slicedResult = await this._extractPdfPages(pdfFile, {
        type: 'custom',
        pages: [currentPage]
      });

      if (slicedResult?.blob) {
        uploadFile = slicedResult.blob;
        uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + `_page_${currentPage}.pdf`;
        uploadTemplate.start_page = 1;
        uploadTemplate.end_page = 1;
        uploadTemplate.page_range = [1];
        uploadTemplate.pipelineArea = {
          ...normalizedArea,
          page: 1
        };
      }
    } catch (sliceError) {
      console.warn('[OCR] failed to slice current page for pipeline area OCR:', sliceError);
    }

    const apiUrl = this.getOcrUrl('/api/recognize/batch-upload');
    const formData = new FormData();
    formData.append('pdf_file', uploadFile, uploadFileName);
    formData.append('template', JSON.stringify(uploadTemplate));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);
    let reader = null;

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pipeline area OCR failed: ${response.status} ${errorText}`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let pipelineText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data: ')) continue;

          const data = JSON.parse(line.substring(6));
          if (data.type === 'error') {
            throw new Error(data.message || 'Pipeline area OCR failed');
          }

          if (data.type === 'result') {
            const pageData = Array.isArray(data.logical_rows)
              ? data.logical_rows[0]
              : data.data;
            pipelineText = pageData?.pipeline?.text ||
              pageData?.pipelineNumber ||
              pageData?.data?.pipelineNumber ||
              '';
            break;
          }
        }

        if (pipelineText) break;
      }

      const recognizedText = sanitizeRecognizedPipelineNumber(pipelineText);
      return this.createPipelineAreaResult(recognizedText, currentPage);
    } finally {
      clearTimeout(timeoutId);
      await releaseResponseReader(reader);
      controller.abort();
    }
  }

  async extractPipelineWithMinerU(pdfPathOrFile, currentPage = 1) {
    const mineruBaseUrl = await this.getMineruBaseUrl();
    const isFileObject = pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob;
    const isValidPath = typeof pdfPathOrFile === 'string' &&
      pdfPathOrFile.length > 0 &&
      !pdfPathOrFile.startsWith('blob:');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
      if (isFileObject || !isValidPath) {
        const pdfFile = isFileObject ? pdfPathOrFile : window.__lastOpenedPdfFile__;
        if (!pdfFile || !(pdfFile instanceof File || pdfFile instanceof Blob)) {
          throw new Error('无法获取用于 MinerU 管线号提取的 PDF 文件对象');
        }

        let uploadFile = pdfFile;
        let uploadFileName = pdfFile.name || 'document.pdf';
        let pageIndex = currentPage;
        const slicedResult = await this._extractPdfPages(pdfFile, {
          type: 'custom',
          pages: [currentPage]
        });

        if (slicedResult?.blob) {
          uploadFile = slicedResult.blob;
          uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + `_page_${currentPage}.pdf`;
          pageIndex = 1;
        }

        const formData = new FormData();
        formData.append('pdf_file', uploadFile, uploadFileName);
        formData.append('page_index', String(pageIndex));
        formData.append('lang', 'ch');

        const response = await fetch(`${mineruBaseUrl}/pdf/extract-pipeline`, {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`MinerU 管线号提取失败: ${response.status} ${errorText}`);
        }

        const result = await response.json();
        if (!result?.success) {
          throw new Error(result?.error || 'MinerU 管线号提取失败');
        }
        return result;
      }

      const response = await fetch(`${mineruBaseUrl}/pdf/extract-pipeline-by-path`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pdf_path: pdfPathOrFile,
          page_index: currentPage,
          lang: 'ch'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MinerU 管线号提取失败: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      if (!result?.success) {
        throw new Error(result?.error || 'MinerU 管线号提取失败');
      }
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 初始化OCR服务，获取端口配置
   */
  async initialize() {
    console.log('🔧 开始初始化OCR服务...');
    console.log('🔧 运行环境:', isElectron() ? 'Electron' : 'Web');
    
    try {
      // 使用配置适配器获取配置（自动适配 Electron 和 Web 环境）
      const config = await configAdapter.getConfig();
      console.log('📋 成功加载配置:', config);
      
      this.port = config.ocr_server_port;
      
      // 如果配置了远程服务器地址，使用配置的地址
      if (config.ocr_server_host) {
        const normalizedHost = normalizeOcrServerHost(config.ocr_server_host);
        if (this.isSameOriginProxyRuntime()) {
          const sameOrigin = this.getSameOriginHostPort();
          this.baseUrl = sameOrigin.baseUrl;
          this.port = sameOrigin.port;
          console.log(`🌐 Web公网模式: OCR通过当前3005代理访问: ${this.getOcrBaseUrl()}`);
        } else {
          this.baseUrl = `http://${normalizedHost}`;
          console.log(`🌐 使用配置的远程OCR服务器: ${this.baseUrl}`);
        }
      } else if (typeof window !== 'undefined' && !isElectron()) {
        // Web 模式且未配置 host：自动使用当前页面的 hostname
        // 这样局域网访问时，会自动请求到正确的 IP 地址，而不是 127.0.0.1
        this.baseUrl = `http://${DEFAULT_OCR_SERVER_HOST}`;
        // 💡 预设默认端口，防止配置加载失败导致端口为空
        if (!this.port) this.port = DEFAULT_OCR_SERVER_PORT;
        console.log('🌐 Web模式: 自动检测到OCR服务地址:', this.baseUrl, '当前端口:', this.port);
      }
      
      if (!this.port) {
        console.error('❌ 配置中缺少OCR服务端口信息');
        throw new Error('配置中缺少OCR服务端口信息，请检查配置中的ocr_server_port字段');
      }
      
      console.log(`✅ OCR服务地址: ${this.getOcrBaseUrl()}`);
      
      // 设置全局变量供矢量提取使用
      window.__ocrServerUrl__ = this.getOcrBaseUrl();
      
      // 立即检查OCR服务是否可用
      await this.checkOCRServiceHealth();
      
      return this.port;
      
    } catch (error) {
      console.error('❌ OCR服务初始化失败:', error);
      
      // 使用默认端口作为后备方案
      const defaultPort = DEFAULT_OCR_SERVER_PORT;
      console.warn(`⚠️ 使用默认端口作为后备方案: ${defaultPort}`);
      if (this.isSameOriginProxyRuntime()) {
        const sameOrigin = this.getSameOriginHostPort();
        this.baseUrl = sameOrigin.baseUrl;
        this.port = sameOrigin.port;
      } else {
        this.port = defaultPort;
      }
      
      // 尝试检查默认端口的服务
      try {
        await this.checkOCRServiceHealth();
        console.log('✅ 默认端口的OCR服务可用');
        
        // 设置全局变量供矢量提取使用
        window.__ocrServerUrl__ = this.getOcrBaseUrl();
        
        return this.port;
      } catch (healthError) {
        console.error('❌ 默认端口的OCR服务也不可用');
        throw new Error(`OCR服务不可用: ${error.message}`);
      }
    }
  }

  /**
   * 检查OCR服务健康状态
   */
  async checkOCRServiceHealth() {
    if (!this.port) {
      throw new Error('端口未配置，无法检查 OCR 服务状态');
    }
    const result = await this.healthCheck({ force: true });
    if (!result.available || !result.ready) {
      throw new Error(result.error || `OCR 服务未就绪${result.status ? ` (HTTP ${result.status})` : ''}`);
    }
    console.log('✅ OCR服务健康检查通过:', result);
    return result;
  }

  async healthCheck({ force = false } = {}) {
    if (!this.port) {
      await this.initialize();
    }

    const healthUrl = this.getOcrUrl('/health');
    const now = Date.now();
    if (!force && this.healthCheckCache?.available && this.healthCheckCache?.ready && now - this.healthCheckCacheAt < OCR_HEALTH_CACHE_MS) {
      return this.healthCheckCache;
    }
    if (!force && this.healthCircuitOpenUntil > now) {
      return {
        available: false,
        ready: false,
        error: 'OCR 健康检查连续失败，已暂停请求',
        retryAfterMs: this.healthCircuitOpenUntil - now,
        url: healthUrl
      };
    }
    if (this.healthCheckPromise) return this.healthCheckPromise;

    this.healthCheckPromise = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OCR_HEALTH_TIMEOUT_MS);
      try {
        const response = await fetch(healthUrl, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' }
        });
        let result;
        if (!response.ok) {
          await response.text();
          result = { available: false, ready: false, status: response.status, url: healthUrl };
        } else {
          const data = await response.json();
          result = { ...data, available: true, ready: Boolean(data.ready), url: healthUrl };
        }
        if (result.available && result.ready) {
          this.healthFailureCount = 0;
          this.healthCircuitOpenUntil = 0;
          this.lastHealthyResult = result;
          this.lastHealthyAt = Date.now();
          this.healthCheckCache = result;
          this.healthCheckCacheAt = Date.now();
        } else {
          this.healthFailureCount += 1;
          if (this.healthFailureCount < OCR_HEALTH_FAILURE_LIMIT) {
            const hasRecentSuccess = this.lastHealthyResult && Date.now() - this.lastHealthyAt <= OCR_HEALTH_LAST_GOOD_GRACE_MS;
            result = hasRecentSuccess
              ? { ...this.lastHealthyResult, stale: true, warning: `OCR 状态检查暂时失败（${this.healthFailureCount}/${OCR_HEALTH_FAILURE_LIMIT}）` }
              : { ...result, available: true, transient: true, failureCount: this.healthFailureCount };
          }
        }
        if (this.healthFailureCount >= OCR_HEALTH_FAILURE_LIMIT) {
          this.healthCircuitOpenUntil = Date.now() + OCR_HEALTH_PAUSE_MS;
        }
        return result;
      } catch (error) {
        this.healthFailureCount += 1;
        if (this.healthFailureCount >= OCR_HEALTH_FAILURE_LIMIT) {
          this.healthCircuitOpenUntil = Date.now() + OCR_HEALTH_PAUSE_MS;
        }
        let result = {
          available: false,
          ready: false,
          error: error.name === 'AbortError' ? 'timeout' : error.message,
          url: healthUrl
        };
        if (this.healthFailureCount < OCR_HEALTH_FAILURE_LIMIT) {
          const hasRecentSuccess = this.lastHealthyResult && Date.now() - this.lastHealthyAt <= OCR_HEALTH_LAST_GOOD_GRACE_MS;
          result = hasRecentSuccess
            ? { ...this.lastHealthyResult, stale: true, warning: `OCR 状态检查暂时失败（${this.healthFailureCount}/${OCR_HEALTH_FAILURE_LIMIT}）` }
            : { ...result, available: true, transient: true, failureCount: this.healthFailureCount };
        }
        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    try {
      return await this.healthCheckPromise;
    } finally {
      this.healthCheckPromise = null;
    }
  }

  /**
   * 混合模板识别（分两次调用后端）
   * @param {string} pdfPath - PDF文件路径
   * @param {Object} templateData - 混合模板数据
   * @param {number} currentPage - 当前页码
   */
  async recognizeMixedTemplate(pdfPath, templateData, currentPage) {
    console.log('🔀 开始混合模板识别（分两次调用后端）...');
    
    try {
      // 第一次调用：识别材料区域（提取带"阀"字的材料序号）
      console.log('📋 第一次调用：识别材料区域...');
      const materialTemplate = {
        materialArea: templateData.materialArea,
        dividers: templateData.dividers,
        drawingNumberArea: templateData.drawingNumberArea,
        pageNumberArea: templateData.pageNumberArea,
        pipelineArea: templateData.pipelineArea
      };
      
      const materialResult = await this.recognizeSinglePageInternal(pdfPath, materialTemplate, currentPage);
      console.log('✅ 材料区域识别完成:', {
        materials: materialResult.materials?.length || 0,
        valveMaterialIndexes: materialResult.valveMaterialIndexes?.length || 0
      });
      
      // 第二次调用：识别支架区域（获取所有文本，前端提取纯数字）
      console.log('🏗️ 第二次调用：识别支架区域...');
      const scaffoldTemplate = {
        materialArea: {
          ...templateData.scaffoldArea,
          _isScaffoldTemplate: true  // 标记为支架模板，映射到materialArea
        }
      };
      
      const scaffoldResult = await this.recognizeSinglePageInternal(pdfPath, scaffoldTemplate, currentPage);
      console.log('✅ 支架区域识别完成:', {
        detections: scaffoldResult.detections?.length || 0
      });
      
      // 合并结果
      const mergedResult = {
        // 基本信息（从材料识别结果获取）
        drawingNumber: materialResult.drawingNumber || '',
        pipelineNumber: materialResult.pipelineNumber || '',
        pageNumber: materialResult.pageNumber || currentPage,
        
        // 材料表数据
        materials: materialResult.materials || [],
        
        // 🆕 阀门材料序号（从材料区域提取）
        valveMaterialIndexes: materialResult.valveMaterialIndexes || [],
        
        // 支架数据：使用支架区域的所有detections
        scaffolds: [],
        
        // 🆕 支架纯数字（稍后从scaffolds提取）
        scaffoldPureNumbers: [],
        
        // 保留所有detections用于调试
        detections: scaffoldResult.detections || [],
        isScaffoldMode: true,
        isMaterialMode: false,
        isMixedTemplate: true,
        
        pageInfo: materialResult.pageInfo || {}
      };
      
      // 处理支架区域的detections，提取所有文本作为支架数据
      if (scaffoldResult.detections && scaffoldResult.detections.length > 0) {
        console.log(`🔢 从支架区域提取到 ${scaffoldResult.detections.length} 个检测项`);
        
        const pageInfo = materialResult.pageNumber || currentPage || '';
        const drawingNumber = materialResult.drawingNumber || '';
        
        mergedResult.scaffolds = scaffoldResult.detections.map((detection, index) => {
          const text = detection.text || '';
          
          // 计算位置信息
          let position = null;
          if (detection.box && Array.isArray(detection.box) && detection.box.length >= 4) {
            const centerX = detection.box[0][0] + (detection.box[1][0] - detection.box[0][0]) / 2;
            const centerY = detection.box[0][1] + (detection.box[2][1] - detection.box[0][1]) / 2;
            position = { x: centerX, y: centerY };
          }
          
          return {
            key: `scaffold-${index + 1}`,
            index: index + 1,
            scaffoldInfo: text,
            text: text,
            pageInfo: pageInfo,
            drawingNumber: drawingNumber,
            position: position,
            score: detection.score || 0,
            box: detection.box || [],
            coordinates: detection.coordinates || {},
            ...detection
          };
        });
        
        // 🆕 提取支架区域的纯数字
        const pureNumbers = [];
        mergedResult.scaffolds.forEach(scaffoldItem => {
          const extracted = this.extractPureNumbers(scaffoldItem.scaffoldInfo);
          if (extracted) {
            pureNumbers.push({
              original: scaffoldItem.scaffoldInfo,
              pureNumber: extracted,
              position: scaffoldItem.position,
              box: scaffoldItem.box
            });
          }
        });
        
        if (pureNumbers.length > 0) {
          console.log(`🔢 从支架区域提取到 ${pureNumbers.length} 个纯数字:`);
          pureNumbers.forEach(item => {
            console.log(`  - 原文: "${item.original}" → 纯数字: "${item.pureNumber}"`);
          });
          mergedResult.scaffoldPureNumbers = pureNumbers;
          
          // 🔧 阀门匹配：将纯数字与阀门序号进行匹配
          if (mergedResult.valveMaterialIndexes && mergedResult.valveMaterialIndexes.length > 0) {
            console.log('\n🔍 开始阀门匹配...');
            console.log(`📋 阀门序号列表: [${mergedResult.valveMaterialIndexes.map(v => v.index).join(', ')}]`);
            
            const valveMatches = [];
            pureNumbers.forEach(item => {
              // 检查纯数字是否在阀门序号列表中
              const matchedValve = mergedResult.valveMaterialIndexes.find(
                valve => valve.index === item.pureNumber
              );
              
              if (matchedValve) {
                valveMatches.push({
                  ...item,
                  isValve: true,
                  valveIndex: matchedValve.index,
                  valveData: matchedValve.rawData
                });
                console.log(`  ✅ 匹配成功: "${item.original}" (纯数字: ${item.pureNumber}) → 阀门序号: ${matchedValve.index}`);
              } else {
                console.log(`  ❌ 未匹配: "${item.original}" (纯数字: ${item.pureNumber}) → 不是阀门序号`);
              }
            });
            
            if (valveMatches.length > 0) {
              console.log(`\n🎯 阀门匹配完成: 共匹配到 ${valveMatches.length} 个阀门编号`);
              mergedResult.valveMatches = valveMatches;
              
              // 输出匹配详情
              console.log('🔧 阀门匹配详情:');
              valveMatches.forEach((match, index) => {
                console.log(`  ${index + 1}. 原文: "${match.original}" → 阀门序号: ${match.valveIndex} (位置: x=${match.position?.x?.toFixed(1)}, y=${match.position?.y?.toFixed(1)})`);
              });
            } else {
              console.log('\n⚠️ 没有匹配到任何阀门编号');
            }
          } else {
            console.log('\n⚠️ 材料表中没有阀门序号，跳过阀门匹配');
          }
        }
      }
      
      console.log('🎉 混合模板识别完成，最终结果:', {
        materials: mergedResult.materials.length,
        valveMaterialIndexes: mergedResult.valveMaterialIndexes.length,
        scaffolds: mergedResult.scaffolds.length,
        scaffoldPureNumbers: mergedResult.scaffoldPureNumbers.length,
        valveMatches: mergedResult.valveMatches?.length || 0,
        totalDetections: mergedResult.detections.length
      });
      
      return mergedResult;
      
    } catch (error) {
      console.error('❌ 混合模板识别失败:', error);
      throw error;
    }
  }

  async recognizeMixedTemplateWeb(pdfFile, templateData, currentPage) {
    console.log('[OCR] Web mixed template recognition: material area + scaffold area');

    const materialTemplate = {
      materialArea: templateData.materialArea,
      dividers: templateData.dividers,
      drawingNumberArea: templateData.drawingNumberArea,
      pageNumberArea: templateData.pageNumberArea,
      pipelineArea: templateData.pipelineArea
    };

    const scaffoldTemplate = {
      materialArea: {
        ...templateData.scaffoldArea,
        _isScaffoldTemplate: true
      }
    };

    const materialResult = await this.recognizeSinglePageWeb(pdfFile, materialTemplate, currentPage);
    const scaffoldResult = await this.recognizeSinglePageWeb(pdfFile, scaffoldTemplate, currentPage);
    const scaffoldDetections = scaffoldResult.detections || [];

    const scaffolds = scaffoldDetections.map((detection, index) => {
      let position = null;
      if (detection.box && Array.isArray(detection.box) && detection.box.length >= 4) {
        const centerX = detection.box[0][0] + (detection.box[1][0] - detection.box[0][0]) / 2;
        const centerY = detection.box[0][1] + (detection.box[2][1] - detection.box[0][1]) / 2;
        position = { x: centerX, y: centerY };
      }

      return {
        key: `scaffold-${index + 1}`,
        index: index + 1,
        scaffoldInfo: detection.text || '',
        text: detection.text || '',
        pageInfo: materialResult.pageNumber || currentPage,
        drawingNumber: materialResult.drawingNumber || '',
        position,
        score: detection.score || 0,
        box: detection.box || [],
        coordinates: detection.coordinates || {},
        ...detection
      };
    });

    return {
      drawingNumber: materialResult.drawingNumber || '',
      pipelineNumber: materialResult.pipelineNumber || '',
      pageNumber: materialResult.pageNumber || currentPage,
      materials: materialResult.materials || [],
      scaffolds,
      scaffoldData: scaffolds,
      scaffoldPureNumbers: [],
      detections: scaffoldDetections,
      pageInfo: materialResult.pageInfo || {},
      isScaffoldMode: true,
      isMaterialMode: false,
      isMixedTemplate: true
    };
  }

  /**
   * 全页文字检测（不需要模板）
   * 用于获取整个页面的文字区域，供焊点识别过滤使用
   * @param {string} pdfPath - PDF文件路径
   * @param {number} currentPage - 当前页码
   * @returns {Promise<Object>} - 返回包含detections的对象
   */
  async detectTextRegions(pdfPath, currentPage = 1) {
    try {
      console.log('📝 开始全页文字检测...');
      
      if (!this.port) {
        console.log('🔄 端口未配置，正在初始化OCR服务...');
        await this.initialize();
      }

      // 先检查OCR服务健康状态
      console.log('🏥 检查OCR服务健康状态...');
      try {
        await this.checkOCRServiceHealth();
        console.log('✅ OCR服务健康检查通过');
      } catch (healthError) {
        console.error('❌ OCR服务健康检查失败:', healthError);
        throw new Error(`OCR服务不可用: ${healthError.message}`);
      }

      // 创建一个覆盖整页的虚拟模板（用于全页识别）
      // 注意：使用与材料表识别相同的结构，确保后端能正确处理
      const fullPageTemplate = {
        materialArea: {
          x: 0,
          y: 0,
          width: 1,  // 相对坐标，覆盖整页
          height: 1,
          page: currentPage
        },
        // 添加空的分割线数组，避免后端处理异常
        dividers: [],
        // 添加其他可选字段为null，确保结构完整
        drawingNumberArea: null,
        pageNumberArea: null,
        pipelineArea: null
      };
      
      const requestUrl = this.getOcrUrl('/api/recognize/single-page-with-coordinates');
      console.log('🌐 发送全页文字检测请求到:', requestUrl);
      
      const requestBody = {
        pdf_path: pdfPath,
        template: fullPageTemplate,
        page_index: currentPage,
        include_coordinates: true,
        coordinate_format: "relative"
      };
      
      console.log('📤 全页检测请求:', {
        path: pdfPath,
        page: currentPage,
        template: fullPageTemplate
      });
      
      console.log('📤 完整请求体:', JSON.stringify(requestBody, null, 2));
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时 (原30秒)
      
      console.log('⏱️ 开始发送请求，等待响应...');
      const requestStartTime = performance.now();
      
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      const requestDuration = performance.now() - requestStartTime;
      console.log(`⏱️ 请求耗时: ${(requestDuration / 1000).toFixed(2)}秒`);
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ 全页文字检测失败:', response.status, errorText);
        throw new Error(`OCR服务响应错误: ${response.status} ${errorText}`);
      }
      
      const result = await response.json();
      
      console.log('✅ 全页文字检测完成:', {
        detections: result.detections?.length || 0,
        pageInfo: result.page_info
      });
      
      // 返回格式化的结果
      return this.formatTextDetectionResult({
        detections: result.detections || [],
        page_info: result.page_info || {
          page_width: 0,
          page_height: 0,
          page_index: currentPage
        }
      }, currentPage);
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('❌ 全页文字检测超时');
        console.error('💡 可能的原因:');
        console.error('  1. PDF页面内容过多，OCR处理时间过长');
        console.error('  2. OCR服务未响应或卡死');
        console.error('  3. 网络连接问题');
        console.error('💡 建议:');
        console.error('  1. 检查OCR服务是否正常运行');
        console.error('  2. 尝试重启OCR服务');
        console.error('  3. 如果页面内容很多，可能需要更长的等待时间');
        throw new Error('全页文字检测超时(120秒)，请检查OCR服务状态或尝试重启服务');
      }
      
      console.error('❌ 全页文字检测异常:', error);
      throw error;
    }
  }

  /**
   * 纯文本检测（无模板逻辑）
   * 调用后端新增的 /api/recognize/detect-text 接口
   * 专门用于焊点识别的过滤层
   * @param {string|File|Blob} pdfPathOrFile - PDF文件路径或文件对象
   * @param {number} currentPage - 当前页码
   * @returns {Promise<Object>} - 返回包含detections的对象
   */
  async detectTextOnly(pdfPathOrFile, currentPage = 1, templateData = null) {
    try {
      console.log('📝 开始纯文本检测 (detect-text)...');
      
      if (!this.port) {
        console.log('🔄 端口未配置，正在初始化OCR服务...');
        await this.initialize();
      }

      // 🌐 Web端检测：判断是文件路径还是文件对象
      const isFileObject = pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob;
      const isValidPath = typeof pdfPathOrFile === 'string' && 
                         pdfPathOrFile.length > 0 && 
                         !pdfPathOrFile.startsWith('blob:');

      let effectivePdfInput = pdfPathOrFile;
      if (!isFileObject && !isValidPath) {
        if (window.__lastOpenedPdfFile__) {
          console.log('🌐 [Web] 使用全局保存的文件对象进行文字识别');
          effectivePdfInput = window.__lastOpenedPdfFile__;
        } else {
          throw new Error('无法获取PDF文件：请重新打开PDF文件后再试');
        }
      }

      const rawTextPromise = (() => {
        if (effectivePdfInput instanceof File || effectivePdfInput instanceof Blob) {
          console.log('🌐 [Web] 使用文件上传方式进行文字识别');
          return this.detectTextOnlyWeb(effectivePdfInput, currentPage);
        }

        const requestUrl = this.getOcrUrl('/api/recognize/detect-text');
        console.log('🌐 发送纯文本检测请求到:', requestUrl);
        
        const requestBody = {
          pdf_path: effectivePdfInput,
          page_index: currentPage,
          coordinate_format: "relative"
        };
        
        console.log('📤 请求体:', JSON.stringify(requestBody, null, 2));
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时
        const requestStartTime = performance.now();

        return fetch(requestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        }).then(async response => {
          const requestDuration = performance.now() - requestStartTime;
          console.log(`⏱️ 请求耗时: ${(requestDuration / 1000).toFixed(2)}秒`);
          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ 纯文本检测失败:', response.status, errorText);
            throw new Error(`OCR服务响应错误: ${response.status} ${errorText}`);
          }

          const result = await response.json();
          console.log('✅ 纯文本检测完成:', {
            detections: result.detections?.length || 0,
            pageInfo: result.page_info
          });

          return {
            detections: result.detections || [],
            page_info: result.page_info || {
              page_width: 0,
              page_height: 0,
              page_index: currentPage
            }
          };
        }).catch(error => {
          clearTimeout(timeoutId);
          throw error;
        });
      })();
      const [rawTextResultState] = await Promise.allSettled([rawTextPromise]);

      if (rawTextResultState.status !== 'fulfilled') {
        throw rawTextResultState.reason;
      }

      const pipelineArea = this.normalizePipelineArea(templateData?.pipelineArea, currentPage);
      const preRecognizedPipelineNumber = sanitizeRecognizedPipelineNumber(
        templateData?.preRecognizedPipelineNumber
      );
      const mineruAttempted = !pipelineArea && !preRecognizedPipelineNumber;
      const mineruPromise = preRecognizedPipelineNumber
        ? Promise.resolve(this.createPipelineAreaResult(preRecognizedPipelineNumber, currentPage, 'material-recognition'))
        : pipelineArea
          ? this.extractPipelineWithOcrArea(effectivePdfInput, currentPage, pipelineArea)
          : this.extractPipelineWithMinerU(effectivePdfInput, currentPage);
      const [mineruResultState] = await Promise.allSettled([mineruPromise]);
      const pipeClassArea = this.normalizePipelineArea(templateData?.pipeClassArea, currentPage);
      const preRecognizedPipeClass = sanitizeRecognizedPipelineNumber(
        templateData?.preRecognizedPipeClass
      );
      // Reuse the proven small-area OCR path so page slicing, uploaded-page
      // remapping and remote OCR behavior stay identical to the pipeline field.
      const pipeClassPromise = preRecognizedPipeClass
        ? Promise.resolve(this.createPipelineAreaResult(preRecognizedPipeClass, currentPage, 'material-recognition'))
        : pipeClassArea
          ? this.extractPipelineWithOcrArea(effectivePdfInput, currentPage, pipeClassArea)
          : Promise.resolve(null);
      const [pipeClassResultState] = await Promise.allSettled([pipeClassPromise]);

      const rawTextResult = rawTextResultState.value;
      let mineruPipelineResult = null;

      if (mineruResultState.status === 'fulfilled') {
        mineruPipelineResult = mineruResultState.value;
        console.log('🧪 MinerU 管线号提取完成:', {
          page: currentPage,
          pipelineStatus: mineruPipelineResult?.pipelineStatus,
          pipelineNumber: mineruPipelineResult?.pipelineNumber,
          candidateCount: mineruPipelineResult?.pipelineCandidates?.length || 0
        });
      } else {
        console.warn('⚠️ MinerU 管线号提取失败，回退 PaddleOCR 候选:', mineruResultState.reason?.message || mineruResultState.reason);
      }

      const composedResult = this.composeTextDetectionResult(rawTextResult, currentPage, mineruPipelineResult, mineruAttempted);
      const rawPipeClass = pipeClassResultState.status === 'fulfilled'
        ? pipeClassResultState.value?.pipelineNumber
        : '';
      const normalizedRawPipeClass = String(rawPipeClass || '')
        .replace(/^(?:管道等级|PIPE\s*CLASS)\s*[:：]?\s*/i, '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
      const pipeClass = sanitizeRecognizedPipelineNumber(normalizedRawPipeClass);
      if (pipeClassResultState.status === 'rejected') {
        console.warn(`⚠️ 第${currentPage}页管道等级区域识别失败:`, pipeClassResultState.reason?.message || pipeClassResultState.reason);
      }
      return {
        ...composedResult,
        pipeClass,
        pipelineClass: pipeClass,
        pipeClassStatus: pipeClass ? 'matched' : 'unresolved',
        pipeClassSource: preRecognizedPipeClass
          ? 'material-recognition'
          : pipeClassArea ? 'paddleocr-pipe-class-area' : 'not-configured'
      };
      
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('纯文本检测超时(120秒)，请检查OCR服务状态或尝试重启服务');
      }
      console.error('❌ 纯文本检测异常:', error);
      throw error;
    }
  }

  /**
   * Web端纯文本检测 - 使用文件上传方式
   * @param {File|Blob} pdfFile - PDF文件对象
   * @param {number} currentPage - 当前页码
   * @returns {Promise<Object>} - 返回包含detections的对象
   */
  async detectTextOnlyWeb(pdfFile, currentPage = 1) {
    console.log('🌐 开始Web端纯文本检测（使用文件上传）...');
    
    if (!this.port) {
      await this.initialize();
    }
    
    if (!pdfFile || !(pdfFile instanceof File || pdfFile instanceof Blob)) {
      throw new Error('Web端文字识别需要有效的PDF文件对象');
    }
    
    try {
      // 使用 detect-text-upload 接口（如果后端支持）
      // 否则使用 batch-upload 接口并提取文字检测结果
      const apiUrl = this.getOcrUrl('/api/recognize/detect-text-upload');
      console.log('📤 上传PDF到OCR服务进行文字识别:', apiUrl);
      
      // 创建FormData
      let uploadFile = pdfFile;
      let uploadFileName = pdfFile.name || 'document.pdf';
      let uploadPageIndex = currentPage;

      try {
        const slicedResult = await this._extractPdfPages(pdfFile, {
          type: 'custom',
          pages: [currentPage]
        });

        if (slicedResult && slicedResult.blob) {
          uploadFile = slicedResult.blob;
          uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + '_page_' + currentPage + '.pdf';
          uploadPageIndex = 1;
          console.log('[OCR] current page sliced for text detection:', {
            originalMB: pdfFile.size ? (pdfFile.size / 1024 / 1024).toFixed(2) : 'unknown',
            uploadMB: uploadFile.size ? (uploadFile.size / 1024 / 1024).toFixed(2) : 'unknown',
            page: currentPage
          });
        }
      } catch (sliceError) {
        console.warn('[OCR] failed to slice current page, falling back to original PDF:', sliceError);
      }

      const formData = new FormData();
      formData.append('pdf_file', uploadFile, uploadFileName);
      formData.append('page_index', uploadPageIndex.toString());
      formData.append('coordinate_format', 'relative');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时
      
      const requestStartTime = performance.now();
      
      let response;
      try {
        response = await fetch(apiUrl, {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });
      } catch (fetchError) {
        // 如果 detect-text-upload 接口不存在，尝试使用备用方案
        console.log('⚠️ detect-text-upload 接口不可用，尝试使用 batch-upload 备用方案');
        clearTimeout(timeoutId);
        return await this.detectTextOnlyWebFallback(pdfFile, currentPage);
      }
      
      const requestDuration = performance.now() - requestStartTime;
      console.log(`⏱️ 请求耗时: ${(requestDuration / 1000).toFixed(2)}秒`);
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // 如果是404，尝试使用备用方案
        if (response.status === 404) {
          console.log('⚠️ detect-text-upload 接口不存在，使用 batch-upload 备用方案');
          await response.body?.cancel();
          controller.abort();
          return await this.detectTextOnlyWebFallback(pdfFile, currentPage);
        }
        const errorText = await response.text();
        console.error('❌ Web端文字识别失败:', response.status, errorText);
        throw new Error(`OCR服务响应错误: ${response.status} ${errorText}`);
      }
      
      const result = await response.json();
      
      console.log('✅ Web端文字识别完成:', {
        detections: result.detections?.length || 0,
        pageInfo: result.page_info
      });
      
      return {
        detections: result.detections || [],
        page_info: result.page_info || {
          page_width: 0,
          page_height: 0,
          page_index: currentPage
        }
      };
      
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Web端文字识别超时(120秒)，请检查OCR服务状态');
      }
      console.error('❌ Web端文字识别异常:', error);
      throw error;
    }
  }

  /**
   * Web端文字识别备用方案 - 使用 batch-upload 接口
   * 当 detect-text-upload 接口不可用时使用
   * @param {File|Blob} pdfFile - PDF文件对象
   * @param {number} currentPage - 当前页码
   * @returns {Promise<Object>} - 返回包含detections的对象
   */
  async detectTextOnlyWebFallback(pdfFile, currentPage = 1) {
    let controller = null;
    let timeoutId = null;
    let reader = null;
    console.log('🔄 使用 batch-upload 备用方案进行文字识别...');
    const startTime = performance.now();
    
    try {
      const apiUrl = this.getOcrUrl('/api/recognize/batch-upload');
      
      // 创建一个简单的全页识别模板，添加优化参数
      const templateForServer = {
        materialArea: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          _isTextDetection: true
        },
        // 🚀 限制只识别当前页
        start_page: currentPage,
        end_page: currentPage,
        page_range: [currentPage],
        // 🚀 优化参数：告诉后端这是纯文字检测模式
        text_detection_only: true,
        skip_table_structure: true,
        skip_material_parsing: true,
        coordinate_format: 'relative'
      };
      
      // 创建FormData
      let uploadFile = pdfFile;
      let uploadFileName = pdfFile.name || 'document.pdf';

      try {
        const slicedResult = await this._extractPdfPages(pdfFile, {
          type: 'custom',
          pages: [currentPage]
        });

        if (slicedResult && slicedResult.blob) {
          uploadFile = slicedResult.blob;
          uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + '_page_' + currentPage + '.pdf';
          templateForServer.start_page = 1;
          templateForServer.end_page = 1;
          templateForServer.page_range = [1];
          console.log('[OCR] current page sliced for text detection fallback:', {
            originalMB: pdfFile.size ? (pdfFile.size / 1024 / 1024).toFixed(2) : 'unknown',
            uploadMB: uploadFile.size ? (uploadFile.size / 1024 / 1024).toFixed(2) : 'unknown',
            page: currentPage
          });
        }
      } catch (sliceError) {
        console.warn('[OCR] failed to slice current page for fallback, using original PDF:', sliceError);
      }

      const formData = new FormData();
      formData.append('pdf_file', uploadFile, uploadFileName);
      formData.append('template', JSON.stringify(templateForServer));
      formData.append('mode', 'text_detection');
      
      controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 120000);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });
      
      if (!response.ok) {
        clearTimeout(timeoutId);
        const errorText = await response.text();
        throw new Error(`OCR服务响应错误: ${response.status} ${errorText}`);
      }
      
      // 处理SSE流式响应（与 recognizeSinglePageWeb 相同的处理方式）
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let detections = [];
      let pageInfo = { page_width: 0, page_height: 0, page_index: currentPage };
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行
        
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'result') {
                console.log('📦 收到文字识别结果');
                
                // 从logical_rows中提取当前页的数据
                if (data.logical_rows && Array.isArray(data.logical_rows)) {
                  const pageIndex = currentPage - 1;
                  const pageData = (data.logical_rows.length === 1)
                    ? data.logical_rows[0]
                    : (pageIndex >= 0 && pageIndex < data.logical_rows.length)
                      ? data.logical_rows[pageIndex]
                      : data.logical_rows[0];
                  
                  if (pageData) {
                    // 尝试从不同字段提取文字检测框
                    if (pageData.detections && Array.isArray(pageData.detections)) {
                      detections = pageData.detections;
                      console.log('📝 从 detections 提取到', detections.length, '个文字框');
                    } else if (pageData.material && Array.isArray(pageData.material)) {
                      // 从材料表数据中提取文字框
                      detections = this.extractDetectionsFromMaterialData(pageData.material);
                      console.log('📝 从 material 提取到', detections.length, '个文字框');
                    }
                    
                    // 获取页面信息
                    if (pageData.page_info) {
                      pageInfo = {
                        page_width: pageData.page_info.page_width || 0,
                        page_height: pageData.page_info.page_height || 0,
                        page_index: currentPage
                      };
                    }
                  }
                }
                break;
              } else if (data.type === 'error') {
                throw new Error(data.message || '文字识别失败');
              } else if (data.type === 'progress') {
                console.log('📊 识别进度:', data.message || data.progress);
              }
            } catch (parseError) {
              if (parseError.message && !parseError.message.includes('Unexpected')) {
                throw parseError;
              }
              // 忽略 JSON 解析错误，继续处理下一行
            }
          }
        }
        
        if (detections.length > 0) break;
      }
      
      clearTimeout(timeoutId);
      
      const duration = ((performance.now() - startTime) / 1000).toFixed(2);
      console.log(`✅ 备用方案文字识别完成 (耗时 ${duration}秒):`, {
        detections: detections.length,
        pageInfo: pageInfo
      });
      
      return {
        detections,
        page_info: pageInfo
      };
      
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('文字识别超时(120秒)');
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      await releaseResponseReader(reader);
      controller?.abort();
    }
  }

  /**
   * 从材料表数据中提取文字检测框
   * @param {Array} materialData - 材料表数据
   * @returns {Array} - 文字检测框数组
   */
  extractDetectionsFromMaterialData(materialData) {
    if (!Array.isArray(materialData)) return [];
    
    const detections = [];
    for (const row of materialData) {
      if (row.cells) {
        for (const cell of row.cells) {
          if (cell.text && cell.box) {
            detections.push({
              text: cell.text,
              box: cell.box,
              confidence: cell.confidence || 0.9
            });
          }
        }
      }
    }
    return detections;
  }

  /**
   * 单页OCR识别
   * @param {string|File|Blob} pdfPathOrFile - PDF文件路径或文件对象
   * @param {Object} templateData - 模板数据
   * @param {number} currentPage - 当前页码
   */
  async recognizeSinglePage(pdfPathOrFile, templateData = null, currentPage = 1) {
    // 判断是否为混合模板
    const isMixed = templateData && 
                   templateData.materialArea && 
                   templateData.scaffoldArea &&
                   typeof templateData.materialArea.x === 'number' &&
                   typeof templateData.scaffoldArea.x === 'number';
    
    // 🌐 Web端检测：如果传入的是文件对象或路径无效，使用文件上传方式
    const isFileObject = pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob;
    const isValidPath = typeof pdfPathOrFile === 'string' && 
                       pdfPathOrFile.length > 0 && 
                       !pdfPathOrFile.startsWith('blob:');
    
    // 如果没有有效路径，尝试使用全局保存的文件对象
    let pdfFile = null;
    let pdfPath = null;
    
    if (isFileObject) {
      pdfFile = pdfPathOrFile;
      console.log('🌐 [Web] 使用传入的文件对象进行识别');
    } else if (isValidPath) {
      pdfPath = pdfPathOrFile;
    } else if (window.__lastOpenedPdfFile__) {
      pdfFile = window.__lastOpenedPdfFile__;
      console.log('🌐 [Web] 使用全局保存的文件对象进行识别');
    } else {
      throw new Error('无法获取PDF文件：请重新打开PDF文件后再试');
    }
    
    // 如果有文件对象，使用Web端文件上传方式
    if (pdfFile) {
      if (isMixed) {
        console.log('[OCR] Web mixed template detected, recognizing material area and scaffold area separately');
        return await this.recognizeMixedTemplateWeb(pdfFile, templateData, currentPage);
      }
      console.log('🌐 使用Web端单页识别（文件上传方式）');
      return await this.recognizeSinglePageWeb(pdfFile, templateData, currentPage);
    }
    
    // 如果是混合模板，调用专门的混合模板识别方法
    if (isMixed) {
      console.log('🔀 检测到混合模板，使用分两次调用的识别方法');
      return await this.recognizeMixedTemplate(pdfPath, templateData, currentPage);
    }
    
    // 否则使用原来的单次识别逻辑（文件路径方式）
    return await this.recognizeSinglePageInternal(pdfPath, templateData, currentPage);
  }
  
  /**
   * Web端单页OCR识别 - 使用batch-upload接口实现
   * @param {File|Blob} pdfFile - PDF文件对象
   * @param {Object} templateData - 模板数据
   * @param {number} currentPage - 当前页码
   */
  async recognizeSinglePageWeb(pdfFile, templateData = null, currentPage = 1) {
    let controller = null;
    let timeoutId = null;
    let reader = null;
    console.log('🌐 开始Web端单页OCR识别（使用batch-upload接口）...');
    
    if (!this.port) {
      await this.initialize();
    }
    
    // 检查是否有有效的PDF文件对象
    if (!pdfFile || !(pdfFile instanceof File || pdfFile instanceof Blob)) {
      throw new Error('Web端单页OCR需要有效的PDF文件对象');
    }
    
    try {
      // 使用已有的batch-upload接口
      const apiUrl = this.getOcrUrl('/api/recognize/batch-upload');
      console.log('📤 上传PDF到OCR服务（使用batch-upload，仅识别第' + currentPage + '页）:', apiUrl);
      
      // 准备模板数据
      const templateToUse = templateData || this.getDefaultTemplate();
      const isScaffold = templateToUse && templateToUse.scaffoldArea && 
                        (templateToUse.materialArea === null || templateToUse.materialArea === undefined);
      
      // 准备发送给服务器的模板数据，添加页码范围限制
      const templateForServer = { 
        ...templateToUse,
        // 告诉后端只识别指定页
        start_page: currentPage,
        end_page: currentPage,
        page_range: [currentPage]
      };
      
      if (isScaffold && templateToUse.scaffoldArea) {
        console.log('🏗️ 检测到支架模板，将 scaffoldArea 映射到 materialArea');
        templateForServer.materialArea = {
          ...templateToUse.scaffoldArea,
          _isScaffoldTemplate: true
        };
      }
      
      // 🔍 调试：输出发送给后端的模板数据
      console.log('🔍 [Web OCR] 发送的模板数据:', {
        hasMaterialArea: !!templateForServer.materialArea,
        hasPipelineArea: !!templateForServer.pipelineArea,
        hasDrawingNumberArea: !!templateForServer.drawingNumberArea,
        hasPageNumberArea: !!templateForServer.pageNumberArea,
        hasColumns: templateForServer.columns?.length || 0,
        columns: templateForServer.columns,
        templateKeys: Object.keys(templateForServer)
      });
      console.log('🔍 [Web OCR] 原始templateData.columns:', templateData?.columns);
      console.log('🔍 [Web OCR] templateForServer完整JSON(前500字符):', JSON.stringify(templateForServer).substring(0, 500));
      
      // 创建FormData
      let uploadFile = pdfFile;
      let uploadFileName = pdfFile.name || 'document.pdf';
      const remapAreaToSlicedPage = (area) => {
        if (!area || typeof area !== 'object') return area;
        return {
          ...area,
          page: 1
        };
      };

      try {
        const slicedResult = await this._extractPdfPages(pdfFile, {
          type: 'custom',
          pages: [currentPage]
        });

        if (slicedResult?.blob) {
          uploadFile = slicedResult.blob;
          uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + `_page_${currentPage}.pdf`;
          templateForServer.start_page = 1;
          templateForServer.end_page = 1;
          templateForServer.page_range = [1];
          templateForServer.materialArea = remapAreaToSlicedPage(templateForServer.materialArea);
          templateForServer.pipelineArea = remapAreaToSlicedPage(templateForServer.pipelineArea);
          templateForServer.drawingNumberArea = remapAreaToSlicedPage(templateForServer.drawingNumberArea);
          templateForServer.pageNumberArea = remapAreaToSlicedPage(templateForServer.pageNumberArea);
          templateForServer.scaffoldArea = remapAreaToSlicedPage(templateForServer.scaffoldArea);
          console.log('[OCR] Web single page upload sliced current page:', {
            currentPage,
            originalSize: pdfFile.size,
            slicedSize: uploadFile.size,
            uploadFileName
          });
        }
      } catch (sliceError) {
        console.warn('[OCR] failed to slice current page for Web single page OCR, falling back to original PDF:', sliceError);
      }

      const formData = new FormData();
      formData.append('pdf_file', uploadFile, uploadFileName);
      formData.append('template', JSON.stringify(templateForServer));
      
      // 发送请求
      controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Web端单页OCR服务器返回错误:', response.status, errorText);
        throw new Error(`OCR服务错误 (${response.status}): ${errorText}`);
      }
      
      // 处理SSE流式响应
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = null;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行
        
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'result') {
                // 解析结果 - 提取指定页的数据
                console.log('📦 收到批量识别结果，提取第' + currentPage + '页数据');
                console.log('📦 原始数据:', JSON.stringify(data).substring(0, 500));
                
                // 辅助函数：将嵌套格式 { column1: { text: "xxx" } } 转换为扁平格式 { column1: "xxx" }
                const flattenMaterialRow = (row) => {
                  if (!row || typeof row !== 'object') return row;
                  const flatRow = { key: row.key || `row-${Date.now()}-${Math.random()}` };
                  Object.keys(row).forEach(key => {
                    if (key === 'key') return;
                    const value = row[key];
                    // 如果值是对象且有 text 属性，提取 text
                    if (value && typeof value === 'object' && 'text' in value) {
                      flatRow[key] = value.text || '';
                    } else {
                      flatRow[key] = value;
                    }
                  });
                  return flatRow;
                };
                
                // 从logical_rows中提取当前页的数据
                if (data.logical_rows && Array.isArray(data.logical_rows)) {
                  // 🔧 获取当前页数据的逻辑：
                  // - 单页识别：后端只返回1个元素，直接使用 logical_rows[0]
                  // - 批量识别：数组索引对应 PDF 页码 - 1（索引0 = 第1页）
                  // 注意：pageNumber.text 是 OCR 识别的材料表文本页码，不是 PDF 页码
                  const pageIndex = currentPage - 1;
                  const pageData = (data.logical_rows.length === 1)
                    ? data.logical_rows[0]  // 单页识别：直接取唯一元素
                    : (pageIndex >= 0 && pageIndex < data.logical_rows.length)
                      ? data.logical_rows[pageIndex]
                      : data.logical_rows[0];
                  
                  console.log(`📄 [Web OCR] 获取第 ${currentPage} 页数据, logical_rows 共 ${data.logical_rows.length} 个元素`);
                  
                  if (pageData) {
                    // 展开 material 中的嵌套结构
                    const rawMaterials = pageData.material || [];
                    const flattenedMaterials = rawMaterials.map(flattenMaterialRow);
                    
                    // 🔍 调试：输出 pageData 的所有字段
                    console.log('🔍 [Web OCR] pageData 字段:', Object.keys(pageData));
                    console.log('🔍 [Web OCR] pageData.detections:', pageData.detections?.length || 0, '个');
                    
                    result = {
                      materials: flattenedMaterials,
                      scaffolds: pageData.scaffolds || [],
                      detections: pageData.detections || [],
                      drawingNumber: pageData.drawingNumber?.text || '',
                      pipelineNumber: pageData.pipeline?.text || '',
                      pageNumber: pageData.pageNumber?.text || currentPage
                    };
                    console.log('📦 处理后的材料数据:', flattenedMaterials.slice(0, 2));
                  }
                }
                
                // 如果没有logical_rows，尝试直接使用data
                if (!result && data.data) {
                  const rawMaterials = data.data.materials || [];
                  result = {
                    materials: rawMaterials.map(flattenMaterialRow),
                    scaffolds: data.data.scaffolds || [],
                    detections: data.data.detections || []
                  };
                }
                
                break;
              } else if (data.type === 'error') {
                throw new Error(data.message || '识别失败');
              }
            } catch (parseError) {
              if (parseError.message && !parseError.message.includes('Unexpected')) {
                throw parseError;
              }
              console.warn('解析OCR数据失败:', parseError.message);
            }
          }
        }
        
        if (result) break;
      }
      
      clearTimeout(timeoutId);
      
      if (!result) {
        result = { materials: [], scaffolds: [], detections: [] };
      }
      
      console.log('✅ Web端单页OCR识别完成:', {
        materials: result.materials?.length || 0,
        scaffolds: result.scaffolds?.length || 0,
        detections: result.detections?.length || 0
      });
      
      return result;
      
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('OCR识别超时，请稍后重试');
      }
      console.error('❌ Web端单页OCR失败:', error);
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      await releaseResponseReader(reader);
      controller?.abort();
    }
  }

  /**
   * Recognize the same scaffold-style text area on several pages in one upload.
   * This keeps the text/coordinate result used by support recognition, while
   * avoiding one PDF parse, slice and network round-trip per page.
   */
  async recognizeScaffoldAreaPages(pdfPathOrFile, area, startPage, endPage, requestedPages = null, onProgress = null) {
    const firstPage = Number(startPage);
    const lastPage = Number(endPage);
    const pageNums = Array.isArray(requestedPages) && requestedPages.length > 0
      ? [...new Set(requestedPages.map(Number).filter(page => Number.isInteger(page) && page >= firstPage && page <= lastPage))]
      : Array.from({ length: Math.max(0, lastPage - firstPage + 1) }, (_, index) => firstPage + index);
    if (pageNums.length === 0) return {};

    const isFileObject = pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob;
    if (!isFileObject) {
      const results = {};
      // The remote service owns a single PaddleOCR engine, so path-mode jobs
      // must also be serialized instead of opening parallel OCR requests.
      let nextIndex = 0;
      let completedCount = 0;
      const worker = async () => {
        while (nextIndex < pageNums.length) {
          const index = nextIndex;
          nextIndex += 1;
          const pageNum = pageNums[index];
          const result = await this.recognizeSinglePage(
            pdfPathOrFile,
            { scaffoldArea: { ...area, page: pageNum } },
            pageNum
          );
          results[pageNum] = {
            detections: result?.detections || result?.scaffolds || [],
            page_info: result?.pageInfo || {},
            source: 'scaffold-area-ocr-path'
          };
          completedCount += 1;
          onProgress?.({
            completed: completedCount,
            total: pageNums.length,
            percentage: completedCount / pageNums.length * 100,
            phase: '识别中'
          });
        }
      };
      await worker();
      return results;
    }

    if (!this.port) await this.initialize();

    let uploadFile = pdfPathOrFile;
    let uploadFileName = pdfPathOrFile.name || 'document.pdf';
    let pageMapping = [...pageNums];
    const slicedResult = await this._extractPdfPages(pdfPathOrFile, {
      type: 'custom',
      pages: pageNums
    });
    if (slicedResult?.blob) {
      uploadFile = slicedResult.blob;
      uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + `_support_${firstPage}_${lastPage}.pdf`;
      pageMapping = slicedResult.validPageNums || pageMapping;
    }

    const template = {
      materialArea: {
        ...(area || { x: 0, y: 0, width: 1, height: 1 }),
        page: 1,
        _isScaffoldTemplate: true
      },
      pipelineArea: null,
      drawingNumberArea: null,
      pageNumberArea: null,
      scaffoldArea: null,
      start_page: 1,
      end_page: pageMapping.length,
      page_range: pageMapping.map((_, index) => index + 1)
    };

    const formData = new FormData();
    formData.append('pdf_file', uploadFile, uploadFileName);
    formData.append('template', JSON.stringify(template));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);
    let currentTaskId = null;
    let reader = null;
    try {
      const response = await fetch(this.getOcrUrl('/api/recognize/batch-upload'), {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Support area OCR failed: ${response.status} ${errorText}`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let logicalRows = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.substring(6));
          if (data.type === 'error') throw new Error(data.message || 'Support area OCR failed');
          if (data.type === 'task_id') {
            currentTaskId = data.task_id || null;
            onProgress?.({ taskId: currentTaskId, completed: 0, total: pageMapping.length, percentage: 0, phase: '任务已提交' });
          }
          if (data.type === 'progress') {
            onProgress?.({
              taskId: currentTaskId,
              completed: Number(data.completed || 0),
              total: Number(data.total || pageMapping.length),
              percentage: Number(data.percentage || 0),
              phase: data.phase || '识别中'
            });
          }
          if (data.type === 'result') {
            logicalRows = Array.isArray(data.logical_rows)
              ? data.logical_rows
              : (Array.isArray(data.data?.logical_rows) ? data.data.logical_rows : []);
          }
        }
        if (logicalRows) break;
      }

      const results = {};
      pageMapping.forEach((originalPage, index) => {
        const pageData = logicalRows?.[index] || {};
        const materialCellDetections = (Array.isArray(pageData.material) ? pageData.material : [])
          .flatMap(row => Object.values(row || {}))
          .filter(cell => cell && typeof cell === 'object' && cell.text && cell.box)
          .map(cell => ({
            text: cell.text,
            box: cell.box,
            score: cell.score || cell.confidence || 0
          }));
        const detections = pageData.detections?.length
          ? pageData.detections
          : (pageData.scaffolds?.length ? pageData.scaffolds : materialCellDetections);
        results[originalPage] = {
          detections,
          page_info: pageData.page_info || {},
          source: 'scaffold-area-ocr-batch'
        };
      });
      return results;
    } catch (error) {
      if (currentTaskId) {
        try {
          await fetch(this.getOcrUrl('/api/recognize/stop'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: currentTaskId })
          });
        } catch (stopError) {
          console.warn('Failed to stop remote OCR task:', stopError?.message || stopError);
        }
      }
      if (error?.name === 'AbortError') {
        throw new Error('静电接地 OCR 单批次超时，远端任务已停止');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      await releaseResponseReader(reader);
      controller.abort();
    }
  }

  /**
   * Recognize small per-page regions through the same concurrent 3006 MinerU
   * backend used by the IDF split-point tool.
   */
  async recognizeSpecialBlockAreasWithIdfTool(pdfDocument, area, requestedPages, onProgress = null) {
    if (!pdfDocument?.getPage) throw new Error('特殊块快速识别需要已加载的 PDF 文档');
    const pageNums = [...new Set((requestedPages || [])
      .map(Number)
      .filter(page => Number.isInteger(page) && page > 0))];
    if (pageNums.length === 0) return {};

    const configuredBase = typeof window !== 'undefined' && window.__idfToolServerUrl__
      ? String(window.__idfToolServerUrl__).replace(/\/$/, '')
      : null;
    let idfBase = configuredBase;
    if (!idfBase) {
      const current = new URL(window.location.href);
      current.port = '3006';
      current.pathname = '';
      current.search = '';
      current.hash = '';
      idfBase = current.origin;
    }

    const normalizedArea = {
      x: Math.max(0, Math.min(1, Number(area?.x) || 0)),
      y: Math.max(0, Math.min(1, Number(area?.y) || 0)),
      width: Math.max(0.001, Math.min(1, Number(area?.width) || 1)),
      height: Math.max(0.001, Math.min(1, Number(area?.height) || 1))
    };
    normalizedArea.width = Math.min(normalizedArea.width, 1 - normalizedArea.x);
    normalizedArea.height = Math.min(normalizedArea.height, 1 - normalizedArea.y);

    const { PDFDocument } = await import('pdf-lib');
    const canvasToBlob = canvas => new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('特殊块区域截图生成失败')), 'image/png');
    });
    const blobToBase64 = async blob => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
      }
      return btoa(binary);
    };
    const buildUpload = async pageNum => {
      const page = await pdfDocument.getPage(pageNum);
      const unitViewport = page.getViewport({ scale: 1 });
      const targetWidth = 1000;
      const scale = Math.min(4, Math.max(2, targetWidth / Math.max(1, unitViewport.width * normalizedArea.width)));
      const viewport = page.getViewport({ scale });
      const cropX = Math.round(normalizedArea.x * viewport.width);
      const cropY = Math.round(normalizedArea.y * viewport.height);
      const cropWidth = Math.max(1, Math.round(normalizedArea.width * viewport.width));
      const cropHeight = Math.max(1, Math.round(normalizedArea.height * viewport.height));
      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, cropWidth, cropHeight);
      const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, -cropX, -cropY]
      });
      await renderTask.promise;

      const pngBlob = await canvasToBlob(canvas);
      const pngBytes = await pngBlob.arrayBuffer();
      const regionPdf = await PDFDocument.create();
      const image = await regionPdf.embedPng(pngBytes);
      const regionPage = regionPdf.addPage([cropWidth, cropHeight]);
      regionPage.drawImage(image, { x: 0, y: 0, width: cropWidth, height: cropHeight });
      const regionBytes = await regionPdf.save();
      canvas.width = 0;
      canvas.height = 0;
      return {
        page: pageNum,
        pipelinePdfBase64: await blobToBase64(new Blob([regionBytes], { type: 'application/pdf' })),
        pipelinePageCount: 1,
        pipelineCropMode: 'special-block-area'
      };
    };

    const mapped = {};
    const batchSize = 12;
    let prepared = 0;
    for (let offset = 0; offset < pageNums.length; offset += batchSize) {
      const batchPages = pageNums.slice(offset, offset + batchSize);
      const uploads = [];
      for (const pageNum of batchPages) {
        uploads.push(await buildUpload(pageNum));
        prepared += 1;
        onProgress?.({
          percentage: Math.round(prepared / pageNums.length * 20),
          phase: `准备区域 ${prepared}/${pageNums.length}`
        });
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      const startResponse = await fetch(`${idfBase}/idf-recognition/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePdf: 'luotu-special-blocks',
          pages: batchPages,
          uploads
        })
      });
      if (!startResponse.ok) {
        throw new Error(`分图点 MinerU 后台提交失败: ${startResponse.status} ${await startResponse.text()}`);
      }
      const startData = await startResponse.json();
      if (!startData.ok || !startData.jobId) throw new Error(startData.error || '分图点 MinerU 后台未返回任务号');

      const batchIndex = Math.floor(offset / batchSize);
      const batchCount = Math.ceil(pageNums.length / batchSize);
      const startedAt = Date.now();
      while (true) {
        if (Date.now() - startedAt > 30 * 60 * 1000) throw new Error('特殊块 MinerU 识别超时');
        await new Promise(resolve => setTimeout(resolve, 600));
        const jobResponse = await fetch(`${idfBase}/idf-recognition/job/${encodeURIComponent(startData.jobId)}`, {
          cache: 'no-store'
        });
        if (!jobResponse.ok) throw new Error(`分图点 MinerU 任务查询失败: ${jobResponse.status}`);
        const job = await jobResponse.json();
        const batchProgress = Number(job.progress || 0);
        onProgress?.({
          percentage: Math.min(99, Math.round(20 + ((batchIndex + batchProgress / 100) / batchCount) * 79)),
          phase: `MinerU 并发识别 ${batchIndex + 1}/${batchCount} 批`
        });
        if (job.status === 'error' || job.status === 'cancelled') {
          throw new Error(job.error || '特殊块 MinerU 识别失败');
        }
        if (job.status !== 'done') continue;
        (job.results || []).forEach(item => {
          mapped[Number(item.page)] = {
            content: item.pipelineText || '',
            source: 'idf-tool-special-block-mineru'
          };
        });
        break;
      }
    }
    onProgress?.({ percentage: 100, phase: '特殊块识别完成' });
    return mapped;
  }

  /**
   * Use the existing remote MinerU upload/polling pipeline as a text fallback
   * for pages where area OCR did not find the requested callout.
   */
  async recognizeAreaPagesWithMinerU(pdfPathOrFile, area, requestedPages, onProgress = null) {
    const pageNums = [...new Set((requestedPages || [])
      .map(Number)
      .filter(page => Number.isInteger(page) && page > 0))];
    if (pageNums.length === 0) return {};

    const template = {
      materialArea: { ...(area || { x: 0, y: 0, width: 1, height: 1 }), page: 1 },
      pipelineArea: null,
      drawingNumberArea: null,
      pageNumberArea: null,
      scaffoldArea: null,
      start_page: 1,
      end_page: pageNums.length,
      page_range: pageNums.map((_, index) => index + 1)
    };
    const result = await this.runBatchOCRMinerU({
      pdfFile: pdfPathOrFile,
      pdfFileName: pdfPathOrFile?.name || 'static_grounding.pdf',
      template,
      pages: { type: 'custom', pages: pageNums },
      _mineruBatchDisabled: true,
      _suppressMinerUExcelDownload: true,
      _skipMinerUExcelRepair: true
    }, progress => onProgress?.({
      percentage: Number(progress?.progress || 0),
      phase: progress?.status || `MinerU 批量识别 ${pageNums.length} 页`
    }));

    const rows = Array.isArray(result?.sourceLogicalRows) && result.sourceLogicalRows.length > 0
      ? result.sourceLogicalRows
      : (result?.logical_rows || []);
    const mapped = {};
    pageNums.forEach((pageNum, index) => {
      mapped[pageNum] = {
        content: rows[index] || null,
        source: 'weld-area-grounding-mineru'
      };
    });
    return mapped;
  }

  /**
   * Recognize each special-block crop directly through the normal MinerU API.
   * Keeping one source page per job preserves page mapping and avoids the
   * twelve-page IDF upload boundary that is unrelated to this keyword check.
   */
  async recognizeSpecialBlockAreasDirectWithMinerU(pdfPathOrFile, area, requestedPages, onProgress = null) {
    const pageNums = [...new Set((requestedPages || [])
      .map(Number)
      .filter(page => Number.isInteger(page) && page > 0))];
    if (pageNums.length === 0) return {};

    const sourceFile = typeof pdfPathOrFile === 'string' && pdfPathOrFile.startsWith('blob:')
      ? (window.__lastOpenedPdfFile__ || pdfPathOrFile)
      : pdfPathOrFile;
    const template = {
      materialArea: { ...(area || { x: 0, y: 0, width: 1, height: 1 }), page: 1 },
      pipelineArea: null,
      drawingNumberArea: null,
      pageNumberArea: null,
      scaffoldArea: null,
      start_page: 1,
      end_page: 1,
      page_range: [1]
    };
    const mapped = {};
    let nextIndex = 0;
    let completed = 0;
    const concurrency = Math.min(4, pageNums.length);
    const mineruBaseUrl = await this.getMineruBaseUrl();
    const getRawMarkdown = payload => {
      if (!payload) return '';
      if (typeof payload === 'string') return payload;
      return payload.markdown
        || payload.md
        || payload.text
        || payload.content
        || payload.result_text
        || getRawMarkdown(payload.data)
        || getRawMarkdown(payload.result)
        || (Array.isArray(payload.results) ? payload.results.map(getRawMarkdown).filter(Boolean).join('\n\n') : '')
        || (Array.isArray(payload.files) ? payload.files.map(getRawMarkdown).filter(Boolean).join('\n\n') : '')
        || (Array.isArray(payload.content_list)
          ? payload.content_list.map(item => item?.text || item?.content || '').filter(Boolean).join('\n')
          : '')
        || getRawMarkdown(payload.mineru_task)
        || '';
    };

    const worker = async () => {
      while (nextIndex < pageNums.length) {
        const index = nextIndex;
        nextIndex += 1;
        const pageNum = pageNums[index];
        const result = await this.runBatchOCRMinerU({
          pdfFile: sourceFile,
          pdfFileName: sourceFile?.name || 'static_grounding.pdf',
          template,
          pages: { type: 'custom', pages: [pageNum] },
          _mineruBatchDisabled: true,
          _suppressMinerUExcelDownload: true,
          _skipMinerUExcelRepair: true
        }, progress => {
          const innerProgress = Number(progress?.progress || 0) / 100;
          onProgress?.({
            percentage: Math.min(99, Math.round((completed + innerProgress) / pageNums.length * 100)),
            phase: `特殊块直接识别：第 ${pageNum} 页`
          });
        });
        const rawResult = result?.rawMineruResult || {};
        const taskId = rawResult.excel_task_id || rawResult.task_id || rawResult.export_task_id;
        let markdown = getRawMarkdown(rawResult);
        if (!markdown && taskId) {
          try {
            const taskResponse = await fetch(`${mineruBaseUrl}/task/${encodeURIComponent(taskId)}`, {
              cache: 'no-store'
            });
            if (taskResponse.ok) {
              markdown = getRawMarkdown(await taskResponse.json());
            }
          } catch (error) {
            console.warn(`[特殊块] 第 ${pageNum} 页原始 Markdown 获取失败:`, error?.message || error);
          }
        }
        if (!markdown) {
          markdown = [
            ...(Array.isArray(result?.sourceLogicalRows) ? result.sourceLogicalRows : []),
            ...(Array.isArray(result?.logical_rows) ? result.logical_rows : [])
          ].map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
        }
        mapped[pageNum] = {
          content: markdown,
          source: 'special-block-direct-mineru'
        };
        completed += 1;
        onProgress?.({
          percentage: Math.round(completed / pageNums.length * 100),
          phase: `特殊块直接识别 ${completed}/${pageNums.length}`
        });
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return mapped;
  }

  /**
   * 单页OCR识别（内部方法）
   * @param {string} pdfPath - PDF文件路径
   * @param {Object} templateData - 模板数据
   * @param {number} currentPage - 当前页码
   */
  async recognizeSinglePageInternal(pdfPath, templateData = null, currentPage = 1) {
    try {
      console.log('🔧 开始单页OCR识别...');
      
      if (!this.port) {
        console.log('🔄 端口未配置，正在初始化OCR服务...');
        await this.initialize();
      }

      // 使用默认模板或传入的模板
      const templateToUse = templateData || this.getDefaultTemplate();
      
      // 判断模板类型（提前判断，后续需要使用）
      const isMixed = false;  // 内部方法不处理混合模板
      
      const isScaffold = templateToUse && templateToUse.scaffoldArea && 
                        (templateToUse.materialArea === null || templateToUse.materialArea === undefined);
      
      // 验证模板数据完整性
      if (templateToUse) {
        if (isScaffold && templateToUse.scaffoldArea) {
          // 验证支架模板的scaffoldArea
          const area = templateToUse.scaffoldArea;
          if (typeof area.x !== 'number' || typeof area.y !== 'number' ||
              typeof area.width !== 'number' || typeof area.height !== 'number') {
            console.error('❌ 支架模板scaffoldArea配置无效:', area);
            throw new Error('支架模板配置错误：scaffoldArea必须包含有效的坐标信息(x, y, width, height)');
          }
        } else if (templateToUse.materialArea && templateToUse.materialArea !== null) {
          // 验证普通模板的materialArea
          const area = templateToUse.materialArea;
          if (typeof area.x !== 'number' || typeof area.y !== 'number' ||
              typeof area.width !== 'number' || typeof area.height !== 'number') {
            console.error('❌ 模板materialArea配置无效:', area);
            throw new Error('模板配置错误：materialArea必须包含有效的坐标信息(x, y, width, height)');
          }
        }
      }
      
      console.log('📄 单页OCR识别参数:', {
        pdfPath: pdfPath,
        currentPage: currentPage,
        hasTemplate: !!templateData,
        port: this.port
      });
      
      // 打印完整的模板数据用于调试
      console.log('📋 使用的模板数据:', JSON.stringify(templateToUse, null, 2));
      
      // 🔧 准备发送给服务器的模板数据
      const templateForServer = { ...templateToUse };
      
      if (isScaffold && templateToUse.scaffoldArea) {
        // 支架模板：将 scaffoldArea 映射到 materialArea
        // 因为服务器端的 API 总是调用 ocr_material_columns，需要 materialArea 不为 null
        console.log('🏗️ 检测到支架模板，将 scaffoldArea 映射到 materialArea 供服务器使用');
        templateForServer.materialArea = {
          ...templateToUse.scaffoldArea,
          _isScaffoldTemplate: true
        };
      }
      
      const requestUrl = this.getOcrUrl('/api/recognize/single-page-with-coordinates');
      console.log('🌐 发送请求到:', requestUrl);
      
      const requestBody = {
        pdf_path: pdfPath,
        template: templateForServer,
        page_index: currentPage,
        include_coordinates: true,
        coordinate_format: "relative"
      };
      
      console.log('📤 请求体内容:', JSON.stringify(requestBody, null, 2));
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时 (原30秒)
      
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      console.log('📨 收到响应:', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ OCR服务器返回错误:', {
          status: response.status,
          statusText: response.statusText,
          errorText: errorText
        });
        
        if (response.status === 503) {
          console.error('💡 OCR服务未就绪，可能原因:');
          console.error('  1. OCR引擎正在初始化');
          console.error('  2. 模型文件加载失败');
          console.error('  3. 依赖库问题');
        } else if (response.status === 500) {
          console.error('💡 OCR服务内部错误，可能原因:');
          // 检查是否为NoneType错误
          if (errorText.includes('NoneType') && errorText.includes('subscriptable')) {
            console.error('  ⚠️ 检测到NoneType错误 - 这通常意味着:');
            console.error('  1. 模板配置中某些区域为null或未定义');
            console.error('  2. 请确保已在PDF上绘制识别区域');
            console.error('  3. 请检查模板中materialArea是否包含有效坐标');
          } else {
            console.error('  1. PDF文件损坏或无法读取');
            console.error('  2. 模板配置错误');
            console.error('  3. 服务器内部异常');
          }
        }
        
        throw new Error(`OCR服务器错误: ${response.status} - ${errorText}`);
      }
      
      const result = await response.json();
      console.log('✅ OCR识别成功，结果概要:', {
        hasPipeline: !!result.pipeline,
        hasPageNumber: !!result.pageNumber,
        hasDrawingNumber: !!result.drawingNumber,
        materialCount: result.material?.length || 0,
        scaffoldCount: result.scaffold?.length || 0,
        detectionsCount: result.detections?.length || 0,
        hasScaffoldData: !!result.scaffold
      });
      
      // 打印完整的服务器返回结果用于调试
      console.log('📦 服务器返回的完整结果:', result);
      
      // 🔍 重点诊断：检查材料表数据
      if (!result.material || result.material.length === 0) {
        console.warn('⚠️ 后端返回的材料表数据为空！');
        console.warn('🔍 可能的原因:');
        console.warn('  1. 材料表区域没有识别到文字');
        console.warn('  2. 识别到的文字没有被正确解析为材料表格式');
        console.warn('  3. 后端配置问题');
        console.warn('📊 检测数据:', {
          detectionsCount: result.detections?.length || 0,
          hasDetections: !!result.detections
        });
      } else {
        console.log('✅ 材料表数据正常，共', result.material.length, '行');
        console.log('📋 材料表数据示例（前2行）:', result.material.slice(0, 2));
      }
      
      // 🔧 支架模板特殊处理：从 detections 中提取支架信息
      if (isScaffold) {
        console.log('🏗️ 检测到支架模板响应，从 detections 中提取支架信息');
        
        // 严格的支架编号检测：S- 开头 + 至少4位数字
        const scaffoldPattern = /[Ss]-?\d{4,}/;
        
        // 从 detections 中提取包含支架编号的项
        const scaffoldDetections = (result.detections || []).filter(detection => {
          const text = detection.text || '';
          if (!text) return false;
          
          // 检查是否匹配支架格式
          const match = text.match(scaffoldPattern);
          if (!match) return false;
          
          // 检查是否为独立的词（前后有分隔符或边界）
          const matchIndex = match.index;
          const matchedText = match[0];
          const beforeChar = matchIndex > 0 ? text[matchIndex - 1] : ' ';
          const afterIndex = matchIndex + matchedText.length;
          const afterChar = afterIndex < text.length ? text[afterIndex] : ' ';
          
          const separatorPattern = /[\s,，、:：。.\/\-\(\)\[\]【】]/;
          const beforeIsSeparator = matchIndex === 0 || separatorPattern.test(beforeChar);
          const afterIsSeparator = afterIndex === text.length || separatorPattern.test(afterChar);
          
          return beforeIsSeparator && afterIsSeparator;
        });
        
        console.log(`📊 从 ${result.detections?.length || 0} 个检测结果中找到 ${scaffoldDetections.length} 个支架`);
        
        if (scaffoldDetections.length > 0) {
          result.scaffold = scaffoldDetections;
          result.material = []; // 清空 material 数据
          console.log('✅ 支架数据提取完成:', scaffoldDetections.map(d => d.text));
        } else {
          console.warn('⚠️ 未在 detections 中找到支架信息（S-xxx格式）');
          // 如果 detections 中没有，尝试使用 material 数据
          if (result.material && result.material.length > 0) {
            console.log('💡 尝试使用 material 数据作为备选');
            // 支架模板下，material中的数据实际上是识别到的文本行
            // 我们需要将这些行转换为 detections 格式
            const materialDetections = result.material.map((row, idx) => {
              // 获取第一列或者任意包含文本的列
              const text = row.column1?.text || row.column0?.text || Object.values(row)[0]?.text || '';
              // 如果没有box信息，这是一个问题，但我们尽量构造一个
              const box = row.column1?.box || row.column0?.box || null; 
              return {
                text: text,
                confidence: 0.9,
                box: box || [[0,0],[0,0],[0,0],[0,0]] // 防止空box导致错误
              };
            }).filter(d => d.text); // 过滤掉空文本

            result.scaffold = materialDetections;
            // 将这些构造的 detection 也合并到 result.detections 中，以便 visualization 使用
            if (!result.detections) result.detections = [];
            result.detections = [...result.detections, ...materialDetections];
            
            result.material = [];
          }
        }
      }
      
      return this.formatRecognitionResult(result, currentPage, isScaffold);
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('❌ OCR识别超时 (30秒)');
        console.error('💡 可能原因:');
        console.error('  1. PDF文件过大');
        console.error('  2. OCR服务响应缓慢');
        console.error('  3. 网络连接问题');
        throw new Error('OCR识别超时，请重试或检查PDF文件大小');
      } else if (error.message.includes('Failed to fetch') || error.message.includes('ECONNREFUSED')) {
        console.error('❌ 无法连接到OCR服务');
        console.error('💡 可能原因:');
        console.error('  1. OCR服务未启动');
        console.error('  2. 端口配置错误');
        console.error('  3. 防火墙阻止连接');
        throw new Error('无法连接到OCR服务，请检查服务是否正常运行');
      } else {
        console.error('❌ 单页OCR识别失败:', error);
        throw error;
      }
    }
  }

  /**
   * 批量OCR识别
   * @param {Object} params - 批量识别参数
   * @param {Function} onProgress - 进度回调函数
   */
  async runBatchOCR(params, onProgress) {
    // MinerU引擎：走独立接口
    if (params.engine === 'mineru') {
      return await this.runBatchOCRMinerU(params, onProgress);
    }

    // PaddleOCR引擎（默认）
    // Electron环境：使用原有的Electron API
    if (window.electronAPI && window.electronAPI.runBatchOCR) {
      try {
        
        // 调用Electron API进行批量OCR
        const ocrPromise = window.electronAPI.runBatchOCR({
          pdfFile: params.pdfFile,
          template: params.template,
          onProgress: onProgress // 传递进度回调
        });

        const result = await ocrPromise;
        
        
        if (result && result.success && result.data) {

          // 解析结果数据 - 统一格式
          let pages = [];

          if (result.data.logical_rows && Array.isArray(result.data.logical_rows)) {
            pages = result.data.logical_rows;
          } else {
            // 异常情况
            pages = [];
          }
          const logicalRows = [];
          
          const extractCell = (rowObj, idx) => {
            const key = `column${idx}`;
            const cell = rowObj?.[key];
            if (cell && typeof cell === 'object') return cell.text || '';
            return cell || '';
          };
          
          pages.forEach((pageObj) => {
            const pipelineText = pageObj?.pipeline?.text || '';
            const drawingText = pageObj?.drawingNumber?.text || '';
            const pageText = pageObj?.pageNumber?.text || '';
            const materials = Array.isArray(pageObj?.material) ? pageObj.material : [];
            
            materials.forEach((rowObj) => {
              logicalRows.push([
                extractCell(rowObj, 1),
                extractCell(rowObj, 2),
                extractCell(rowObj, 3),
                extractCell(rowObj, 4),
                extractCell(rowObj, 5),
                pipelineText,
                drawingText,
                pageText
              ]);
            });
          });

          
          return {
            success: true,
            logical_rows: logicalRows,
            totalRows: logicalRows.length
          };
          
        } else {
          console.error('❌ OCR服务条件检查失败:', {
            hasResult: !!result,
            result_success: result?.success,
            result_hasData: !!result?.data,
            result_data_hasLogicalRows: !!(result?.data?.logical_rows),
            result_error: result?.error,
            logical_rows_length: result?.data?.logical_rows?.length || 0,
            completeResult: result
          });
          throw new Error(`批量OCR识别失败: ${result?.error || '未知错误'}`);
        }
        
      } catch (error) {
        console.error('❌ 批量OCR识别失败:', error);
        throw error;
      }
    } else {
      // Web环境：使用文件上传API
      return await this.runBatchOCRWeb(params, onProgress);
    }
  }

  /**
   * Web端批量OCR识别 - 通过文件上传实现
   * @param {Object} params - 批量识别参数
   * @param {Function} onProgress - 进度回调函数
   */
  async runBatchOCRWeb(params, onProgress) {
    const pdfFile = params?.pdfFile;
    const taskKey = [
      pdfFile?.name || 'document.pdf',
      pdfFile?.size || 0,
      pdfFile?.lastModified || 0,
      JSON.stringify(params?.template || {})
    ].join('|');
    const existingTask = this.inFlightBatchOcr.get(taskKey);
    if (existingTask) {
      console.warn('[OCR] duplicate batch submission reused:', taskKey.substring(0, 160));
      return existingTask;
    }
    const task = this._runBatchOCRWeb(params, onProgress);
    this.inFlightBatchOcr.set(taskKey, task);
    try {
      return await task;
    } finally {
      if (this.inFlightBatchOcr.get(taskKey) === task) {
        this.inFlightBatchOcr.delete(taskKey);
      }
    }
  }

  async _runBatchOCRWeb(params, onProgress) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OCR_REQUEST_TOTAL_TIMEOUT_MS);
    let reader = null;
    console.log('🌐 使用Web端批量OCR（文件上传方式）');
    
    if (!this.port) {
      await this.initialize();
    }

    const { pdfFile, template } = params;
    
    // 检查是否有有效的PDF文件对象
    if (!pdfFile || !(pdfFile instanceof File || pdfFile instanceof Blob)) {
      throw new Error('Web端批量OCR需要有效的PDF文件对象。请确保PDF文件已正确加载。');
    }

    try {
      const apiUrl = this.getOcrUrl('/api/recognize/batch-upload');
      console.log('📤 上传PDF到OCR服务:', apiUrl);

      // 创建FormData
      const formData = new FormData();
      formData.append('pdf_file', pdfFile, pdfFile.name || 'document.pdf');
      formData.append('template', JSON.stringify(template));

      // 发送请求
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 处理SSE流式响应
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentTaskId = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'task_id') {
                currentTaskId = data.task_id;
                console.log('📋 Web OCR任务ID:', currentTaskId);
                // 存储任务ID供停止功能使用
                window.currentBatchTaskId = currentTaskId;
              } else if (data.type === 'progress' && onProgress) {
                onProgress({
                  progress: data.percentage || 0,
                  status: data.phase || '处理中...',
                  currentPage: data.completed || 0,
                  totalPages: data.total || 0
                });
              } else if (data.type === 'result') {
                // 清除任务ID
                window.currentBatchTaskId = null;
                
                // 解析结果
                let resultData;
                if (data.logical_rows) {
                  resultData = {
                    logical_rows: data.logical_rows,
                    total_pages: data.total_pages || 0
                  };
                } else {
                  resultData = { logical_rows: [], total_pages: 0 };
                }

                // 处理结果数据
                const pages = resultData.logical_rows || [];
                const logicalRows = [];
                
                const extractCell = (rowObj, idx) => {
                  const key = `column${idx}`;
                  const cell = rowObj?.[key];
                  if (cell && typeof cell === 'object') return cell.text || '';
                  return cell || '';
                };
                
                pages.forEach((pageObj) => {
                  const pipelineText = pageObj?.pipeline?.text || '';
                  const drawingText = pageObj?.drawingNumber?.text || '';
                  const pageText = pageObj?.pageNumber?.text || '';
                  const materials = Array.isArray(pageObj?.material) ? pageObj.material : [];
                  
                  materials.forEach((rowObj) => {
                    logicalRows.push([
                      extractCell(rowObj, 1),
                      extractCell(rowObj, 2),
                      extractCell(rowObj, 3),
                      extractCell(rowObj, 4),
                      extractCell(rowObj, 5),
                      pipelineText,
                      drawingText,
                      pageText
                    ]);
                  });
                });

                console.log('✅ Web端批量OCR完成，共识别', logicalRows.length, '行数据');
                
                return {
                  success: true,
                  logical_rows: logicalRows,
                  totalRows: logicalRows.length,
                  stopped: !!data.stopped_at_page,
                  stopped_at_page: data.stopped_at_page || 0
                };
              } else if (data.type === 'error') {
                window.currentBatchTaskId = null;
                throw new Error(data.message);
              }
            } catch (parseError) {
              if (parseError.message && !parseError.message.includes('Unexpected')) {
                throw parseError;
              }
              console.warn('解析OCR进度数据失败:', parseError.message);
            }
          }
        }
      }

      // 如果没有收到结果，返回空结果
      return { success: true, logical_rows: [], totalRows: 0 };
      
    } catch (error) {
      console.error('❌ Web端批量OCR失败:', error);
      window.currentBatchTaskId = null;
      if (error.name === 'AbortError') {
        throw new Error('批量 OCR 任务超过 15 分钟，已中止连接');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      await releaseResponseReader(reader);
      controller.abort();
    }
  }

  /**
   * 停止批量OCR识别
   */
  async stopBatchOCR() {
    if (window.electronAPI && window.electronAPI.stopBatchOCR) {
      return await window.electronAPI.stopBatchOCR();
    } else {
      // Web端：直接调用后端API停止
      return await this.stopBatchOCRWeb();
    }
  }

  /**
   * Web端停止批量OCR识别
   */
  async stopBatchOCRWeb() {
    try {
      await this.stopMinerURecognition();
      window.currentBatchTaskId = null;
      window.currentMinerUJobId = null;
      return { success: true, message: 'MinerU 识别已停止' };

      if (!this.port) {
        await this.initialize();
      }

      const currentTaskId = window.currentBatchTaskId;
      const requestBody = currentTaskId ? { task_id: currentTaskId } : {};

      const stopUrl = this.getOcrUrl('/api/recognize/stop');
      const response = await fetch(stopUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (response.ok) {
        const result = await response.json();
        window.currentBatchTaskId = null;
        return { success: true, message: result.message || 'OCR处理已停止' };
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error('❌ Web端停止OCR失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 调用Web PaddleOCR服务
   * @param {string} base64Image - Base64编码的图片
   * @param {Object} options - 选项参数
   */
  async callWebPaddleOCR(base64Image, options = {}) {
    try {
      if (!this.port) {
        await this.initialize();
      }

      const requestData = {
        image: base64Image,
        ...options
      };
      
      
      const response = await fetch(this.getOcrUrl('/api/ocr/text'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Web PaddleOCR服务错误:', errorText);
        throw new Error(`OCR服务错误: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      
      return result;
    } catch (error) {
      console.error('Web PaddleOCR调用失败:', error);
      throw error;
    }
  }


  /**
   * 材料表OCR调用
   * @param {HTMLCanvasElement} canvas - Canvas元素
   * @param {Object} region - 识别区域
   * @param {Array} splitLines - 分割线数组
   */
  async callMaterialOCR(canvas, region, splitLines = []) {
    
    // 检查运行环境
    const electronAvailable = this.isElectron();
    if (!electronAvailable) {
      console.error('不在Electron环境中');
      throw new Error('OCR功能需要在桌面版中使用，当前为网页开发环境');
    }
    
    // 准备符合后端期望的模板数据格式
    
    const template = {
      materialArea: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        splitLines: splitLines.map((lineX, index) => ({
          id: `split_${index}`,
          x: lineX,
          isVertical: true
        }))
      },
      pipelineArea: null,
      drawingNumberArea: null,
      pageNumberArea: null
    };

    try {
      // 将canvas转换为base64
      const base64Image = canvas.toDataURL('image/png').split(',')[1];
      
      // 调用OCR服务
      const result = await this.callWebPaddleOCR(base64Image, {
        template: template,
        extractMaterials: true
      });

      return result;
    } catch (error) {
      console.error('材料表OCR调用失败:', error);
      throw error;
    }
  }

  /**
   * 格式化识别结果
   * @param {Object} result - 原始识别结果
   * @param {number} currentPage - 当前页码
   */
  /**
   * 检查材料描述中是否包含"阀"字
   * @param {Object} materialRow - 材料行数据
   * @returns {boolean} - 是否包含"阀"字
   */
  hasMaterialValve(materialRow) {
    // 遍历所有列，检查是否有"阀"字
    for (const columnKey in materialRow) {
      if (columnKey.startsWith('column')) {
        const text = materialRow[columnKey]?.text || '';
        if (text.includes('阀')) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 提取材料行的序号（第一列）
   * @param {Object} materialRow - 材料行数据
   * @returns {string} - 材料序号
   */
  getMaterialIndex(materialRow) {
    // 通常序号在第一列 column1
    const firstColumn = materialRow.column1?.text || materialRow.column0?.text || '';
    return firstColumn.trim();
  }

  /**
   * 判断文本是否为纯数字（过滤包含字母的文本）
   * @param {string} text - 输入文本
   * @returns {string|null} - 如果是纯数字返回原文本，否则返回null
   */
  extractPureNumbers(text) {
    if (!text) return null;
    
    // 去除首尾空格
    const trimmed = text.trim();
    if (!trimmed) return null;
    
    // 检查是否只包含数字（可以包含小数点、负号等数字相关符号）
    // 但不能包含字母、汉字
    const hasLetter = /[a-zA-Z]/.test(trimmed);     // 是否包含字母
    const hasChinese = /[\u4e00-\u9fa5]/.test(trimmed); // 是否包含汉字
    
    // 如果包含字母或汉字，直接过滤掉
    if (hasLetter || hasChinese) {
      return null;
    }
    
    // 检查是否至少包含一个数字
    const hasNumber = /\d/.test(trimmed);
    if (!hasNumber) {
      return null;
    }
    
    // 移除所有非数字字符，看是否还有内容
    const pureNumbers = trimmed.replace(/[^0-9]/g, '');
    
    // 如果提取出的纯数字不为空，返回
    if (pureNumbers.length > 0) {
      return pureNumbers;
    }
    
    return null;
  }

  formatRecognitionResult(result, currentPage, isScaffoldTemplate = false) {
    // 🔍 诊断日志：查看后端返回的原始数据
    console.log('🔍 [formatRecognitionResult] 原始数据:', {
      hasMaterial: !!result.material,
      materialLength: result.material?.length || 0,
      materialType: Array.isArray(result.material) ? 'array' : typeof result.material,
      hasDetections: !!result.detections,
      detectionsLength: result.detections?.length || 0,
      isScaffoldTemplate: isScaffoldTemplate,
      resultKeys: Object.keys(result)
    });
    
    const formattedResult = {
      drawingNumber: result.drawingNumber?.text || '',
      pipelineNumber: result.pipeline?.text || '',
      pageNumber: result.pageNumber?.text || result.page_info?.page_index || currentPage,
      materials: result.material ? result.material.map((materialRow, index) => {
        const materialData = {
          key: (index + 1).toString()
        };
        
        // 直接使用后端返回的列字段
        Object.keys(materialRow).forEach(columnKey => {
          if (columnKey.startsWith('column')) {
            const columnData = materialRow[columnKey];
            const text = columnData.text || '';
            materialData[columnKey] = text;
          }
        });
        
        return materialData;
      }) : [],
      // 保存坐标信息用于后续可能的标注功能
      detections: result.detections || [],
      pageInfo: result.page_info || {}
    };
    
    // 🔧 材料表模板识别时，不处理支架相关数据
    if (isScaffoldTemplate) {
      console.log('🏗️ 支架模板识别，处理支架数据');
      // 明确标记这是支架模板识别
      formattedResult.isScaffoldMode = true;
    } else {
      console.log('📋 材料表模板识别，不处理支架数据');
      // 明确标记这是材料表模板识别，不要将 detections 当作支架处理
      formattedResult.isScaffoldMode = false;
      formattedResult.isMaterialMode = true;
      
      // 清除可能存在的支架数据，确保只显示材料表
      if (result.scaffold) {
        console.log('⚠️ 检测到支架数据但当前为材料表模板，清除支架数据');
        result.scaffold = null;
      }
    }
    
    // 🆕 混合模板特殊处理：提取带"阀"字的材料序号
    if (!isScaffoldTemplate && result.material && result.material.length > 0) {
      const valveMaterials = result.material.filter(materialRow => this.hasMaterialValve(materialRow));
      
      if (valveMaterials.length > 0) {
        console.log(`🔧 检测到 ${valveMaterials.length} 条带"阀"字的材料行`);
        
        formattedResult.valveMaterialIndexes = valveMaterials.map(materialRow => {
          const index = this.getMaterialIndex(materialRow);
          console.log(`  - 材料序号: ${index}`);
          return {
            index: index,
            rawData: materialRow
          };
        });
      }
    }
    
    // 🔧 只有在支架模板时才处理支架数据
    if (isScaffoldTemplate && result.scaffold && result.scaffold.length > 0) {
      console.log('🏗️ 格式化支架数据，共 ' + result.scaffold.length + ' 条');
      console.log('🔍 支架数据样例（前2条）:', result.scaffold.slice(0, 2));
      
      // 获取页码信息和图号信息
      const pageInfo = result.pageNumber?.text || result.page_info?.page_index || currentPage || '';
      const drawingNumber = result.drawingNumber?.text || '';
      
      // 直接格式化支架数据（已经从 detections 中过滤过了）
      formattedResult.scaffolds = result.scaffold.map((scaffoldItem, index) => {
        // detections 格式的数据直接有 text 字段
        const scaffoldInfo = scaffoldItem.text || scaffoldItem.scaffoldInfo || '';
        
        // 计算位置信息（如果有box坐标）
        let position = null;
        if (scaffoldItem.box && Array.isArray(scaffoldItem.box) && scaffoldItem.box.length >= 4) {
          // box格式: [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
          const centerX = scaffoldItem.box[0][0] + (scaffoldItem.box[1][0] - scaffoldItem.box[0][0]) / 2;
          const centerY = scaffoldItem.box[0][1] + (scaffoldItem.box[2][1] - scaffoldItem.box[0][1]) / 2;
          position = {
            x: centerX,
            y: centerY
          };
        }
        
        return {
          key: `scaffold-${index + 1}`,
          index: index + 1,
          scaffoldInfo: scaffoldInfo,
          text: scaffoldInfo,
          pageInfo: pageInfo,            // 页码信息
          drawingNumber: drawingNumber,  // 🆕 图号信息
          position: position,            // 位置信息
          score: scaffoldItem.score || 0,
          box: scaffoldItem.box || [],
          coordinates: scaffoldItem.coordinates || {},
          ...scaffoldItem // 保留所有原始字段
        };
      });
      
      console.log(`✅ 格式化完成的支架数据: ${formattedResult.scaffolds.length} 条`);
      console.log('✅ 支架信息列表:', formattedResult.scaffolds.map(s => s.scaffoldInfo));
      console.log('📍 位置信息已添加:', formattedResult.scaffolds.filter(s => s.position).length + ' 条有位置信息');
      
      // 🆕 混合模板特殊处理：提取支架区域的纯数字
      const pureNumbers = [];
      formattedResult.scaffolds.forEach(scaffoldItem => {
        const extracted = this.extractPureNumbers(scaffoldItem.scaffoldInfo);
        if (extracted) {
          pureNumbers.push({
            original: scaffoldItem.scaffoldInfo,
            pureNumber: extracted,
            position: scaffoldItem.position,
            box: scaffoldItem.box
          });
        }
      });
      
      if (pureNumbers.length > 0) {
        console.log(`🔢 从支架区域提取到 ${pureNumbers.length} 个纯数字:`);
        pureNumbers.forEach(item => {
          console.log(`  - 原文: "${item.original}" → 纯数字: "${item.pureNumber}"`);
        });
        formattedResult.scaffoldPureNumbers = pureNumbers;
        
        // 🔧 阀门匹配：将纯数字与阀门序号进行匹配
        if (formattedResult.valveMaterialIndexes && formattedResult.valveMaterialIndexes.length > 0) {
          console.log('\n🔍 开始阀门匹配...');
          console.log(`📋 阀门序号列表: [${formattedResult.valveMaterialIndexes.map(v => v.index).join(', ')}]`);
          
          const valveMatches = [];
          pureNumbers.forEach(item => {
            // 检查纯数字是否在阀门序号列表中
            const matchedValve = formattedResult.valveMaterialIndexes.find(
              valve => valve.index === item.pureNumber
            );
            
            if (matchedValve) {
              valveMatches.push({
                ...item,
                isValve: true,
                valveIndex: matchedValve.index,
                valveData: matchedValve.rawData
              });
              console.log(`  ✅ 匹配成功: "${item.original}" (纯数字: ${item.pureNumber}) → 阀门序号: ${matchedValve.index}`);
            } else {
              console.log(`  ❌ 未匹配: "${item.original}" (纯数字: ${item.pureNumber}) → 不是阀门序号`);
            }
          });
          
          if (valveMatches.length > 0) {
            console.log(`\n🎯 阀门匹配完成: 共匹配到 ${valveMatches.length} 个阀门编号`);
            formattedResult.valveMatches = valveMatches;
            
            // 输出匹配详情
            console.log('🔧 阀门匹配详情:');
            valveMatches.forEach((match, index) => {
              console.log(`  ${index + 1}. 原文: "${match.original}" → 阀门序号: ${match.valveIndex} (位置: x=${match.position?.x?.toFixed(1)}, y=${match.position?.y?.toFixed(1)})`);
            });
          } else {
            console.log('\n⚠️ 没有匹配到任何阀门编号');
          }
        } else {
          console.log('\n⚠️ 材料表中没有阀门序号，跳过阀门匹配');
        }
      }
    }
    
    console.log('📦 formatRecognitionResult 最终返回:', {
      materials: formattedResult.materials?.length || 0,
      scaffolds: formattedResult.scaffolds?.length || 0,
      valveMaterialIndexes: formattedResult.valveMaterialIndexes?.length || 0,
      scaffoldPureNumbers: formattedResult.scaffoldPureNumbers?.length || 0,
      valveMatches: formattedResult.valveMatches?.length || 0,
      detections: formattedResult.detections?.length || 0,
      hasScaffolds: !!formattedResult.scaffolds
    });
    
    return formattedResult;
  }

  /**
   * 获取默认模板
   */
  getDefaultTemplate() {
    return {
      materialArea: null,
      pipelineArea: null,
      drawingNumberArea: null,
      pageNumberArea: null
    };
  }

  /**
   * 检查是否在Electron环境中
   * @deprecated 使用 platformDetect.isElectron() 替代
   */
  isElectron() {
    return isElectron();
  }

  /**
   * OCR结果关联处理 - 新逻辑：材料匹配焊口
   * @param {Array} weldSeamData - 焊口数据
   * @param {Array} ocrLogicalRows - OCR识别结果
   */
  associateWeldSeamWithOCR(weldSeamData, ocrLogicalRows) {
    if (!ocrLogicalRows || ocrLogicalRows.length === 0) {
      message.warning('没有可用的OCR识别结果进行关联');
      return [];
    }

    const getBoundMaterialValue = (material, keys, fallback = '') => {
      for (const key of keys) {
        if (material && material[key] !== undefined && material[key] !== null && material[key] !== '') {
          return material[key];
        }
      }
      return fallback;
    };

    // 新逻辑：构建焊口映射表，支持多种匹配模式
    const weldSeamMap = new Map();
    if (weldSeamData && weldSeamData.length > 0) {
      // 按页面分组处理焊口数据
      const pageGroups = {};
      weldSeamData.forEach(item => {
        const page = item.page || item.calculatedPage;
        if (!pageGroups[page]) {
          pageGroups[page] = [];
        }
        pageGroups[page].push(item);
      });

      // 处理每个页面的焊口数据
      Object.keys(pageGroups).forEach(page => {
        const pageWeldSeams = pageGroups[page];
        
        pageWeldSeams.forEach((item, index) => {
          // 兼容模式：如果有materialNumber，使用旧逻辑
          if (item.materialNumber) {
            const materialNumbers = item.materialNumber;
            let numbers = [];
            
            if (materialNumbers.includes('-')) {
              const parts = materialNumbers.split('-').map(n => n.trim());
              if (parts.length === 2) {
                const start = parseInt(parts[0]);
                const end = parseInt(parts[1]);
                if (!isNaN(start) && !isNaN(end)) {
                  for (let i = start; i <= end; i++) {
                    numbers.push(String(i));
                  }
                }
              }
            } else if (materialNumbers.includes(',')) {
              numbers = materialNumbers.split(',').map(n => n.trim());
            } else if (materialNumbers.includes(' ')) {
              numbers = materialNumbers.split(' ').filter(n => n.trim()).map(n => n.trim());
            } else {
              numbers = [materialNumbers];
            }
            
            numbers.forEach(num => {
              const key = `${page}_${num}`;
              weldSeamMap.set(key, item);
            });
          } else {
            // 新逻辑：根据标注顺序自动分配序号
            const materialSequence = String(index + 1);
            const key = `${page}_${materialSequence}`;
            weldSeamMap.set(key, item);
          }
        });
      });
    }

    // 以OCR材料数据为主体，根据计算页码和序号匹配焊口
    const associatedResults = ocrLogicalRows.map(ocrRow => {
      const ocrCalculatedPage = ocrRow[8] ? String(ocrRow[8]).trim() : '';
      const ocrSequence = ocrRow[0] ? String(ocrRow[0]).trim() : '';
      
      const matchKey = `${ocrCalculatedPage}_${ocrSequence}`;
      const matchedWeldSeam = weldSeamMap.get(matchKey);
      const boundMaterial = matchedWeldSeam?.materialBinding || null;

      return {
        序号: getBoundMaterialValue(boundMaterial, ['materialId', '序号', 'ID', 'id'], ocrRow[0] || ''),
        材料描述: getBoundMaterialValue(boundMaterial, ['description', '材料描述', 'DESCRIPTION', 'text'], ocrRow[1] || ''),
        规格: getBoundMaterialValue(boundMaterial, ['specification', '规格'], ocrRow[2] || ''),
        管径: getBoundMaterialValue(boundMaterial, ['diameter', '管径', 'ND'], ''),
        接头形式: getBoundMaterialValue(boundMaterial, ['jointType', '接头形式', 'type', '类型'], ''),
        材料代码: getBoundMaterialValue(boundMaterial, ['materialCode', '材料代码', '材料编码', 'ITEM_CODE', 'itemCode'], ocrRow[3] || ''),
        数量: getBoundMaterialValue(boundMaterial, ['quantity', '数量', 'QTY'], ocrRow[4] || ''),
        单位: getBoundMaterialValue(boundMaterial, ['unit', '单位'], ocrRow[5] || ''),
        类型: getBoundMaterialValue(boundMaterial, ['type', '类型'], ocrRow[6] || ''),
        OCR页码: ocrRow[7] || '',
        计算页码: ocrRow[8] || '',
        焊口号: matchedWeldSeam ? (matchedWeldSeam.weldSeam || matchedWeldSeam.text) : '',
        焊口形状: matchedWeldSeam ? this.getWeldShape(matchedWeldSeam.borderShape) : ''
      };
    });

    const matchedCount = associatedResults.filter(result => result.焊口号).length;
    console.log(`📊 材料匹配焊口结果: ${matchedCount}/${ocrLogicalRows.length} (${((matchedCount/ocrLogicalRows.length)*100).toFixed(1)}%)`);

    return associatedResults;
  }

  /**
   * 焊口形状映射函数
   * @param {string} borderShape - 标注边框形状
   */
  getWeldShape(borderShape) {
    switch (borderShape) {
      case 'circle':
        return 'S';  // 圆形框 -> S
      case 'split-circle':
        return 'S';  // 分栏圆形 -> S
      case 'diamond':
        return 'F';  // 菱形框 -> F
      case 'field-weld':
        return 'F';  // 现场焊缝 -> F
      case 'shop-weld':
        return 'S';  // 车间焊缝 -> S
      default:
        return '';   // 无特定形状
    }
  }

  /**
   * 材料编码API集成服务 - 根据真实API文档实现
   * @param {Array} logicalRows - OCR识别的完整数据行
   * @param {string} pdfFileName - PDF文件名
   */
  async processMaterialEncoding(logicalRows, pdfFileName = 'ocr_result') {
    try {
      // 使用相对路径，通过代理访问
      const baseUrl = process.env.NODE_ENV === 'development' ? '' : 'http://211.138.201.11:8082';
      
      // 提取材料描述列（第2列，索引为1）
      const descriptions = logicalRows
        .map(row => row[1]) // 材料描述
        .filter(desc => desc && desc.trim()) // 过滤空值
        .slice(0, 100); // 限制最多100条，避免API超载

      if (descriptions.length === 0) {
        return { results: [] };
      }
      
      // 第1步：创建异步批量编码任务
      const taskId = await this.createBatchEncodingTask(baseUrl, descriptions);
      
      // 第2步：轮询任务状态直到完成
      const result = await this.pollBatchTaskStatus(baseUrl, taskId);
      
      return result;
      
    } catch (error) {
      console.error('❌ 材料编码处理失败:', error);
      // 直接抛出错误，不使用Mock服务
      throw error;
    }
  }

  /**
   * 创建批量编码任务
   */
  async createBatchEncodingTask(baseUrl, descriptions) {
    const response = await fetch(`${baseUrl}/materials/batch-encode-async`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        descriptions: descriptions,
        max_workers: 20,
        max_requests_per_minute: 600
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`创建编码任务失败: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const taskId = result.task_id;
    
    if (!taskId) {
      throw new Error('API响应中缺少task_id');
    }
    
    return taskId;
  }

  /**
   * 轮询批量任务状态
   */
  async pollBatchTaskStatus(baseUrl, taskId) {
    const maxAttempts = 300; // 最多轮询10分钟 (300 * 2秒) - 适应大批量数据处理
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        // 查询任务状态
        const statusResponse = await fetch(`${baseUrl}/materials/batch-task-status/${taskId}`);
        
        if (!statusResponse.ok) {
          throw new Error(`查询任务状态失败: ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const { status, progress = 0, total = 0, completed = 0 } = statusData;
        
        // 检查任务是否完成
        if (status === 'completed') {
          return await this.getBatchTaskResult(baseUrl, taskId);
        }

        // 检查任务是否失败或终止
        if (status === 'terminated' || status === 'failed') {
          throw new Error(`编码任务失败，状态: ${status}`);
        }

        // 如果还在处理中，等待2秒后继续轮询
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;

      } catch (error) {
        console.error('轮询任务状态时出错:', error);
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error(`编码任务超时: ${error.message}`);
        }
        // 等待2秒后重试
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    throw new Error('编码任务超时，超过最大轮询次数');
  }

  /**
   * 获取批量任务结果 - 处理真实API返回的详细编码数据
   */
  async getBatchTaskResult(baseUrl, taskId) {
    const resultResponse = await fetch(`${baseUrl}/materials/batch-task-result/${taskId}`);
    
    if (!resultResponse.ok) {
      throw new Error(`获取任务结果失败: ${resultResponse.status}`);
    }

    const resultData = await resultResponse.json();
    
    // 处理真实API返回的数据结构，转换为统一格式
    if (resultData.results && Array.isArray(resultData.results)) {
      const processedResults = resultData.results.map((item, index) => {
        // 从tags和ai_mapped_tags中提取详细信息
        const tags = item.tags || {};
        const aiMappedTags = item.ai_mapped_tags || {};
        const allTags = { ...tags, ...aiMappedTags };
        
        // 根据真实API返回的字段映射到我们需要的结构
        return {
          code: item.code || '',
          confidence: item.confidence || 0,
          source: item.source || '外部材料编码API',
          original_description: item.original_description || '',
          
          // 从tags和ai_mapped_tags中提取详细信息
          category: allTags.category || allTags.type || allTags.种类 || 
                   tags.material_type || aiMappedTags.material_type || '',    // 种类
          
          size: allTags.size || allTags.dimension || allTags.diameter || allTags.尺寸 || 
               tags.nominal_diameter || aiMappedTags.nominal_diameter || '',   // 尺寸
          
          wall_thickness: allTags.wall_thickness || allTags.thickness || allTags.壁厚 || 
                         tags.wall_thickness || aiMappedTags.wall_thickness || '', // 壁厚
          
          pressure_rating: allTags.pressure_rating || allTags.rating || allTags.pressure_class || allTags.磅级 || 
                          tags.pressure_rating || aiMappedTags.pressure_rating || '', // 磅级
          
          material: allTags.material || allTags.material_grade || allTags.材质 || 
                   tags.material_grade || aiMappedTags.material_grade || '',   // 材质
          
          standard: allTags.standard || allTags.specification || allTags.规范 || 
                   item.standard_name || tags.standard || aiMappedTags.standard || '', // 规范
          
          tags: allTags
        };
      });
      
      return {
        results: processedResults
      };
    }
    
    return resultData;
  }


  /**
   * Mock材料编码服务 - 仅用于调试和开发测试
   * 注意：此服务不再在生产环境中自动调用，以确保数据真实性
   */
  async mockMaterialEncoding(logicalRows) {
    // 模拟API处理时间
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const mockResults = logicalRows.map((row, index) => {
      const description = row[1] || ''; // 材料描述列
      
      // 根据材料描述生成详细的编码信息
      let result = {
        code: 'UNKNOWN-001',
        confidence: 0.75,
        source: 'Mock AI编码服务',
        original_description: description,
        category: '未知类型',        // 种类
        size: '',                   // 尺寸
        wall_thickness: '',         // 壁厚
        pressure_rating: '',        // 磅级
        material: '',               // 材质
        standard: '',               // 规范
        tags: {}
      };
      
      if (description.includes('钢管') || description.includes('管')) {
        // 解析管材信息
        const sizeMatch = description.match(/DN\s*(\d+)|Φ\s*(\d+)/i);
        const thicknessMatch = description.match(/×\s*(\d+(?:\.\d+)?)|壁厚\s*(\d+(?:\.\d+)?)/i);
        const materialMatch = description.match(/(碳钢|不锈钢|合金钢|铸钢)/);
        
        result = {
          ...result,
          code: `PIPE-${index.toString().padStart(3, '0')}`,
          confidence: 0.92,
          category: '管材',
          size: sizeMatch ? `DN${sizeMatch[1] || sizeMatch[2]}` : 'DN100',
          wall_thickness: thicknessMatch ? `${thicknessMatch[1] || thicknessMatch[2]}mm` : '4mm',
          pressure_rating: 'SCH40',
          material: materialMatch ? materialMatch[1] : '碳钢',
          standard: 'ASTM A106',
          tags: { type: '管材', application: '输送管道' }
        };
      } else if (description.includes('法兰')) {
        const sizeMatch = description.match(/DN\s*(\d+)/i);
        const ratingMatch = description.match(/(\d+)LB|PN\s*(\d+)/i);
        const materialMatch = description.match(/(碳钢|不锈钢|合金钢|铸钢)/);
        
        result = {
          ...result,
          code: `FLANGE-${index.toString().padStart(3, '0')}`,
          confidence: 0.88,
          category: '法兰',
          size: sizeMatch ? `DN${sizeMatch[1]}` : 'DN100',
          wall_thickness: '',
          pressure_rating: ratingMatch ? `${ratingMatch[1] || ratingMatch[2]}${ratingMatch[1] ? 'LB' : 'PN'}` : '150LB',
          material: materialMatch ? materialMatch[1] : '碳钢',
          standard: 'ASME B16.5',
          tags: { type: '法兰', connection: '对焊' }
        };
      } else if (description.includes('阀门') || description.includes('阀')) {
        const sizeMatch = description.match(/DN\s*(\d+)/i);
        const typeMatch = description.match(/(球阀|闸阀|截止阀|止回阀)/);
        const materialMatch = description.match(/(碳钢|不锈钢|合金钢|铸钢)/);
        
        result = {
          ...result,
          code: `VALVE-${index.toString().padStart(3, '0')}`,
          confidence: 0.85,
          category: '阀门',
          size: sizeMatch ? `DN${sizeMatch[1]}` : 'DN50',
          wall_thickness: '',
          pressure_rating: '150LB',
          material: materialMatch ? materialMatch[1] : '铸钢',
          standard: 'API 600',
          tags: { type: typeMatch ? typeMatch[1] : '球阀', operation: '手动' }
        };
      } else if (description.includes('弯头')) {
        const sizeMatch = description.match(/DN\s*(\d+)|Φ\s*(\d+)/i);
        const angleMatch = description.match(/(\d+)°/);
        const materialMatch = description.match(/(碳钢|不锈钢|合金钢|铸钢)/);
        
        result = {
          ...result,
          code: `ELBOW-${index.toString().padStart(3, '0')}`,
          confidence: 0.90,
          category: '弯头',
          size: sizeMatch ? `DN${sizeMatch[1] || sizeMatch[2]}` : 'DN80',
          wall_thickness: '4mm',
          pressure_rating: 'SCH40',
          material: materialMatch ? materialMatch[1] : '碳钢',
          standard: 'ASME B16.9',
          tags: { type: '弯头', angle: angleMatch ? `${angleMatch[1]}°` : '90°' }
        };
      }
      
      return result;
    });
    
    return {
      results: mockResults
    };
  }

  /**
   * 轮询编码任务状态
   */
  async pollEncodingTask(baseUrl, taskId) {
    const maxAttempts = 300; // 最多轮询5分钟
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const statusResponse = await fetch(`${baseUrl}/materials/batch-task-status/${taskId}`);
        
        if (!statusResponse.ok) {
          throw new Error(`查询任务状态失败: ${statusResponse.status}`);
        }

        const status = await statusResponse.json();

        if (status.status === 'completed') {
          // 任务完成，获取结果
          const resultResponse = await fetch(`${baseUrl}/materials/batch-task-result/${taskId}`);
          
          if (!resultResponse.ok) {
            throw new Error(`获取任务结果失败: ${resultResponse.status}`);
          }

          const results = await resultResponse.json();
          return results;
        }

        if (status.status === 'terminated' || status.status === 'failed') {
          throw new Error(`编码任务失败，状态: ${status.status}`);
        }

        // 等待2秒后继续轮询
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;

      } catch (error) {
        console.error('轮询任务状态时出错:', error);
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error('编码任务超时或失败');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    throw new Error('编码任务超时');
  }

  /**
   * 探测外部API的可用接口
   */
  async probeExternalAPI() {
    // 使用相对路径，通过代理访问
    const baseUrl = process.env.NODE_ENV === 'development' ? '' : 'http://211.138.201.11:8082';
    const results = {
      baseUrl: baseUrl,
      accessible: false,
      endpoints: [],
      error: null,
      apiTest: null
    };
    
    try {
      console.log('🔍 开始探测材料编码API接口...');
      
      // 1. 测试根路径（处理CORS问题）
      try {
        const rootResponse = await fetch(baseUrl, {
          method: 'GET',
          mode: 'cors'
        });
        results.accessible = true;
        results.rootStatus = rootResponse.status;
      } catch (error) {
        // CORS失败不意味着服务器不存在，继续测试API接口
        if (error.message.includes('CORS') || error.message.includes('Failed to fetch')) {
          results.accessible = true; // 假设服务器存在，只是CORS限制
          results.rootStatus = 'CORS_BLOCKED';
          results.corsIssue = true;
        } else {
          results.error = error.message;
          console.error('❌ 服务器完全不可访问:', error.message);
          return results;
        }
      }
      
      // 2. 测试批量编码接口
      try {
        const testResponse = await fetch(`${baseUrl}/materials/batch-encode-async`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            descriptions: ["测试材料描述"],
            max_workers: 1,
            max_requests_per_minute: 10
          })
        });
        
        if (testResponse.ok) {
          const testResult = await testResponse.json();
          results.endpoints.push('/materials/batch-encode-async (可用)');
          results.apiTest = {
            success: true,
            taskId: testResult.task_id,
            response: testResult
          };
        } else {
          const errorText = await testResponse.text();
          results.endpoints.push(`/materials/batch-encode-async (${testResponse.status})`);
          results.apiTest = {
            success: false,
            status: testResponse.status,
            error: errorText
          };
        }
      } catch (error) {
        results.endpoints.push('/materials/batch-encode-async (不可用)');
        results.apiTest = {
          success: false,
          error: error.message
        };
      }
      
      // 3. 测试其他相关接口
      const relatedEndpoints = [
        '/materials',
        '/api/materials',
        '/docs',
        '/swagger',
        '/api/docs'
      ];
      
      for (const endpoint of relatedEndpoints) {
        try {
          const response = await fetch(`${baseUrl}${endpoint}`, {
            method: 'GET',
            mode: 'cors'
          });
          
          if (response.ok) {
            results.endpoints.push(`${endpoint} (${response.status})`);
          } else {
            results.endpoints.push(`${endpoint} (${response.status})`);
          }
        } catch (error) {
          // 静默失败
        }
      }
      
    } catch (error) {
      results.error = error.message;
      console.error('❌ API探测失败:', error);
    }
    
    return results;
  }

  /**
   * 启动WebSocket识别（返回任务ID和WebSocket连接）
   */
  async startWebSocketRecognition(pdfPath, templateData = null, callbacks = {}) {
    try {
      if (!this.port) {
        await this.initialize();
      }

      const templateToUse = templateData || this.getDefaultTemplate();
      const taskId = this.generateTaskId();
      
      // 🔧 判断模板类型并进行映射（与单页识别保持一致）
      const isMixed = templateToUse && 
                     templateToUse.materialArea && 
                     templateToUse.scaffoldArea &&
                     typeof templateToUse.materialArea.x === 'number' &&
                     typeof templateToUse.scaffoldArea.x === 'number';
      
      const isScaffold = !isMixed && templateToUse && templateToUse.scaffoldArea && 
                        (templateToUse.materialArea === null || templateToUse.materialArea === undefined);
      
      console.log('🔧 批量识别模板类型:', { isMixed, isScaffold });
      
      // 准备发送给服务器的模板数据
      const templateForServer = { ...templateToUse };
      
      if (isMixed) {
        console.log('🔀 批量识别：检测到混合模板');
        templateForServer._isMixedTemplate = true;
      } else if (isScaffold && templateToUse.scaffoldArea) {
        console.log('🏗️ 批量识别：检测到支架模板，将 scaffoldArea 映射到 materialArea');
        templateForServer.materialArea = {
          ...templateToUse.scaffoldArea,
          _isScaffoldTemplate: true
        };
      }
      
      // 创建WebSocket连接
      const wsUrl = this.getOcrWebSocketUrl(`/api/recognize/websocket/${taskId}`);
      const websocket = new WebSocket(wsUrl);
      websocket.__ocrTaskId = taskId;
      websocket.__ocrTotalTimer = setTimeout(() => {
        callbacks.onError?.(new Error('OCR WebSocket 任务超过 15 分钟，连接已关闭'));
        this.closeWebSocket(websocket);
      }, OCR_REQUEST_TOTAL_TIMEOUT_MS);
      this.activeOcrWebSockets.add(websocket);
      
      // WebSocket连接打开
      websocket.onopen = () => {
        console.log('WebSocket连接已建立');
        
        // 发送识别请求
        websocket.send(JSON.stringify({
          action: "start_recognition",
          pdf_path: pdfPath,
          template: templateForServer,  // 使用映射后的模板
          coordinate_format: "relative"
        }));
      };
      
      // WebSocket消息处理
      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          switch (data.type) {
            case 'started':
              callbacks.onStarted?.(data.total_pages, data.task_id);
              break;
            case 'page_start':
              callbacks.onPageStart?.(data.page);
              break;
            case 'page_completed':
              // 🔍 诊断日志：WebSocket返回的原始数据
              console.log(`🔍 [WebSocket-第${data.page}页] 原始数据:`, {
                hasMaterial: !!data.data.material,
                materialLength: data.data.material?.length || 0,
                materialType: Array.isArray(data.data.material) ? 'array' : typeof data.data.material,
                hasDetections: !!data.detections,
                detectionsLength: data.detections?.length || 0,
                dataKeys: Object.keys(data.data)
              });
              
              // 🔍 重点诊断：检查材料表数据
              if (!data.data.material || data.data.material.length === 0) {
                console.warn(`⚠️ [WebSocket-第${data.page}页] 后端返回的材料表数据为空！`);
                console.warn('📊 检测数据:', {
                  detectionsCount: data.detections?.length || 0,
                  hasDetections: !!data.detections
                });
              } else {
                console.log(`✅ [WebSocket-第${data.page}页] 材料表数据正常，共`, data.data.material.length, '行');
              }
              
              // 🔧 支架模板特殊处理（与单页识别保持一致）
              if (isScaffold) {
                const scaffoldPattern = /[Ss]-?\d{4,}/;
                
                // WebSocket 的 detections 在外层 data.detections，不在 data.data.detections
                const detectionsArray = data.detections || data.data.detections || [];
                console.log(`🔍 第${data.page}页 detections 位置:`, {
                  outerDetections: data.detections?.length || 0,
                  innerDetections: data.data.detections?.length || 0,
                  using: detectionsArray.length
                });
                
                const scaffoldDetections = detectionsArray.filter(detection => {
                  const text = detection.text || '';
                  if (!text) return false;
                  
                  // 检查是否匹配支架格式
                  const match = text.match(scaffoldPattern);
                  if (!match) return false;
                  
                  // 检查是否为独立的词（前后有分隔符或边界）
                  const matchIndex = match.index;
                  const matchedText = match[0];
                  const beforeChar = matchIndex > 0 ? text[matchIndex - 1] : ' ';
                  const afterIndex = matchIndex + matchedText.length;
                  const afterChar = afterIndex < text.length ? text[afterIndex] : ' ';
                  
                  const separatorPattern = /[\s,，、:：。.\/\-\(\)\[\]【】]/;
                  const beforeIsSeparator = matchIndex === 0 || separatorPattern.test(beforeChar);
                  const afterIsSeparator = afterIndex === text.length || separatorPattern.test(afterChar);
                  
                  return beforeIsSeparator && afterIsSeparator;
                });
                
                if (scaffoldDetections.length > 0) {
                  data.data.scaffold = scaffoldDetections;
                  data.data.material = [];
                  console.log(`✅ 第${data.page}页支架数据提取: ${scaffoldDetections.length} 个`, scaffoldDetections.map(d => d.text));
                } else {
                  console.warn(`⚠️ 第${data.page}页未在 detections 中找到支架信息，detections 总数: ${detectionsArray.length}`);
                  // 不使用 material 作为备选，因为它是材料表格式，没有完整的支架文本
                  data.data.scaffold = [];
                  data.data.material = [];
                }
              }
              
              // 格式化WebSocket识别结果，保持与单页识别一致的数据结构
              const formattedData = this.formatRecognitionResult(data.data, data.page, isScaffold);
              
              console.log(`🎯 WebSocket-第${data.page}页回调数据:`, {
                materials: formattedData.materials?.length || 0,
                scaffolds: formattedData.scaffolds?.length || 0,
                detections: formattedData.detections?.length || 0,
                originalDetections: data.detections?.length || 0
              });
              
              callbacks.onPageCompleted?.(data.page, formattedData, data.detections, data.progress, websocket);
              break;
            case 'page_error':
              callbacks.onPageError?.(data.page, data.error);
              break;
            case 'stopped':
              callbacks.onStopped?.(data.page);
              this.closeWebSocket(websocket);
              break;
            case 'completed':
              callbacks.onCompleted?.();
              this.closeWebSocket(websocket);
              break;
            case 'failed':
              callbacks.onFailed?.(data.error);
              this.closeWebSocket(websocket);
              break;
            case 'error':
              callbacks.onError?.(data.message);
              this.closeWebSocket(websocket);
              break;
          }
        } catch (e) {
          console.error('解析WebSocket数据失败:', e);
          callbacks.onError?.(e);
          this.closeWebSocket(websocket);
        }
      };
      
      // WebSocket错误处理
      websocket.onerror = (error) => {
        console.error('WebSocket连接错误:', error);
        callbacks.onError?.(error);
        this.closeWebSocket(websocket);
      };
      
      // WebSocket关闭处理
      websocket.onclose = (event) => {
        clearTimeout(websocket.__ocrTotalTimer);
        this.activeOcrWebSockets.delete(websocket);
        console.log('WebSocket连接已关闭', event.code, event.reason);
        callbacks.onClose?.(event);
      };
      
      return { taskId, websocket };
      
    } catch (e) {
      console.error('启动WebSocket识别失败:', e);
      throw e;
    }
  }

  /**
   * 生成任务ID
   */
  generateTaskId() {
    return 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 发送页面渲染完成确认
   */
  confirmPageRendered(websocket, page) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        action: "page_rendered",
        page: page
      }));
      console.log(`发送第${page}页渲染完成确认`);
    }
  }

  /**
   * 发送停止识别请求
   */
  requestStopRecognition(websocket) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        action: "stop_request"
      }));
      clearTimeout(websocket.__ocrStopTimer);
      websocket.__ocrStopTimer = setTimeout(() => this.closeWebSocket(websocket), 2000);
    } else {
      this.closeWebSocket(websocket);
    }
  }

  /**
   * 停止识别（必须带任务ID）
   */
  async stopRecognition(taskId) {
    if (!taskId) throw new Error('缺少任务ID');
    if (!this.port) {
      await this.initialize();
    }
    const resp = await fetch(this.getOcrUrl('/api/recognize/stop'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
    if (!resp.ok) throw new Error(`停止失败: ${resp.status}`);
    return await resp.json();
  }

  /**
   * 安全关闭WebSocket连接
   */
  closeWebSocket(websocket) {
    if (websocket && websocket.readyState !== WebSocket.CLOSED) {
      try {
        clearTimeout(websocket.__ocrTotalTimer);
        clearTimeout(websocket.__ocrStopTimer);
        this.activeOcrWebSockets.delete(websocket);
        console.log('关闭WebSocket连接');
        websocket.close(1000, '识别完成或停止');
      } catch (error) {
        console.error('关闭WebSocket连接时发生错误:', error);
      }
    }
  }

  /**
   * 使用 pdf-lib 从原始 PDF 中提取指定页码，生成一个只含这些页的新 PDF Blob。
   * pages 参数格式：{ type: 'custom', pages: [1, 3, 5] } 或 { type: 'range', start: 1, end: 5 }
   * 页码为 1-based。返回 Blob，如果无需切页则返回 null。
   */
  async _extractPdfPages(pdfFileOrBlob, pages) {
    if (!pages) return null;

    let pageNums = [];
    if (pages.type === 'custom' && Array.isArray(pages.pages)) {
      pageNums = pages.pages.map(p => parseInt(p));
    } else if (pages.type === 'range') {
      const start = parseInt(pages.start) || 1;
      const end = parseInt(pages.end) || 9999;
      for (let i = start; i <= end; i++) pageNums.push(i);
    } else if (pages.type === 'all') {
      return null; // 全部页，不需要切
    }

    if (pageNums.length === 0) return null;

    const { PDFDocument } = await import('pdf-lib');

    const arrayBuffer = await pdfFileOrBlob.arrayBuffer();
    const srcDoc = await PDFDocument.load(arrayBuffer);
    const totalPages = srcDoc.getPageCount();

    const newDoc = await PDFDocument.create();
    const validPageNums = [];
    for (const pageNum of pageNums) {
      const idx = pageNum - 1; // 转为 0-based
      if (idx < 0 || idx >= totalPages) continue;
      const [copiedPage] = await newDoc.copyPages(srcDoc, [idx]);
      newDoc.addPage(copiedPage);
      validPageNums.push(pageNum);
    }

    const newPdfBytes = await newDoc.save();
    return {
      blob: new Blob([newPdfBytes], { type: 'application/pdf' }),
      validPageNums
    };
  }

  async _resolvePdfPageNums(pdfFileOrBlob, pages) {
    const { PDFDocument } = await import('pdf-lib');
    const arrayBuffer = await pdfFileOrBlob.arrayBuffer();
    const srcDoc = await PDFDocument.load(arrayBuffer);
    const totalPages = srcDoc.getPageCount();

    if (!pages || pages.type === 'all') {
      return Array.from({ length: totalPages }, (_, idx) => idx + 1);
    }
    if (pages.type === 'custom' && Array.isArray(pages.pages)) {
      return pages.pages
        .map(p => parseInt(p))
        .filter(p => Number.isInteger(p) && p >= 1 && p <= totalPages);
    }
    if (pages.type === 'range') {
      const start = Math.max(1, parseInt(pages.start) || 1);
      const end = Math.min(totalPages, parseInt(pages.end) || totalPages);
      return Array.from({ length: Math.max(0, end - start + 1) }, (_, idx) => start + idx);
    }
    return [];
  }

  async _restartMinerUService(MINERU_BASE, onProgress) {
    onProgress && onProgress({ status: 'MinerU 正在回收 vLLM 状态...' });
    try {
      await fetch(`${MINERU_BASE}/admin/restart`, { method: 'POST' });
    } catch (e) {
      console.warn('[MinerU] restart request interrupted:', e.message);
    }

    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const resp = await fetch(`${MINERU_BASE}/health`, { cache: 'no-store' });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.ready && data.running_tasks === 0 && data.queued_tasks === 0) {
          onProgress && onProgress({ status: 'MinerU 已恢复，继续下一批...' });
          return true;
        }
      } catch (e) {
        // Service is expected to be briefly unavailable while restarting.
      }
    }
    throw new Error('MinerU 重启后等待恢复超时');
  }

  async _waitMinerUReady(MINERU_BASE, onProgress, timeoutMs = 5 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${MINERU_BASE}/health`, { cache: 'no-store' });
        if (resp.ok) {
          const data = await resp.json();
          if (data.ready && data.running_tasks === 0 && data.queued_tasks === 0) {
            return true;
          }
        }
      } catch (e) {
        // Keep waiting; the Windows watchdog may be restarting Docker/MinerU.
      }
      onProgress && onProgress({ status: 'MinerU 服务异常，等待自动恢复...' });
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('MinerU 服务等待恢复超时');
  }

  /**
   * MinerU 批量识别入口
   * @param {Object} params - { pdfFile, template, pdfFileName, engine, ... }
   * @param {Function} onProgress - 进度回调 (progressData) => void
   */
  async runBatchOCRMinerU(params, onProgress) {
      const MINERU_BASE = await this.getMineruBaseUrl();
    const {
      pdfFile,
      template,
      pdfFileName,
      pages,
      _mineruBatchDisabled = false,
      _suppressMinerUExcelDownload = false,
      _skipMinerUExcelRepair = false,
    } = params;

    this.mineruStopRequested = false;
    if (this.mineruStopRequested) {
      throw new Error('MinerU 识别已停止');
    }

    onProgress && onProgress({ progress: 5, status: '正在连接 MinerU 服务...' });

    const isLocalPath = typeof pdfFile === 'string' && !pdfFile.startsWith('blob:');
    const configuredBatchSize = parseInt(localStorage.getItem('mineruBatchSize') || '10', 10) || 10;
    const mineruBatchSize = 0; // Remote MinerU handles selected pages in one job; keep page slicing, disable auto-batching.
    if (!_mineruBatchDisabled && !isLocalPath && mineruBatchSize > 0) {
      const pageNums = await this._resolvePdfPageNums(pdfFile, pages);
      if (pageNums.length > mineruBatchSize) {
        const allRows = [];
        const batches = [];
        for (let i = 0; i < pageNums.length; i += mineruBatchSize) {
          batches.push(pageNums.slice(i, i + mineruBatchSize));
        }

        console.log(`[MinerU] 启用自动分批：${pageNums.length} 页，${batches.length} 批，每批最多 ${mineruBatchSize} 页`);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          if (this.mineruStopRequested) {
            throw new Error('MinerU 识别已停止');
          }
          const batchPages = batches[batchIndex];
          const batchLabel = `${batchIndex + 1}/${batches.length}`;
          onProgress && onProgress({
            progress: Math.round((batchIndex / batches.length) * 90),
            status: `MinerU 分批识别中：第 ${batchLabel} 批（页 ${batchPages[0]}-${batchPages[batchPages.length - 1]}）`,
          });

          let batchResult = null;
          const maxBatchAttempts = 2;
          for (let attempt = 1; attempt <= maxBatchAttempts; attempt++) {
            try {
              batchResult = await this.runBatchOCRMinerU({
                ...params,
                pages: { type: 'custom', pages: batchPages },
                _mineruBatchDisabled: true,
                _suppressMinerUExcelDownload: true,
              }, (progressData) => {
                if (!onProgress) return;
                const innerProgress = progressData?.progress || 0;
                const overall = Math.min(95, Math.round(((batchIndex + innerProgress / 100) / batches.length) * 95));
                onProgress({
                  ...progressData,
                  progress: overall,
                  status: `MinerU 第 ${batchLabel} 批：${progressData?.status || '识别中'}`,
                });
              });
              break;
            } catch (e) {
              if (this.mineruStopRequested) {
                throw new Error('MinerU 识别已停止');
              }
              if (attempt >= maxBatchAttempts) throw e;
              console.warn(`[MinerU] batch ${batchLabel} failed, waiting for recovery and retrying:`, e);
              onProgress && onProgress({ status: `MinerU 第 ${batchLabel} 批异常，等待恢复后重试...` });
              await this._waitMinerUReady(MINERU_BASE, onProgress);
            }
          }

          allRows.push(...(batchResult.logical_rows || []));
          if (this.mineruStopRequested) {
            throw new Error('MinerU 识别已停止');
          }
          if (batchIndex < batches.length - 1 && localStorage.getItem('mineruRestartBetweenBatches') !== '0') {
            await this._restartMinerUService(MINERU_BASE, onProgress);
          }
        }

        onProgress && onProgress({ progress: 100, status: 'MinerU 分批识别完成' });
        return {
          success: true,
          logical_rows: allRows,
          totalRows: allRows.length,
          serverExcelDownloaded: false,
          excel_task_id: null,
          fromMinerU: true,
          batched: true,
        };
      }
    }

    let response;

    // Electron 环境：pdfFile 是本地路径字符串，直接传路径给后端
    if (typeof pdfFile === 'string' && !pdfFile.startsWith('blob:')) {
      const pagesJson = pages ? JSON.stringify(pages) : null;
      onProgress && onProgress({ progress: 10, status: '正在提交 MinerU 识别任务（本地路径模式）...' });
      response = await fetch(`${MINERU_BASE}/pdf/recognize-by-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdf_path: pdfFile,
          template: JSON.stringify(template),
          lang: 'ch',
          ...(pagesJson ? { pages: pagesJson } : {})
        })
      });
    } else {
      // Web 环境：先用 pdf-lib 提取指定页，再上传小文件
      onProgress && onProgress({ progress: 8, status: '正在提取指定页面...' });

      let uploadFile = pdfFile;
      let uploadFileName = pdfFileName || (pdfFile instanceof File ? pdfFile.name : 'upload.pdf');
      let pageMapping = null;

      // 如果有指定页码且不是"全部"，先切出一个小 PDF 再上传
      const slicedResult = await this._extractPdfPages(pdfFile, pages);
      if (slicedResult) {
        uploadFile = slicedResult.blob;
        uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + '_sliced.pdf';
        
        // 使用切页时计算出的真实有效页码作为映射
        pageMapping = slicedResult.validPageNums;

        console.log(`[MinerU] 已切页，原文件大小: ${(pdfFile.size / 1024 / 1024).toFixed(2)}MB → 切页后: ${(slicedResult.blob.size / 1024 / 1024).toFixed(2)}MB，页数: ${pageMapping.length}`);
      }

      // 切完页后，所有页码变成从1开始顺序排列，直接让后端全部处理，无需再传 pages
      const formData = new FormData();
      formData.append('pdf_file', uploadFile, uploadFileName);
      formData.append('template', JSON.stringify(template));
      formData.append('lang', 'ch');
      if (pageMapping) {
        formData.append('page_mapping', JSON.stringify(pageMapping));
      }

      onProgress && onProgress({ progress: 10, status: '正在上传 PDF 并提交 MinerU 识别任务...' });
      response = await fetch(`${MINERU_BASE}/pdf/recognize`, {
        method: 'POST',
        body: formData
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`MinerU 识别请求失败: ${response.status} ${errText}`);
    }

    // 后端现在立即返回 job_id，前端轮询 /pdf/job/<job_id> 获取实时进度
    const submitData = await response.json();
    if (!submitData.success) {
      throw new Error(`MinerU 提交失败: ${submitData.error || '未知错误'}`);
    }

    const jobId = submitData.job_id;
    window.currentMinerUJobId = jobId;
    console.log('[MinerU] 任务已提交，job_id:', jobId);
    onProgress && onProgress({ progress: 15, status: 'MinerU 任务已提交，等待识别...' });

    // ── 轮询进度 ──────────────────────────────────────────────────────────
    const POLL_INTERVAL = 800;
    const POLL_TIMEOUT  = 4 * 60 * 60 * 1000; // 增加到 4 小时
    const startTime = Date.now();
    let lastPollOkAt = Date.now();
    let result = null;

    while (true) {
      if (this.mineruStopRequested) {
        throw new Error('MinerU 识别已停止');
      }
      if (Date.now() - startTime > POLL_TIMEOUT) {
        throw new Error('MinerU 识别超时（超过4小时）');
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      let jobResp;
      try {
        jobResp = await fetch(`${MINERU_BASE}/pdf/job/${jobId}`);
      } catch (e) {
        console.warn('[MinerU] 轮询请求失败，重试:', e.message);
        if (Date.now() - lastPollOkAt > 2 * 60 * 1000) {
          throw new Error('MinerU 服务连接中断超过2分钟，当前批次将等待恢复后重试');
        }
        continue;
      }
      if (!jobResp.ok) {
        if (Date.now() - lastPollOkAt > 2 * 60 * 1000) {
          throw new Error(`MinerU 任务轮询持续失败: HTTP ${jobResp.status}`);
        }
        continue;
      }
      lastPollOkAt = Date.now();

      const jobData = await jobResp.json();

      if (onProgress) {
        const pct = jobData.progress || 0;
        const totalPages = jobData.total_pages || 0;
        const currentPage = jobData.current_page || 0;
        const stage = jobData.stage || '识别中...';
        const pageInfo = totalPages > 0 ? `（第 ${currentPage}/${totalPages} 页）` : '';
        onProgress({ progress: pct, status: `${stage}${pageInfo}`, currentPage, totalPages });
      }

      if (jobData.status === 'done') {
        result = jobData.result;
        window.currentMinerUJobId = null;
        console.log('[MinerU] 识别完成，结果预览:', JSON.stringify(result).slice(0, 500));
        break;
      }
      if (jobData.status === 'error') {
        window.currentMinerUJobId = null;
        throw new Error(`MinerU 识别失败: ${jobData.error || '未知错误'}`);
      }
    }

    if (!result || !result.success) {
      throw new Error(`MinerU 识别失败: ${result?.error || '未知错误'}`);
    }

    console.log('[MinerU] excel_task_id:', result.excel_task_id, '| logical_rows 行数:', (result.logical_rows || []).length);
    onProgress && onProgress({ progress: 92, status: 'MinerU 识别完成，正在生成 Excel...' });

    // The Excel export preserves QTY even when remote logical_rows drops it.
    let serverExcelDownloaded = false;
    const allowServerMinerUExcelDownload = true;
    let repairedLogicalRows = result.logical_rows || [];
    if (!_skipMinerUExcelRepair && allowServerMinerUExcelDownload && result.excel_task_id) {
      const excelUrl = `${MINERU_BASE}/task/${result.excel_task_id}/export_excel`;
      const pdfName = (typeof pdfFile === 'string'
        ? pdfFile.split(/[\\/]/).pop()
        : (pdfFileName || (pdfFile instanceof File ? pdfFile.name : 'mineru'))
      ).replace(/\.pdf$/i, '');

      try {
        const excelResp = await fetch(excelUrl);
        if (excelResp.ok) {
          const excelBuffer = await excelResp.arrayBuffer();
          const excelRows = parseMineruExcelLogicalRows(excelBuffer);
          if (excelRows.length > 0) {
            repairedLogicalRows = excelRows;
            console.log('[MinerU] QTY/material columns repaired from stable Excel rows:', excelRows.length);
          }
          if (!_suppressMinerUExcelDownload) {
            const blob = new Blob([excelBuffer], {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${pdfName}_MinerU.xlsx`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
            serverExcelDownloaded = true;
          onProgress && onProgress({ progress: 100, status: 'MinerU 识别完成，Excel 已下载' });
          console.log('[MinerU] 服务端 Excel 下载成功:', `${pdfName}_MinerU.xlsx`);
          }
        } else {
          const errText = await excelResp.text();
          console.warn('[MinerU] export_excel 请求失败，降级到前端导出:', excelResp.status, errText);
        }
      } catch (e) {
        console.warn('[MinerU] export_excel 下载异常，降级到前端导出:', e);
      }
    }

    onProgress && onProgress({ progress: 100, status: 'MinerU 识别完成' });

    return {
      success: true,
      logical_rows: repairedLogicalRows,
      totalRows: repairedLogicalRows.length,
      // 只有服务端真正下载成功，才告知上层跳过前端导出
      serverExcelDownloaded,
      excel_task_id: serverExcelDownloaded ? result.excel_task_id : null,
      fromMinerU: true,
      sourceLogicalRows: result.logical_rows || [],
      rawMineruResult: result,
    };
  }
}

// 导出单例实例
export const ocrService = new OCRService();
export default ocrService;
