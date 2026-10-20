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
let signatureScope = '';
let cloudSnapshot = null;
let cloudSaveQueue = Promise.resolve();

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
  dbPromise = dbPromise.catch(error => { dbPromise = null; throw error; });
  return dbPromise;
};

const saveLocalDraft = async draft => {
  const db = await openDraftDb();
  const existingMeta = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(LATEST_DRAFT_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  const sameDocument = existingMeta?.fileInfo?.fingerprint === draft?.fileInfo?.fingerprint;
  let archive = null;
  if (existingMeta?.dirty && (draft.checkpoint || !sameDocument)) {
    const oldAnnotations = Array.isArray(existingMeta.annotations) ? existingMeta.annotations : await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly'), store = tx.objectStore(STORE_NAME), pages = [];
      (existingMeta.annotationPages || []).forEach(page => {
        const request = store.get(`${PAGE_KEY_PREFIX}${page}`);
        request.onsuccess = () => { if (request.result?.annotations) pages.push(request.result.annotations); };
      });
      tx.oncomplete = () => resolve(pages.flat()); tx.onerror = () => reject(tx.error);
    });
    if (oldAnnotations.length && (existingMeta.annotationCount === undefined || oldAnnotations.length === Number(existingMeta.annotationCount))) {
      const key = `archive:${existingMeta.fileInfo?.fingerprint || 'legacy'}:${Date.now()}`;
      archive = {...existingMeta, id: key, type: 'annotation-snapshot', storageMode: undefined, annotations: oldAnnotations};
    }
  }
  const scope = draft?.fileInfo?.fingerprint || draft.fileName || 'latest';
  if (signatureScope !== scope) { pageSignatures.clear(); signatureScope = scope; }
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
    ...(sameDocument ? existingMeta : {}),
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
  delete normalizedDraft.resetPageSnapshot;
  delete normalizedDraft.annotationOrder;
  let changedPages = 0;
  const nextSignatures = new Map(pageSignatures);
  let missingPages = [];
  let archiveSkipped = false;
  const persist = () => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const keysRequest = store.getAllKeys();
    keysRequest.onerror = () => reject(keysRequest.error || new Error('Failed to inspect annotation draft pages'));
    keysRequest.onsuccess = () => {
      const existingKeys = new Set(keysRequest.result || []);
      const suppliedPages = new Set(annotationsByPage.keys());
      missingPages = annotationPages.filter(page => !suppliedPages.has(page) &&
        (!sameDocument || !existingKeys.has(`${PAGE_KEY_PREFIX}${page}`)));
      if (missingPages.length) return; // Ask the UI for missing shards before writing a manifest.
      if (archive) {
        const {annotations, ...summary} = archive;
        store.put(archive);
        store.put({...summary, id: `archive-summary:${archive.id}`, type: 'archive-summary', localId: archive.id});
        const prefix = `archive:${existingMeta.fileInfo?.fingerprint || 'legacy'}:`;
        const oldKeys = [...existingKeys].filter(key => String(key).startsWith(prefix)).sort().reverse();
        oldKeys.slice(2).forEach(key => { store.delete(key); store.delete(`archive-summary:${key}`); });
        [...existingKeys].filter(key => String(key).startsWith('archive:'))
          .sort((a, b) => Number(String(b).split(':').pop()) - Number(String(a).split(':').pop())).slice(29)
          .forEach(key => {store.delete(key); store.delete(`archive-summary:${key}`);});
      }
      const activeKeys = new Set(annotationPages.map(page => `${PAGE_KEY_PREFIX}${page}`));
      (keysRequest.result || []).forEach(key => {
        if (typeof key === 'string' && key.startsWith(PAGE_KEY_PREFIX) && !activeKeys.has(key)) {
          store.delete(key);
          nextSignatures.delete(Number(key.slice(PAGE_KEY_PREFIX.length)));
        }
      });
      annotationsByPage.forEach((pageAnnotations, page) => {
        if (!pageAnnotations.length) {
          store.delete(`${PAGE_KEY_PREFIX}${page}`);
          nextSignatures.delete(page);
          changedPages += 1;
          return;
        }
        const signature = buildPageSignature(pageAnnotations);
        const pageKey = `${PAGE_KEY_PREFIX}${page}`;
        if (sameDocument && existingKeys.has(pageKey) && pageSignatures.get(page) === signature) return;
        changedPages += 1;
        nextSignatures.set(page, signature);
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
  try { await persist(); }
  catch (error) {
    if (!archive || error?.name !== 'QuotaExceededError') throw error;
    archive = null; archiveSkipped = true; changedPages = 0;
    await persist(); // Preserve the current draft even when a history copy cannot fit.
  }
  if (missingPages.length) return { needsPages: missingPages };
  // A failed transaction must not publish signatures for data never written.
  pageSignatures.clear();
  nextSignatures.forEach((value, page) => pageSignatures.set(page, value));
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
    suppliedPages: annotationsByPage.size,
    archiveSkipped
  };
};

const saveCloudDraft = async ({ draft, userKey, apiUrl, timeoutMs = 15000 }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // JSON.stringify is intentionally performed in this worker. For large
    // projects it was one of the periodic long tasks that blocked pointer input.
    const scope = `${userKey}:${draft?.fileInfo?.fingerprint || draft.fileName || 'latest'}`;
    if (!cloudSnapshot || cloudSnapshot.scope !== scope || draft.resetPageSnapshot) {
      cloudSnapshot = { scope, pages: new Map(), meta: {} };
    }
    if (Array.isArray(draft.annotations)) {
      cloudSnapshot.pages = groupAnnotationsByPage(draft.annotations);
    } else {
      (draft.annotationPageUpdates || []).forEach(update => {
        if (update.annotations?.length) cloudSnapshot.pages.set(Number(update.page), update.annotations);
        else cloudSnapshot.pages.delete(Number(update.page));
      });
      const activePages = new Set(draft.annotationPages || []);
      Array.from(cloudSnapshot.pages.keys()).forEach(page => {
        if (!activePages.has(page)) cloudSnapshot.pages.delete(page);
      });
      if ((draft.annotationPages || []).some(page => !cloudSnapshot.pages.has(page))) {
        throw new Error('云端草稿快照缺页，不能上传不完整数据');
      }
    }
    const { annotations, annotationPageUpdates, annotationPages, annotationCount, resetPageSnapshot, annotationOrder, ...meta } = draft;
    cloudSnapshot.meta = { ...cloudSnapshot.meta, ...meta };
    let snapshotAnnotations = Array.from(cloudSnapshot.pages.keys()).sort((a, b) => a - b)
      .flatMap(page => cloudSnapshot.pages.get(page));
    if (annotationOrder?.length === snapshotAnnotations.length) {
      const byId = new Map(snapshotAnnotations.map(annotation => [annotation.id, annotation]));
      if (byId.size === snapshotAnnotations.length && annotationOrder.every(id => byId.has(id))) {
        snapshotAnnotations = annotationOrder.map(id => byId.get(id));
      }
    }
    const body = JSON.stringify({ ...cloudSnapshot.meta, annotations: snapshotAnnotations, userKey });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch (error) { throw new Error('云端草稿接口返回无效 JSON，无法确认保存'); }
    if (!response.ok || !data || (data.success !== true && data.ok !== true)) {
      const failure = new Error(data?.detail || data?.error || `HTTP ${response.status}，草稿保存未确认`);
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
    let result;
    if (type === 'save-cloud') {
      const pending = cloudSaveQueue.then(() => saveCloudDraft({ draft, userKey, apiUrl, timeoutMs }));
      cloudSaveQueue = pending.catch(() => {});
      result = await pending;
    } else result = await saveLocalDraft(draft);
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
