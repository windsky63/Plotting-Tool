const DB_NAME = 'pdf_viewer_annotation_drafts';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';
const LATEST_DRAFT_KEY = 'latest';
const PAGE_KEY_PREFIX = `${LATEST_DRAFT_KEY}:page:`;
const SHARDED_STORAGE_MODE = 'page-shards-v1';
const DRAFT_VERSION = 1;
const FINGERPRINT_SAMPLE_SIZE = 64 * 1024;
const EMERGENCY_DRAFT_STORAGE_KEY = 'luotu:latest-annotation-draft-emergency';

let dbPromise = null;

const getDraftTimestamp = draft => {
  const value = draft?.updatedAt || draft?.savedAt || '';
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export const saveEmergencyAnnotationDraft = draft => {
  const normalizedDraft = {
    ...draft,
    id: LATEST_DRAFT_KEY,
    version: DRAFT_VERSION,
    dirty: true,
    savedAt: new Date().toISOString()
  };
  try {
    window.localStorage?.setItem(EMERGENCY_DRAFT_STORAGE_KEY, JSON.stringify(normalizedDraft));
    return true;
  } catch (error) {
    // IndexedDB remains the primary store. This synchronous copy protects the
    // close/crash window, but must never interrupt annotation work.
    console.warn('保存应急标注草稿失败:', error);
    return false;
  }
};

const loadEmergencyDraft = () => {
  try {
    const raw = window.localStorage?.getItem(EMERGENCY_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    return draft?.dirty && Array.isArray(draft.annotations) && draft.annotations.length > 0
      ? draft
      : null;
  } catch (error) {
    console.warn('读取应急标注草稿失败:', error);
    return null;
  }
};

const clearEmergencyDraft = () => {
  try {
    window.localStorage?.removeItem(EMERGENCY_DRAFT_STORAGE_KEY);
  } catch (error) { /* best effort */ }
};

const isIndexedDBAvailable = () => (
  typeof window !== 'undefined' && Boolean(window.indexedDB)
);

const openDraftDb = () => {
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open annotation draft database'));
    request.onblocked = () => reject(new Error('Annotation draft database is blocked'));
  });

  return dbPromise;
};

const runStoreRequest = async (mode, callback) => {
  const db = await openDraftDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let request;

    try {
      request = callback(store);
    } catch (error) {
      reject(error);
      return;
    }

    if (request) {
      request.onerror = () => reject(request.error || new Error('Annotation draft request failed'));
    }

    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || request?.error || new Error('Annotation draft transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Annotation draft transaction aborted'));
  });
};

const groupAnnotationsByPage = annotations => {
  const pages = new Map();
  (Array.isArray(annotations) ? annotations : []).forEach(annotation => {
    const page = Math.max(1, Number(annotation?.page) || 1);
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(annotation);
  });
  return pages;
};

const writeShardedDraft = async draft => {
  const db = await openDraftDb();
  const hasFullSnapshot = Array.isArray(draft?.annotations);
  const annotationsByPage = hasFullSnapshot
    ? groupAnnotationsByPage(draft.annotations)
    : new Map((draft?.annotationPageUpdates || []).map(update => [
      Math.max(1, Number(update?.page) || 1),
      Array.isArray(update?.annotations) ? update.annotations : []
    ]));
  const annotationPages = hasFullSnapshot
    ? Array.from(annotationsByPage.keys()).sort((a, b) => a - b)
    : Array.from(new Set((draft?.annotationPages || []).map(Number).filter(page => page > 0))).sort((a, b) => a - b);
  const meta = {
    ...draft,
    id: LATEST_DRAFT_KEY,
    version: DRAFT_VERSION,
    storageMode: SHARDED_STORAGE_MODE,
    annotationCount: hasFullSnapshot
      ? draft.annotations.length
      : Math.max(0, Number(draft?.annotationCount) || 0),
    annotationPages,
    dirty: true,
    savedAt: new Date().toISOString()
  };
  delete meta.annotations;
  delete meta.annotationPageUpdates;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const keysRequest = store.getAllKeys();
    keysRequest.onerror = () => reject(keysRequest.error || new Error('Failed to inspect annotation draft pages'));
    keysRequest.onsuccess = () => {
      const activeKeys = new Set(annotationPages.map(page => `${PAGE_KEY_PREFIX}${page}`));
      (keysRequest.result || []).forEach(key => {
        if (typeof key === 'string' && key.startsWith(PAGE_KEY_PREFIX) && !activeKeys.has(key)) {
          store.delete(key);
        }
      });
      annotationsByPage.forEach((annotations, page) => {
        store.put({
          id: `${PAGE_KEY_PREFIX}${page}`,
          type: 'annotation-page',
          page,
          annotations,
          updatedAt: meta.updatedAt || meta.savedAt
        });
      });
      store.put(meta);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Annotation draft transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Annotation draft transaction aborted'));
  });
  return meta;
};

