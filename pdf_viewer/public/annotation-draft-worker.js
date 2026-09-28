/* global self, indexedDB, fetch, AbortController */

// Keep the expensive structured-clone-to-IndexedDB and JSON serialization
// away from React's UI thread. The worker writes to the same database used by
// annotationDraftStore.js, so existing recovery and clear/save flows remain
// compatible.
const DB_NAME = 'pdf_viewer_annotation_drafts';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';
const LATEST_DRAFT_KEY = 'latest';
const PAGE_KEY_PREFIX = `${LATEST_DRAFT_KEY}:page:`;
const SHARDED_STORAGE_MODE = 'page-shards-v1';
const DRAFT_VERSION = 1;

let dbPromise = null;
const pageSignatures = new Map();

const getAnnotationPage = annotation => Math.max(1, Number(annotation?.page) || 1);

const groupAnnotationsByPage = annotations => {
  const pages = new Map();
  (Array.isArray(annotations) ? annotations : []).forEach(annotation => {
    const page = getAnnotationPage(annotation);
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(annotation);
  });
  return pages;
};

const hashText = text => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const buildPageSignature = annotations => hashText(JSON.stringify(annotations));

const openDraftDb = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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

const saveLocalDraft = async draft => {
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
  const normalizedDraft = {
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
  delete normalizedDraft.annotations;
  delete normalizedDraft.annotationPageUpdates;
  let changedPages = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const keysRequest = store.getAllKeys();
    keysRequest.onerror = () => reject(keysRequest.error || new Error('Failed to inspect annotation draft pages'));
    keysRequest.onsuccess = () => {
      const existingKeys = new Set(keysRequest.result || []);
      const activeKeys = new Set(annotationPages.map(page => `${PAGE_KEY_PREFIX}${page}`));
      (keysRequest.result || []).forEach(key => {
        if (typeof key === 'string' && key.startsWith(PAGE_KEY_PREFIX) && !activeKeys.has(key)) {
          store.delete(key);
          pageSignatures.delete(Number(key.slice(PAGE_KEY_PREFIX.length)));
        }
      });
      annotationsByPage.forEach((pageAnnotations, page) => {
        const signature = buildPageSignature(pageAnnotations);
        const pageKey = `${PAGE_KEY_PREFIX}${page}`;
        if (existingKeys.has(pageKey) && pageSignatures.get(page) === signature) return;
        changedPages += 1;
        pageSignatures.set(page, signature);
        store.put({
          id: pageKey,
          type: 'annotation-page',
          page,
          annotations: pageAnnotations,
          signature,
          updatedAt: normalizedDraft.updatedAt || normalizedDraft.savedAt
        });
      });
      store.put(normalizedDraft);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Annotation draft transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Annotation draft transaction aborted'));
  });
  // Never clone the complete annotation graph back to the UI thread. The
  // caller only needs an acknowledgement; returning the saved draft retained
  // another multi-megabyte generation after every checkpoint.
  return {
    id: normalizedDraft.id,
    version: normalizedDraft.version,
    dirty: normalizedDraft.dirty,
    savedAt: normalizedDraft.savedAt,
    annotationCount: normalizedDraft.annotationCount,
    annotationPages: normalizedDraft.annotationPages.length,
    changedPages,
    snapshotMode: hasFullSnapshot ? 'full' : 'delta',
    suppliedPages: annotationsByPage.size
  };
};

const saveCloudDraft = async ({ draft, userKey, apiUrl, timeoutMs = 15000 }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // JSON.stringify is intentionally performed in this worker. For large
    // projects it was one of the periodic long tasks that blocked pointer input.
    const body = JSON.stringify({ ...draft, userKey });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (error) { data = {}; }
    if (!response.ok || data.success === false) {
      const failure = new Error(data.detail || data.error || `HTTP ${response.status}`);
      failure.status = response.status;
      throw failure;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
};

self.onmessage = async event => {
  const { requestId, type, draft, userKey, apiUrl, timeoutMs } = event.data || {};
  if (!requestId || !draft) return;
  try {
    const result = type === 'save-cloud'
      ? await saveCloudDraft({ draft, userKey, apiUrl, timeoutMs })
      : await saveLocalDraft(draft);
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error?.message || String(error),
      status: Number(error?.status || 0)
    });
  }
};
