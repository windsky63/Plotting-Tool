import { saveLatestAnnotationDraft } from './annotationDraftStore';
import { getAnnotationDraftUserKey, saveCloudAnnotationDraft } from './annotationCloudDraftStore';
import { prepareDraftPageTransfer } from './draftPageTransfer';

const LOCAL_TIMEOUT_MS = 15000;
const CLOUD_TIMEOUT_MS = 20000;

let worker = null;
let workerUnavailable = false;
let requestCounter = 0;
const pendingRequests = new Map();
const activeRequests = new Set();
let idleReleaseTimer = null;
let releaseWhenIdle = false;
let localTransfer = null;
let cloudTransfer = null;
let localTransferVersion = 0;
let cloudTransferVersion = 0;

// Persisted drafts remain in IndexedDB/on the server. Only cloned worker
// snapshots and incremental baselines are released; the next save resyncs all pages.
export const releaseIdleDraftWorker = () => {
  releaseWhenIdle = true;
  if (activeRequests.size) return false;
  clearTimeout(idleReleaseTimer);
  idleReleaseTimer = null;
  try { worker?.terminate(); } catch { /* already stopped */ }
  worker = null;
  localTransfer = null; cloudTransfer = null;
  localTransferVersion += 1; cloudTransferVersion += 1;
  releaseWhenIdle = false;
  return true;
};

const scheduleIdleRelease = () => {
  clearTimeout(idleReleaseTimer);
  idleReleaseTimer = null;
  if (activeRequests.size) return;
  if (releaseWhenIdle) releaseIdleDraftWorker();
  else idleReleaseTimer = setTimeout(releaseIdleDraftWorker, 120000);
};

const rejectPendingRequests = error => {
  pendingRequests.forEach(({ reject, timer }) => {
    clearTimeout(timer);
    reject(error);
  });
  pendingRequests.clear();
  activeRequests.clear();
  clearTimeout(idleReleaseTimer);
};

const getWorker = () => {
  clearTimeout(idleReleaseTimer);
  idleReleaseTimer = null;
  releaseWhenIdle = false;
  if (workerUnavailable || typeof window === 'undefined' || typeof window.Worker !== 'function') {
    return null;
  }
  if (worker) return worker;

  try {
    const publicBase = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
    worker = new window.Worker(`${publicBase}/annotation-draft-worker.js`);
    worker.onmessage = event => {
      const { requestId, ok, result, error, status } = event.data || {};
      activeRequests.delete(requestId);
      const pending = pendingRequests.get(requestId);
      if (!pending) { scheduleIdleRelease(); return; }
      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (ok) {
        pending.resolve(result);
      } else {
        const failure = new Error(error || '后台草稿保存失败');
        failure.status = status;
        pending.reject(failure);
      }
      scheduleIdleRelease();
    };
    worker.onerror = () => {
      localTransfer = null;
      cloudTransfer = null;
      const error = new Error('后台草稿保存线程异常');
      workerUnavailable = true;
      try { worker?.terminate(); } catch (terminateError) { /* best effort */ }
      worker = null;
      rejectPendingRequests(error);
    };
  } catch (error) {
    workerUnavailable = true;
    worker = null;
  }
  return worker;
};

const postWorkerRequest = (type, draft, extra = {}, timeoutMs) => {
  const activeWorker = getWorker();
  if (!activeWorker) return null;
  const requestId = `draft-${Date.now()}-${requestCounter += 1}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('后台草稿保存超时'));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
    activeRequests.add(requestId);
    try { activeWorker.postMessage({ requestId, type, draft, ...extra }); }
    catch (error) {
      activeRequests.delete(requestId); pendingRequests.delete(requestId); clearTimeout(timer);
      reject(error); scheduleIdleRelease();
    }
  });
};

export const saveLocalAnnotationDraftOffMainThread = draft => {
  const transferVersion = ++localTransferVersion;
  const transfer = prepareDraftPageTransfer(draft, localTransfer);
  const active = getWorker();
  if (!active) return saveLatestAnnotationDraft(draft);
  const save = async () => {
    let result = await postWorkerRequest('save-local', transfer.payload, {}, LOCAL_TIMEOUT_MS);
    if (result?.needsPages?.length) {
      const supplied = new Map(transfer.payload.annotationPageUpdates.map(x => [x.page, x.annotations]));
      result.needsPages.forEach(page => {
        const annotations = transfer.index?.byPage.get(page);
        if (!annotations) throw new Error(`Missing annotation page ${page}; refusing incomplete draft`);
        supplied.set(page, annotations);
      });
      result = await postWorkerRequest('save-local', {
        ...transfer.payload, annotationPageUpdates: Array.from(supplied, ([page, annotations]) => ({ page, annotations })),
      }, {}, LOCAL_TIMEOUT_MS);
      if (result?.needsPages?.length) throw new Error('草稿缺页补写失败');
    }
    if (worker === active && transferVersion === localTransferVersion) localTransfer = transfer.next;
    return result;
  };
  return save();
};

export const saveCloudAnnotationDraftOffMainThread = draft => {
  const transferVersion = ++cloudTransferVersion;
  const userKey = draft.fileInfo?.recoveryUserKey || getAnnotationDraftUserKey();
  const active = getWorker();
  if (!active) return saveCloudAnnotationDraft(draft);
  const transfer = prepareDraftPageTransfer(draft, cloudTransfer);
  const request = postWorkerRequest('save-cloud', transfer.payload, {
    userKey,
    apiUrl: '/api/annotation-drafts/save',
    timeoutMs: CLOUD_TIMEOUT_MS
  }, CLOUD_TIMEOUT_MS + 1000);
  return request.then(result => {
    if (worker === active && transferVersion === cloudTransferVersion) cloudTransfer = transfer.next;
    return result;
  });
};

export const disposeAnnotationDraftWorker = () => {
  if (!worker) return;
  try { worker.terminate(); } catch (error) { /* best effort */ }
  worker = null;
  localTransfer = null;
  cloudTransfer = null;
  rejectPendingRequests(new Error('后台草稿保存线程已关闭'));
};