const reconstructShardedDraft = (meta, records) => {
  if (!meta || meta.storageMode !== SHARDED_STORAGE_MODE) return meta;
  const annotations = (records || [])
    .filter(record => record?.type === 'annotation-page' && Array.isArray(record.annotations))
    .sort((left, right) => Number(left.page) - Number(right.page))
    .flatMap(record => record.annotations);
  return { ...meta, annotations };
};

const toHex = (buffer) => Array.from(new Uint8Array(buffer))
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('');

const digestBytes = async (bytes) => {
  if (window.crypto?.subtle) {
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return toHex(digest);
  }

  let hash = 0x811c9dc5;
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const buildPdfDraftFileInfo = async (file, arrayBuffer = null) => {
  if (!file) {
    return null;
  }

  const name = file instanceof File ? file.name : String(file).split(/[\\/]/).pop();
  const size = file instanceof File ? file.size : null;
  const lastModified = file instanceof File ? file.lastModified : null;

  let fingerprint = '';
  if (!arrayBuffer && file instanceof File) {
    // Fingerprinting needs only the first and last samples. Reading the whole
    // PDF here briefly doubled large-file memory before PDF.js even started.
    const sampleSize = Math.min(FINGERPRINT_SAMPLE_SIZE, file.size);
    const first = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
    const lastStart = Math.max(0, file.size - sampleSize);
    const last = new Uint8Array(await file.slice(lastStart, file.size).arrayBuffer());
    const sample = new Uint8Array(first.byteLength + last.byteLength);
    sample.set(first, 0);
    sample.set(last, first.byteLength);
    fingerprint = await digestBytes(sample);
  } else if (arrayBuffer) {
    const sourceBuffer = arrayBuffer;
    const uint8 = sourceBuffer instanceof Uint8Array
      ? sourceBuffer
      : new Uint8Array(sourceBuffer);
    const sampleSize = Math.min(FINGERPRINT_SAMPLE_SIZE, uint8.byteLength);
    const sample = new Uint8Array(sampleSize * 2);
    sample.set(uint8.slice(0, sampleSize), 0);
    sample.set(uint8.slice(Math.max(0, uint8.byteLength - sampleSize)), sampleSize);
    fingerprint = await digestBytes(sample);
  }

  return {
    name,
    size,
    lastModified,
    fingerprint
  };
};

export const isSamePdfDraftFile = (draftFileInfo, selectedFileInfo) => {
  if (!draftFileInfo || !selectedFileInfo) {
    return false;
  }

  const sameName = draftFileInfo.name === selectedFileInfo.name;
  const sameSize = draftFileInfo.size == null || selectedFileInfo.size == null
    ? true
    : draftFileInfo.size === selectedFileInfo.size;
  const draftFingerprint = draftFileInfo.originalFingerprint || draftFileInfo.fingerprint;
  const selectedFingerprint = selectedFileInfo.originalFingerprint || selectedFileInfo.fingerprint;
  const hasFingerprint = Boolean(draftFingerprint && selectedFingerprint);
  const sameModified = hasFingerprint || draftFileInfo.lastModified == null || selectedFileInfo.lastModified == null
    ? true
    : draftFileInfo.lastModified === selectedFileInfo.lastModified;
  const sameFingerprint = hasFingerprint
    ? draftFingerprint === selectedFingerprint
    : true;

  return sameName && sameSize && sameModified && sameFingerprint;
};

export const saveLatestAnnotationDraft = async (draft) => {
  const normalizedDraft = await writeShardedDraft(draft);
  return {
    id: normalizedDraft.id,
    version: normalizedDraft.version,
    dirty: normalizedDraft.dirty,
    savedAt: normalizedDraft.savedAt,
    annotationCount: normalizedDraft.annotationCount,
    annotationPages: normalizedDraft.annotationPages.length
  };
};

export const loadLatestAnnotationDraft = async () => {
  const emergencyDraft = loadEmergencyDraft();
  try {
    const records = await runStoreRequest('readonly', store => store.getAll());
    const meta = (records || []).find(record => record?.id === LATEST_DRAFT_KEY);
    const draft = reconstructShardedDraft(meta, records);
    const indexedDraft = draft?.dirty && Array.isArray(draft.annotations) && draft.annotations.length > 0
      ? draft
      : null;
    if (!indexedDraft) return emergencyDraft;
    if (!emergencyDraft) return indexedDraft;
    return getDraftTimestamp(emergencyDraft) >= getDraftTimestamp(indexedDraft)
      ? emergencyDraft
      : indexedDraft;
  } catch (error) {
    console.warn('读取标注草稿失败:', error);
    return emergencyDraft;
  }
};

export const clearLatestAnnotationDraft = async () => {
  clearEmergencyDraft();
  await runStoreRequest('readwrite', store => store.clear());
};

export const markLatestAnnotationDraftSaved = async () => {
  clearEmergencyDraft();
  const draft = await runStoreRequest('readonly', store => store.get(LATEST_DRAFT_KEY));
  if (!draft) {
    return null;
  }

  const savedDraft = {
    ...draft,
    dirty: false,
    savedAt: new Date().toISOString()
  };

  await runStoreRequest('readwrite', store => store.put(savedDraft));
  return savedDraft;
};
