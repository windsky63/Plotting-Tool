import { saveLatestAnnotationDraft } from './annotationDraftStore';
import { getAnnotationDraftUserKey, saveCloudAnnotationDraft } from './annotationCloudDraftStore';

const LOCAL_TIMEOUT_MS = 15000;
const CLOUD_TIMEOUT_MS = 20000;

let worker = null;
let workerUnavailable = false;
let requestCounter = 0;
const pendingRequests = new Map();

const rejectPendingRequests = error => {
  pendingRequests.forEach(({ reject, timer }) => {
    clearTimeout(timer);
    reject(error);
  });
  pendingRequests.clear();
};

const getWorker = () => {
  if (workerUnavailable || typeof window === 'undefined' || typeof window.Worker !== 'function') {
    return null;
  }
  if (worker) return worker;

  try {
    const publicBase = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
    worker = new window.Worker(`${publicBase}/annotation-draft-worker.js`);
    worker.onmessage = event => {
      const { requestId, ok, result, error, status } = event.data || {};
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (ok) {
        pending.resolve(result);
      } else {
        const failure = new Error(error || '后台草稿保存失败');
        failure.status = status;
        pending.reject(failure);
      }
    };
    worker.onerror = () => {
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
    activeWorker.postMessage({ requestId, type, draft, ...extra });
  });
};

export const saveLocalAnnotationDraftOffMainThread = draft => {
  const request = postWorkerRequest('save-local', draft, {}, LOCAL_TIMEOUT_MS);
  return request || saveLatestAnnotationDraft(draft);
};

export const saveCloudAnnotationDraftOffMainThread = draft => {
  const userKey = getAnnotationDraftUserKey();
  const request = postWorkerRequest('save-cloud', draft, {
    userKey,
    apiUrl: '/api/annotation-drafts/save',
    timeoutMs: CLOUD_TIMEOUT_MS
  }, CLOUD_TIMEOUT_MS + 1000);
  return request || saveCloudAnnotationDraft(draft);
};

export const disposeAnnotationDraftWorker = () => {
  if (!worker) return;
  try { worker.terminate(); } catch (error) { /* best effort */ }
  worker = null;
  rejectPendingRequests(new Error('后台草稿保存线程已关闭'));
};
