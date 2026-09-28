import { buildOcrServerUrl } from '../config/ocrServer';
import { configAdapter } from '../adapters/configAdapter';
import {
  buildPdfDraftFileInfo,
  isSamePdfDraftFile,
  loadLatestAnnotationDraft,
  markLatestAnnotationDraftSaved,
  saveLatestAnnotationDraft
} from '../utils/annotationDraftStore';
import {
  loadCloudAnnotationDraft,
  saveCloudAnnotationDraft
} from '../utils/annotationCloudDraftStore';

const REQUEST_TIMEOUT_MS = 2500;

const arrayBufferToHex = (buffer) => {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const fallbackHashBytes = (bytes) => {
  let hashA = 0x811c9dc5;
  let hashB = 0x01000193;

  for (let i = 0; i < bytes.length; i += 1) {
    hashA ^= bytes[i];
    hashA = Math.imul(hashA, 0x01000193);
    hashB = (hashB + Math.imul(bytes[i] + i, 0x45d9f3b)) >>> 0;
  }

  return `${hashA >>> 0}${hashB >>> 0}${bytes.length}`.padStart(24, '0');
};

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
};

const hashText = async (text) => {
  const encoded = new TextEncoder().encode(text);
  if (!globalThis.crypto?.subtle) {
    return fallbackHashBytes(encoded);
  }

  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return arrayBufferToHex(digest);
};

class AutosaveService {
  constructor() {
    this.configPromise = null;
  }

  async getConfig() {
    if (!this.configPromise) {
      this.configPromise = Promise.resolve({
        enabled: true,
        intervalMs: 0,
        debounceMs: 800
      });
    }

    return this.configPromise;
  }

  async buildPdfIdentity(file, arrayBuffer) {
    const fileInfo = await buildPdfDraftFileInfo(file, arrayBuffer);
    const fileName = fileInfo?.name || file?.name || 'unknown.pdf';
    const fileSize = fileInfo?.size || file?.size || arrayBuffer?.byteLength || 0;
    const lastModified = fileInfo?.lastModified || file?.lastModified || null;
    const fingerprint = fileInfo?.fingerprint || await hashText(`${fileName}:${fileSize}:${lastModified || ''}`);

    return {
      fileName,
      fileSize,
      lastModified,
      fileHash: fingerprint,
      fingerprint,
      fileInfo: {
        ...fileInfo,
        name: fileName,
        size: fileSize,
        lastModified,
        fingerprint
      },
      draftKey: fingerprint
    };
  }

  async buildStateHash(state) {
    return hashText(stableStringify(state));
  }

  async health() {
    const config = await this.getConfig();
    if (!config.enabled) {
      return { ok: false, disabled: true };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let baseUrl = buildOcrServerUrl();
    try {
      const appConfig = await configAdapter.getConfig();
      baseUrl = buildOcrServerUrl(appConfig.ocr_server_host, appConfig.ocr_server_port);
    } catch (error) {
      console.warn('[autosave] 读取 OCR 配置失败，使用默认 OCR 地址:', error);
    }

    const response = await fetch(`${baseUrl}/health`, {
      cache: 'no-store',
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      throw new Error(`自动保存依赖的 OCR 服务不可用：${response.status}`);
    }

    return response.json();
  }

  normalizeDraft(draft) {
    if (!draft) {
      return null;
    }

    if (draft.state) {
      return {
        ...draft,
        savedAt: draft.savedAt || draft.serverSavedAt || draft.updatedAt
      };
    }

    const state = {
      version: draft.version || 1,
      pdf: {
        fileName: draft.fileName || draft.fileInfo?.name,
        totalPages: draft.totalPages
      },
      ui: {
        currentPage: draft.currentPage,
        totalPages: draft.totalPages,
        scale: draft.scale,
        viewMode: draft.viewMode
      },
      annotations: Array.isArray(draft.annotations) ? draft.annotations : [],
      annotationRules: Array.isArray(draft.annotationRules) ? draft.annotationRules : [],
      activeAnnotationRule: draft.activeAnnotationRule,
      pageRecognitionData: draft.pageRecognitionData || {},
      currentOcrResults: draft.currentOcrResults || null
    };

    return {
      ...draft,
      state,
      stateHash: draft.stateHash || '',
      savedAt: draft.savedAt || draft.serverSavedAt || draft.updatedAt
    };
  }

  getDraftTime(draft) {
    const value = draft?.serverSavedAt || draft?.savedAt || draft?.updatedAt;
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  async getLatestDraft(identity) {
    const config = await this.getConfig();
    if (!config.enabled || !identity?.draftKey) {
      return null;
    }

    let localDraft = null;
    try {
      const candidate = await loadLatestAnnotationDraft();
      if (candidate && isSamePdfDraftFile(candidate.fileInfo, identity.fileInfo)) {
        localDraft = candidate;
      }
    } catch (error) {
      console.warn('[autosave] 读取本地草稿失败:', error);
    }

    let cloudDraft = null;
    try {
      cloudDraft = await loadCloudAnnotationDraft(identity.fingerprint || identity.draftKey);
    } catch (error) {
      console.warn('[autosave] 读取云端草稿失败:', error);
    }

    const local = this.normalizeDraft(localDraft);
    const cloud = this.normalizeDraft(cloudDraft);

    if (local && cloud) {
      return this.getDraftTime(cloud) > this.getDraftTime(local) ? cloud : local;
    }
    return local || cloud || null;
  }

  async saveDraft(identity, state, options = {}) {
    const config = await this.getConfig();
    if (!config.enabled || !identity?.draftKey) {
      return { skipped: true };
    }

    const draft = {
      version: 1,
      fileInfo: identity.fileInfo,
      fileName: identity.fileName,
      annotations: Array.isArray(state.annotations) ? state.annotations : [],
      annotationRules: Array.isArray(state.annotationRules) ? state.annotationRules : [],
      activeAnnotationRule: state.activeAnnotationRule,
      currentPage: state.ui?.currentPage,
      scale: state.ui?.scale,
      totalPages: state.ui?.totalPages || state.pdf?.totalPages,
      viewMode: state.ui?.viewMode,
      pageRecognitionData: state.pageRecognitionData || {},
      currentOcrResults: state.currentOcrResults || null,
      state,
      stateHash: options.stateHash || null,
      updatedAt: new Date().toISOString()
    };

    await saveLatestAnnotationDraft(draft);

    try {
      return await saveCloudAnnotationDraft(draft);
    } catch (error) {
      console.warn('[autosave] 云端草稿保存失败，本地草稿已保存:', error);
      return { success: true, localOnly: true, cloudError: error.message };
    }
  }

  async markDraftSaved() {
    return markLatestAnnotationDraftSaved();
  }
}

export const autosaveService = new AutosaveService();
export default autosaveService;
