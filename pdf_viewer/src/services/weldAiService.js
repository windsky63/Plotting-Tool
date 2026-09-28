import { buildConfirmedWeldLabels } from '../utils/weldAiFusion';
import JSZip from 'jszip';

const DEFAULT_REMOTE_WELD_AI_URL = 'http://192.168.32.61:8767';
const REQUEST_TIMEOUT_MS = 45000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const QUEUE_DB_NAME = 'pdf_viewer_weld_ai_queue';
const QUEUE_STORE_NAME = 'confirmed_samples';
const LEADER_TARGET_TYPE = 'leader_pipe_end';
const LEADER_CONFIRM_PATH = '/api/weld-ai/training-samples/confirm-leader-end';

export const confirmPipelineLabels = labels => (Array.isArray(labels) ? labels : []).map(label => (
  label?.pipelineNumber && label?.pipelineNumberSource === 'inferred'
    ? { ...label, pipelineNumberSource: 'ocr_confirmed' }
    : label
));

const getLabelCompletenessCounts = labels => {
  const source = Array.isArray(labels) ? labels : [];
  return {
    labelCount: source.length,
    numberedLabelCount: source.filter(label => label?.weldNumber).length,
    jointTypeLabelCount: source.filter(label => label?.jointType).length,
    pipelineLabelCount: source.filter(label => label?.pipelineNumber).length,
    completeLabelCount: source.filter(label => label?.weldNumber && label?.jointType).length,
    fullyQualifiedLabelCount: source.filter(label => (
      label?.pipelineNumber && label?.weldNumber && label?.jointType
    )).length
  };
};

const getRemoteCountMismatch = (remote, expected) => {
  const keys = ['labelCount', 'numberedLabelCount', 'jointTypeLabelCount', 'completeLabelCount'];
  const mismatches = keys.filter(key => (
    remote?.[key] === null ||
    remote?.[key] === undefined ||
    !Number.isInteger(Number(remote[key])) ||
    Number(remote[key]) !== Number(expected[key])
  ));
  if (!mismatches.length) return '';
  return mismatches.map(key => (
    `${key}提交${expected[key]}、远端${remote?.[key] ?? '缺失'}`
  )).join('；');
};

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const createRequestId = () => (
  globalThis.crypto?.randomUUID?.() ||
  `weld-ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('焊点AI页面图像读取失败'));
  reader.readAsDataURL(blob);
});

const canvasToBlob = (canvas, mimeType = 'image/png', quality) => new Promise((resolve, reject) => {
  canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('焊点AI页面图像生成失败')),
    mimeType,
    quality
  );
});

const loadDataUrlImage = dataUrl => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('训练样本审计图读取失败'));
  image.src = dataUrl;
});

const normalizePagePoint = (point, rendered) => ({
  xNorm: clamp01(Number(point?.x) / rendered.pageWidth),
  yNorm: clamp01(Number(point?.y) / rendered.pageHeight)
});

const normalizeLeaderLabel = (label, rendered) => ({
  ...label,
  center: normalizePagePoint(label.center, rendered),
  leaderPipeEnd: normalizePagePoint(label.leaderPipeEnd, rendered),
  leaderCircleEnd: normalizePagePoint(label.leaderCircleEnd, rendered),
  leaderPoints: (label.leaderPoints || []).map(point => normalizePagePoint(point, rendered))
});

const isLeaderEndPayload = payload => (
  payload?.targetType === LEADER_TARGET_TYPE &&
  Array.isArray(payload?.labels) &&
  payload.labels.length > 0 &&
  payload.labels.every(label => (
    Number.isFinite(Number(label?.leaderPipeEnd?.xNorm)) &&
    Number.isFinite(Number(label?.leaderPipeEnd?.yNorm)) &&
    (
      label?.weldNumber === undefined || (
        typeof label.weldNumber === 'string' &&
        label.weldNumber.trim().length > 0 &&
        label.weldNumber.length <= 120
      )
    ) &&
    (
      label?.jointType === undefined || (
        typeof label.jointType === 'string' &&
        label.jointType.trim().length > 0 &&
        label.jointType.length <= 120
      )
    ) && (
      label?.pipelineNumber === undefined || (
        typeof label.pipelineNumber === 'string' &&
        label.pipelineNumber.trim().length > 0 &&
        label.pipelineNumber.length <= 240
      )
    ) && (
      label?.pipelineNumberRaw === undefined || typeof label.pipelineNumberRaw === 'string'
    ) && (
      label?.pipelineNumberSource === undefined ||
      ['business_data', 'user_confirmed', 'ocr_confirmed', 'inferred']
        .includes(label.pipelineNumberSource)
    )
  ))
);

const buildPdfIdentity = file => ({
  name: file?.name || String(file || '').split(/[\\/]/).pop() || 'unknown.pdf',
  size: Number(file?.size || 0),
  lastModified: Number(file?.lastModified || 0)
});

const openQueueDb = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('IndexedDB不可用'));
    return;
  }
  const request = indexedDB.open(QUEUE_DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
      db.createObjectStore(QUEUE_STORE_NAME, { keyPath: 'id' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('训练样本队列打开失败'));
});

const withQueueStore = async (mode, callback) => {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE_NAME, mode);
    const store = tx.objectStore(QUEUE_STORE_NAME);
    let request;
    try {
      request = callback(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || request?.error || new Error('训练样本队列操作失败'));
    tx.onabort = () => reject(tx.error || new Error('训练样本队列操作中止'));
  });
};

class WeldAiService {
  constructor() {
    this.baseUrl = DEFAULT_REMOTE_WELD_AI_URL;
    this.useSameOriginProxy = true;
    this.apiKey = '';
    this.initialized = false;
    this.healthCache = null;
    this.healthCheckedAt = 0;
    this.sampleUploadTail = Promise.resolve();
    this.queueRecoveryStarted = false;
    this.queueRecoveryPromise = null;
  }

  async initialize() {
    if (this.initialized) return this.baseUrl;
    try {
      const response = await fetch(`${process.env.PUBLIC_URL || ''}/app-config.json`, { cache: 'no-store' });
      if (response.ok) {
        const config = await response.json();
        this.baseUrl = String(config.weld_ai_server_url || DEFAULT_REMOTE_WELD_AI_URL).replace(/\/$/, '');
        this.apiKey = String(config.weld_ai_api_key || '').trim();
        this.useSameOriginProxy = config.weld_ai_use_same_origin_proxy !== false;
      }
    } catch (error) {
      console.warn('焊点AI配置读取失败，使用默认远端地址', error?.message || error);
    }
    this.initialized = true;
    return this.baseUrl;
  }

  async request(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.initialize();
    const { returnResponse = false, requestId = '', ...fetchOptions } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestBaseUrl = this.useSameOriginProxy ? '' : this.baseUrl;
      const response = await fetch(`${requestBaseUrl}${path}`, {
        ...fetchOptions,
        signal: fetchOptions.signal || controller.signal,
        headers: {
          ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
          // 浏览器直连远端 AI 服务时使用统一的内网访问密钥。密钥只来自
          // 唯一生产部署目录的 app-config.json，不能写入业务数据或日志。
          ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
          ...(requestId ? { 'X-Request-ID': requestId } : {}),
          ...(fetchOptions.headers || {})
        }
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
      if (!response.ok) {
        const error = new Error(data.error || data.message || `远端焊点AI HTTP ${response.status}`);
        error.status = response.status;
        error.details = data;
        throw error;
      }
      return returnResponse ? { status: response.status, data } : data;
    } finally {
      clearTimeout(timer);
    }
  }

  async getHealth({ force = false } = {}) {
    if (!force && this.healthCache && Date.now() - this.healthCheckedAt < 30000) {
      return this.healthCache;
    }
    try {
      const data = await this.request('/api/weld-ai/health', { method: 'GET' }, 5000);
      this.healthCache = {
        // 服务可连通和模型可推理是两回事：没有权重时仍应允许上传
        // 已人工确认的训练样本。
        reachable: true,
        available: data.available === true || data.status === 'ready',
        modelLoaded: data.modelLoaded === true,
        modelVersion: String(data.modelVersion || ''),
        message: String(data.message || '')
      };
    } catch (error) {
      this.healthCache = {
        reachable: false,
        available: false,
        modelLoaded: false,
        modelVersion: '',
        message: error?.name === 'AbortError' ? '远端焊点AI连接超时' : (error?.message || '远端焊点AI不可用')
      };
    }
    this.healthCheckedAt = Date.now();
    return this.healthCache;
  }

  async renderPageRegion(pdfDocument, pageNum, area = null, targetLongSide = 3200) {
    const page = await pdfDocument.getPage(pageNum);
    const unitViewport = page.getViewport({ scale: 1 });
    const region = area ? {
      x: clamp01(area.x),
      y: clamp01(area.y),
      width: Math.max(0.001, clamp01(area.width)),
      height: Math.max(0.001, clamp01(area.height))
    } : { x: 0, y: 0, width: 1, height: 1 };
    region.width = Math.min(region.width, 1 - region.x);
    region.height = Math.min(region.height, 1 - region.y);
    const regionLongSide = Math.max(unitViewport.width * region.width, unitViewport.height * region.height);
    const renderScale = Math.max(2, Math.min(4, targetLongSide / Math.max(1, regionLongSide)));
    const viewport = page.getViewport({ scale: renderScale });
    const cropX = Math.round(region.x * viewport.width);
    const cropY = Math.round(region.y * viewport.height);
    const cropWidth = Math.max(1, Math.round(region.width * viewport.width));
    const cropHeight = Math.max(1, Math.round(region.height * viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, cropWidth, cropHeight);
    await page.render({
      canvasContext: context,
      viewport,
      transform: [1, 0, 0, 1, -cropX, -cropY]
    }).promise;
    const blob = await canvasToBlob(canvas);
    canvas.width = 0;
    canvas.height = 0;
    return {
      imageDataUrl: await blobToDataUrl(blob),
      imageWidth: cropWidth,
      imageHeight: cropHeight,
      pageWidth: unitViewport.width,
      pageHeight: unitViewport.height,
      area: region,
      renderScale
    };
  }

  normalizeDetections(rawDetections, pageNum, rendered, modelVersion = '') {
    return (rawDetections || []).map((item, index) => {
      const center = item.center || item;
      let xNorm = Number(center.xNorm ?? center.x_norm ?? item.xNorm ?? item.x_norm);
      let yNorm = Number(center.yNorm ?? center.y_norm ?? item.yNorm ?? item.y_norm);
      if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm)) {
        const pixelX = Number(center.x ?? item.x);
        const pixelY = Number(center.y ?? item.y);
        xNorm = rendered.area.x + (pixelX / rendered.imageWidth) * rendered.area.width;
        yNorm = rendered.area.y + (pixelY / rendered.imageHeight) * rendered.area.height;
      }
      return {
        ...item,
        id: item.id || `remote-ai-${pageNum}-${index}`,
        pageNum,
        center: {
          x: clamp01(xNorm) * rendered.pageWidth,
          y: clamp01(yNorm) * rendered.pageHeight
        },
        confidence: Number(item.confidence || item.score || 0),
        modelVersion: String(item.modelVersion || modelVersion || '')
      };
    });
  }

  async waitForJob(jobId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
      const job = await this.request(`/api/weld-ai/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
      if (job.status === 'done') return job;
      if (job.status === 'error' || job.status === 'cancelled') {
        throw new Error(job.error || `远端焊点AI任务${job.status}`);
      }
      await sleep(600);
    }
    throw new Error('远端焊点AI任务超时');
  }

  async detectPage({ pdfDocument, pageNum, area, pdfIdentity, projectName = '' }) {
    const rendered = await this.renderPageRegion(pdfDocument, pageNum, area);
    const payload = {
      project: String(projectName || 'unclassified'),
      document: pdfIdentity,
      page: pageNum,
      pageSize: { width: rendered.pageWidth, height: rendered.pageHeight },
      recognitionArea: rendered.area,
      image: {
        mimeType: 'image/png',
        dataUrl: rendered.imageDataUrl,
        width: rendered.imageWidth,
        height: rendered.imageHeight,
        renderScale: rendered.renderScale
      }
    };
    let result = await this.request('/api/weld-ai/jobs', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (result.jobId && result.status !== 'done') result = await this.waitForJob(result.jobId);
    return {
      pageNum,
      detections: this.normalizeDetections(
        result.detections || result.result?.detections || [],
        pageNum,
        rendered,
        result.modelVersion || result.result?.modelVersion
      ),
      modelVersion: String(result.modelVersion || result.result?.modelVersion || '')
    };
  }

  async detectPages({ pdfDocument, startPage, endPage, area, pdfFile, projectName = '', onProgress }) {
    const health = await this.getHealth({ force: true });
    if (!health.available || !health.modelLoaded) {
      return { available: false, health, pages: {} };
    }
    const pages = {};
    const pdfIdentity = buildPdfIdentity(pdfFile);
    const total = Math.max(0, Number(endPage) - Number(startPage) + 1);
    for (let page = Number(startPage); page <= Number(endPage); page += 1) {
      onProgress?.(page - Number(startPage) + 1, total, `远端AI识别第${page}页焊点`);
      const result = await this.detectPage({ pdfDocument, pageNum: page, area, pdfIdentity, projectName });
      pages[page] = result.detections;
      await sleep(0);
    }
    return { available: true, health, pages, modelVersion: health.modelVersion };
  }

  async getQueuedSample(id) {
    try {
      return await withQueueStore('readonly', store => store.get(id)) || null;
    } catch (_) {
      return null;
    }
  }

  async queueConfirmedSample(payload, updates = {}) {
    const existing = await this.getQueuedSample(payload.sampleId);
    const item = {
      ...(existing || {}),
      id: payload.sampleId,
      payload,
      state: updates.state || existing?.state || 'pending_local',
      queuedAt: existing?.queuedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: Number(existing?.attempts || 0),
      ...updates
    };
    await withQueueStore('readwrite', store => store.put(item));
    return item;
  }

  async updateQueuedSample(id, updates = {}) {
    const existing = await this.getQueuedSample(id);
    if (!existing) return null;
    const item = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString()
    };
    await withQueueStore('readwrite', store => store.put(item));
    return item;
  }

  async removeQueuedSample(id) {
    await withQueueStore('readwrite', store => store.delete(id));
  }

  async getQueuedSamples() {
    try {
      return await withQueueStore('readonly', store => store.getAll()) || [];
    } catch (_) {
      return [];
    }
  }

  async purgeLegacyQueuedSamples() {
    const queued = await this.getQueuedSamples();
    const legacy = queued.filter(item => {
      const state = String(item?.state || 'pending_local');
      // An accepted request already has a remote receipt and must only be
      // polled; removing it could orphan a server-side save operation.
      if (state === 'accepted' || state === 'stored') return false;
      return !isLeaderEndPayload(item?.payload) ||
        Number(item?.payload?.pipelineNumberSchemaVersion || 0) < 1;
    });
    for (const item of legacy) await this.removeQueuedSample(item.id);
    if (legacy.length) {
      console.warn(`[WeldAI] 已清除 ${legacy.length} 份无法补齐管线号字段的旧待传样本`);
    }
    return legacy.length;
  }

  async waitUntilSampleStored(sampleId, receiptId, { onStatus } = {}) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      let status;
      try {
        status = await this.request(
          `/api/weld-ai/training-samples/status/${encodeURIComponent(receiptId)}`,
          { method: 'GET' }
        );
      } catch (error) {
        if (error.status === 404) {
          await this.updateQueuedSample(sampleId, {
            state: 'pending_local',
            receiptId: '',
            lastError: '远端回执已失效，等待重新上传'
          });
          error.receiptExpired = true;
        } else {
          // The POST was already accepted. A temporary status-query failure
          // must retain the receipt instead of causing a duplicate upload.
          error.preserveAccepted = true;
        }
        throw error;
      }

      const state = String(status?.status || '').toLowerCase();
      onStatus?.(state, status);
      if (state === 'stored') {
        const queuedSample = await this.getQueuedSample(sampleId);
        const expectedCounts = getLabelCompletenessCounts(queuedSample?.payload?.labels);
        const mismatch = getRemoteCountMismatch(status, expectedCounts);
        if (mismatch) {
          await this.updateQueuedSample(sampleId, {
            state: 'failed',
            lastError: `远端最终样本统计不一致：${mismatch}`
          });
          const error = new Error(`远端最终样本统计不一致：${mismatch}`);
          error.remoteSampleFailed = true;
          throw error;
        }
        await this.updateQueuedSample(sampleId, {
          state: 'stored',
          storedAt: new Date().toISOString(),
          lastError: '',
          // The remote copy is durable; release the large Base64 image while
          // retaining the receipt/state record for refresh-safe bookkeeping.
          payload: null
        });
        return status;
      }
      if (state === 'error') {
        const reason = status?.error?.message || status?.error || '远端保存训练样本失败';
        await this.updateQueuedSample(sampleId, { state: 'failed', lastError: String(reason) });
        const error = new Error(String(reason));
        error.remoteSampleFailed = true;
        throw error;
      }
      if (state === 'queued' || state === 'saving') {
        await this.updateQueuedSample(sampleId, { state: 'accepted', remoteState: state });
      }
      await sleep(2000);
    }

    const error = new Error('远端仍在保存样本，可稍后继续查询');
    error.preserveAccepted = true;
    throw error;
  }

  async performConfirmedSampleUpload(payload, { onStatus } = {}) {
    if (!isLeaderEndPayload(payload)) {
      const error = new Error('训练样本缺少有效的引线管道端点，需要重新提取');
      error.code = 'LEADER_PIPE_END_REQUIRED';
      error.sampleState = 'failed';
      throw error;
    }
    await this.queueConfirmedSample(payload, { state: 'pending_local' });
    await this.updateQueuedSample(payload.sampleId, {
      state: 'uploading',
      attempts: Number((await this.getQueuedSample(payload.sampleId))?.attempts || 0) + 1,
      lastError: ''
    });
    const requestId = createRequestId();
    try {
      console.info('[WeldAI] 正在向远端提交训练样本', {
        sampleId: payload.sampleId,
        page: payload.page,
        labelCount: Array.isArray(payload.labels) ? payload.labels.length : 0,
        endpoint: this.useSameOriginProxy
          ? LEADER_CONFIRM_PATH
          : `${this.baseUrl}${LEADER_CONFIRM_PATH}`
      });
      onStatus?.('uploading');
      const response = await this.request(LEADER_CONFIRM_PATH, {
        method: 'POST',
        body: JSON.stringify(payload),
        requestId,
        returnResponse: true
      }, 10 * 60 * 1000);
      const receipt = response.data || {};
      if (response.status !== 202 || !receipt.receiptId) {
        throw new Error('远端未返回有效的训练样本回执');
      }
      const expectedCounts = getLabelCompletenessCounts(payload.labels);
      await this.updateQueuedSample(payload.sampleId, {
        state: 'accepted',
        receiptId: receipt.receiptId,
        requestId,
        acceptedAt: new Date().toISOString(),
        remoteState: receipt.status || 'queued'
      });
      const receiptMismatch = getRemoteCountMismatch(receipt, expectedCounts);
      if (receiptMismatch) {
        const error = new Error(`远端样本完整度回执不一致：${receiptMismatch}`);
        // The POST already has a receipt. Preserve it for status recovery and
        // never retry the same accepted payload blindly.
        error.preserveAccepted = true;
        throw error;
      }
      console.info('[WeldAI] 远端已接收训练样本，等待保存', {
        sampleId: payload.sampleId,
        page: payload.page,
        receiptId: receipt.receiptId,
        ...expectedCounts
      });
      onStatus?.('accepted', receipt);
      const stored = await this.waitUntilSampleStored(payload.sampleId, receipt.receiptId, { onStatus });
      return { uploaded: true, stored: true, queued: false, receipt, result: stored };
    } catch (caughtError) {
      let error = caughtError;
      if (Number(error?.status) === 410) {
        const legacyError = new Error('旧训练样本缺少引线端点，需要重新提取或清除');
        legacyError.status = 410;
        legacyError.code = 'LEADER_PIPE_END_REQUIRED';
        legacyError.legacySampleRejected = true;
        error = legacyError;
        await this.updateQueuedSample(payload.sampleId, {
          state: 'failed',
          payload: null,
          lastError: legacyError.message
        });
      }
      const reason = error?.message || '远端请求失败';
      console.warn('[WeldAI] 远端未接收训练样本', {
        sampleId: payload.sampleId,
        page: payload.page,
        reason
      });
      if (!error.preserveAccepted && !error.remoteSampleFailed && !error.receiptExpired && !error.legacySampleRejected) {
        await this.updateQueuedSample(payload.sampleId, {
          state: Number.isFinite(Number(error.status)) ? 'failed' : 'pending_local',
          lastError: reason
        });
      }
      const terminalFailure = error.remoteSampleFailed || error.legacySampleRejected || Number.isFinite(Number(error.status));
      error.sampleState = error.preserveAccepted ? 'accepted' : terminalFailure ? 'failed' : 'pending_local';
      error.sampleId = payload.sampleId;
      throw error;
    }
  }

  async uploadConfirmedSample(payload, options = {}) {
    const execute = () => this.performConfirmedSampleUpload(payload, options);
    const task = this.sampleUploadTail.then(execute, execute);
    this.sampleUploadTail = task.catch(() => {});
    return task;
  }

  async flushQueuedSamples() {
    await this.purgeLegacyQueuedSamples();
    const health = await this.getHealth({ force: true });
    if (!health.reachable) return { uploaded: 0, remaining: (await this.getQueuedSamples()).length };
    const queued = await this.getQueuedSamples();
    let uploaded = 0;
    for (const item of queued) {
      const state = item.state || 'pending_local';
      if (state === 'stored' || state === 'failed') continue;
      try {
        if (state === 'accepted' && item.receiptId) {
          await this.waitUntilSampleStored(item.id, item.receiptId);
        } else {
          if (state === 'uploading') {
            await this.updateQueuedSample(item.id, { state: 'pending_local' });
          }
          await this.uploadConfirmedSample(item.payload);
        }
        uploaded += 1;
      } catch (_) {
        // State and receipt are retained for the next recovery attempt.
      }
    }
    const remaining = (await this.getQueuedSamples()).filter(item => item.state !== 'stored').length;
    return { uploaded, remaining };
  }

  startQueueRecovery() {
    if (this.queueRecoveryStarted || typeof window === 'undefined') return;
    this.queueRecoveryStarted = true;
    const recover = () => {
      if (this.queueRecoveryPromise) return this.queueRecoveryPromise;
      this.queueRecoveryPromise = this.flushQueuedSamples()
        .catch(error => {
          console.warn('[WeldAI] 训练样本待传队列恢复失败', error?.message || error);
        })
        .finally(() => {
          this.queueRecoveryPromise = null;
        });
      return this.queueRecoveryPromise;
    };
    window.addEventListener('online', recover);
    setTimeout(recover, 1500);
  }

  async submitConfirmedAnnotations({ pdfDocument, pdfFile, annotations, pipelineNumberByPage = {}, projectName = '', onProgress }) {
    // This method is called only after the operator accepts the confirmation
    // dialog. OCR candidates can therefore become confirmed OCR values here;
    // merely exporting a ZIP keeps them marked as inferred.
    const labels = confirmPipelineLabels(buildConfirmedWeldLabels(annotations, { pipelineNumberByPage }));
    if (!labels.length) throw new Error('没有可提交的普通焊口标注');
    const labelsByPage = labels.reduce((result, label) => {
      if (!result[label.page]) result[label.page] = [];
      result[label.page].push(label);
      return result;
    }, {});
    const pageNums = Object.keys(labelsByPage).map(Number).sort((a, b) => a - b);
    const documentInfo = buildPdfIdentity(pdfFile);
    const submittedAt = new Date().toISOString();
    // Do this before rendering any PDF page. Rendering a full-resolution
    // training image is expensive, and an unreachable remote must fail fast
    // instead of making the user wait for the entire progress bar.
    onProgress?.(0, pageNums.length, '正在确认远端训练样本服务可达');
    const health = await this.getHealth({ force: true });
    if (!health.reachable) {
      const error = new Error(`远端训练样本服务不可达：${health.message || '连接失败'}`);
      error.code = 'WELD_AI_REMOTE_UNREACHABLE';
      throw error;
    }
    onProgress?.(0, pageNums.length, '远端训练样本服务已连接，开始准备样本');
    let uploaded = 0;
    let queued = 0;
    const queueReasons = [];
    for (let index = 0; index < pageNums.length; index += 1) {
      const pageNum = pageNums[index];
      onProgress?.(index + 1, pageNums.length, `准备第${pageNum}页训练样本`);
      const rendered = await this.renderPageRegion(pdfDocument, pageNum, null, 3200);
      const normalizedLabels = labelsByPage[pageNum].map(label => normalizeLeaderLabel(label, rendered));
      const sampleId = [
        documentInfo.name,
        documentInfo.size,
        documentInfo.lastModified,
        pageNum,
        LEADER_TARGET_TYPE
      ].join(':');
      const payload = {
        sampleId,
        targetType: LEADER_TARGET_TYPE,
        pipelineNumberSchemaVersion: 1,
        project: String(projectName || 'unclassified'),
        confirmedAt: submittedAt,
        document: documentInfo,
        page: pageNum,
        pageSize: { width: rendered.pageWidth, height: rendered.pageHeight },
        recognitionArea: {},
        image: {
          mimeType: 'image/png',
          dataUrl: rendered.imageDataUrl,
          width: rendered.imageWidth,
          height: rendered.imageHeight,
          renderScale: rendered.renderScale
        },
        labels: normalizedLabels
      };
      const result = await this.uploadConfirmedSample(payload, {
        onStatus: state => {
          const statusText = state === 'uploading'
            ? `正在上传第${pageNum}页训练样本，请勿关闭页面`
            : state === 'accepted'
              ? `远端已接收第${pageNum}页，正在保存`
              : state === 'saving'
                ? `远端正在保存第${pageNum}页训练样本`
                : state === 'queued'
                  ? `第${pageNum}页已进入远端保存队列`
                  : `第${pageNum}页训练样本已保存`;
          onProgress?.(index + 1, pageNums.length, statusText);
        }
      });
      if (result.uploaded) uploaded += 1;
      if (result.queued) {
        queued += 1;
        if (result.reason || result.error?.message) {
          queueReasons.push({ page: pageNum, reason: result.reason || result.error.message });
        }
      }
      await sleep(0);
    }
    const completeness = getLabelCompletenessCounts(labels);
    return {
      pages: pageNums.length,
      labels: labels.length,
      numberedLabels: completeness.numberedLabelCount,
      jointTypeLabels: completeness.jointTypeLabelCount,
      pipelineLabels: completeness.pipelineLabelCount,
      completeLabels: completeness.completeLabelCount,
      fullyQualifiedLabels: completeness.fullyQualifiedLabelCount,
      uploaded,
      queued,
      queueReasons
    };
  }

  async exportConfirmedAnnotations({ pdfDocument, pdfFile, annotations, pipelineNumberByPage = {}, projectName = '', onProgress }) {
    const labels = buildConfirmedWeldLabels(annotations, { pipelineNumberByPage });
    if (!labels.length) throw new Error('没有可导出的普通焊口训练标签');
    const labelsByPage = labels.reduce((result, label) => {
      if (!result[label.page]) result[label.page] = [];
      result[label.page].push(label);
      return result;
    }, {});
    const pageNums = Object.keys(labelsByPage).map(Number).sort((a, b) => a - b);
    const documentInfo = buildPdfIdentity(pdfFile);
    const zip = new JSZip();
    const imageFolder = zip.folder('images');
    const labelFolder = zip.folder('labels');
    const auditFolder = zip.folder('audit');
    const manifest = {
      schemaVersion: 3,
      task: 'weld-leader-pipe-end-detection',
      targetType: LEADER_TARGET_TYPE,
      project: String(projectName || 'unclassified'),
      exportedAt: new Date().toISOString(),
      document: documentInfo,
      pages: []
    };

    for (let index = 0; index < pageNums.length; index += 1) {
      const pageNum = pageNums[index];
      onProgress?.(index + 1, pageNums.length, `正在整理第${pageNum}页训练数据`);
      const rendered = await this.renderPageRegion(pdfDocument, pageNum, null, 3200);
      const normalizedLabels = labelsByPage[pageNum].map(label => normalizeLeaderLabel(label, rendered));
      const pageStem = `page_${String(pageNum).padStart(4, '0')}`;
      const imageName = `${pageStem}.png`;
      const labelName = `${pageStem}.json`;
      const base64 = String(rendered.imageDataUrl || '').split(',')[1] || '';
      if (!base64) throw new Error(`第${pageNum}页训练图像生成失败`);
      imageFolder.file(imageName, base64, { base64: true });
      labelFolder.file(labelName, JSON.stringify({
        targetType: LEADER_TARGET_TYPE,
        pipelineNumberSchemaVersion: 1,
        page: pageNum,
        pageSize: { width: rendered.pageWidth, height: rendered.pageHeight },
        recognitionArea: {},
        image: {
          file: `images/${imageName}`,
          width: rendered.imageWidth,
          height: rendered.imageHeight,
          renderScale: rendered.renderScale
        },
        labels: normalizedLabels
      }, null, 2));
      let auditName = '';
      if (index < 20) {
        const auditDataUrl = await this.renderLeaderEndpointAudit(rendered, normalizedLabels);
        const auditBase64 = String(auditDataUrl || '').split(',')[1] || '';
        auditName = `${pageStem}-leader-end-audit.jpg`;
        if (auditBase64) auditFolder.file(auditName, auditBase64, { base64: true });
      }
      manifest.pages.push({
        page: pageNum,
        image: `images/${imageName}`,
        labels: `labels/${labelName}`,
        audit: auditName ? `audit/${auditName}` : '',
        weldCount: normalizedLabels.length,
        ...getLabelCompletenessCounts(normalizedLabels)
      });
      await sleep(0);
    }

    manifest.pageCount = manifest.pages.length;
    manifest.labelCount = labels.length;
    const completeness = getLabelCompletenessCounts(labels);
    manifest.numberedLabelCount = completeness.numberedLabelCount;
    manifest.jointTypeLabelCount = completeness.jointTypeLabelCount;
    manifest.pipelineLabelCount = completeness.pipelineLabelCount;
    manifest.completeLabelCount = completeness.completeLabelCount;
    manifest.fullyQualifiedLabelCount = completeness.fullyQualifiedLabelCount;
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('README.txt', [
      '焊点AI引线管道端点训练样本包',
      'images/：原始PDF页面渲染图。',
      'labels/：center仅供审计；模型训练目标为leaderPipeEnd，坐标按完整PDF页面归一化。',
      'weldNumber：图纸中显示的完整焊口编号原文；没有可靠编号时省略。',
      'jointType：与该焊点绑定的接头形式原文或人工确认值；没有可靠结果时省略。',
      'pipelineNumber：逐焊点保存的规范化管线号；pipelineNumberRaw保留图面原文，pipelineNumberSource记录来源。',
      'audit/：最多20页人工抽查图；蓝圈为标注圈中心，黄线为完整引线，红点为leaderPipeEnd。',
      'manifest.json：文档、页码及样本数量索引。',
      '该样本用于远端模型训练，本机不执行训练或推理。'
    ].join('\r\n'));
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    }, metadata => {
      onProgress?.(
        pageNums.length,
        pageNums.length,
        `正在压缩训练包 ${Math.round(metadata.percent || 0)}%`
      );
    });
    return {
      blob,
      pages: pageNums.length,
      labels: labels.length,
      numberedLabels: completeness.numberedLabelCount,
      jointTypeLabels: completeness.jointTypeLabelCount,
      pipelineLabels: completeness.pipelineLabelCount,
      completeLabels: completeness.completeLabelCount,
      fullyQualifiedLabels: completeness.fullyQualifiedLabelCount,
      auditPages: Math.min(20, pageNums.length)
    };
  }

  async renderLeaderEndpointAudit(rendered, labels) {
    const source = await loadDataUrlImage(rendered.imageDataUrl);
    const maxLongSide = 1800;
    const scale = Math.min(1, maxLongSide / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const point = value => ({
      x: clamp01(value?.xNorm) * canvas.width,
      y: clamp01(value?.yNorm) * canvas.height
    });
    labels.forEach((label, index) => {
      const circle = point(label.center);
      const pipeEnd = point(label.leaderPipeEnd);
      const leaderPoints = (label.leaderPoints || []).map(point);
      const path = leaderPoints.length >= 2 ? leaderPoints : [circle, pipeEnd];
      context.save();
      context.lineWidth = Math.max(2, canvas.width / 900);
      context.strokeStyle = '#ffd400';
      context.beginPath();
      context.moveTo(path[0].x, path[0].y);
      path.slice(1).forEach(item => context.lineTo(item.x, item.y));
      context.stroke();
      context.strokeStyle = '#1677ff';
      context.beginPath();
      context.arc(circle.x, circle.y, Math.max(7, canvas.width / 220), 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = '#ff0000';
      context.beginPath();
      context.arc(pipeEnd.x, pipeEnd.y, Math.max(5, canvas.width / 300), 0, Math.PI * 2);
      context.fill();
      context.font = `${Math.max(12, Math.round(canvas.width / 110))}px sans-serif`;
      context.fillText(
        `${index + 1}${label.weldNumber ? `:${label.weldNumber}` : ''}${label.jointType ? `/${label.jointType}` : ''}`,
        pipeEnd.x + 7,
        pipeEnd.y - 7
      );
      context.restore();
    });
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.86);
    canvas.width = 0;
    canvas.height = 0;
    return blobToDataUrl(blob);
  }
}

const weldAiService = new WeldAiService();
export { DEFAULT_REMOTE_WELD_AI_URL, LEADER_CONFIRM_PATH, LEADER_TARGET_TYPE, WeldAiService };
export default weldAiService;
