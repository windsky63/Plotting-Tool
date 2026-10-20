const USER_KEY_STORAGE_KEY = 'annotationDraftUserKey';
const REQUEST_TIMEOUT_MS = 10000;
const CLOUD_DRAFT_API_BASE = '/api/annotation-drafts';

const sanitizeUserKey = (value) => String(value || '')
  .trim()
  .replace(/[^a-zA-Z0-9_.-]/g, '_')
  .slice(0, 80);

const createUserKey = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `web_${crypto.randomUUID()}`;
  }
  return `web_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
};

export const getAnnotationDraftUserKey = () => {
  if (typeof window === 'undefined') {
    return 'web_unknown';
  }

  const existing = sanitizeUserKey(window.localStorage.getItem(USER_KEY_STORAGE_KEY));
  if (existing) {
    return existing;
  }

  const created = sanitizeUserKey(createUserKey());
  window.localStorage.setItem(USER_KEY_STORAGE_KEY, created);
  return created;
};

const requestJson = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw new Error('云端草稿接口返回无效 JSON，请重试'); }

    const legacyRead = !options.method && data && Object.prototype.hasOwnProperty.call(data, 'draft');
    if (!response.ok || !data || data.success === false || data.ok === false ||
        (!legacyRead && data.success !== true && data.ok !== true)) {
      const error = new Error(data?.detail || data?.error || `HTTP ${response.status}，草稿请求未确认`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
};

export const saveCloudAnnotationDraft = async (draft) => {
  const userKey = sanitizeUserKey(draft.fileInfo?.recoveryUserKey) || getAnnotationDraftUserKey();
  const payload = {
    ...draft,
    userKey
  };

  return requestJson(`${CLOUD_DRAFT_API_BASE}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
};

export const loadCloudAnnotationDraft = async (fingerprint, recoveryUserKey = '') => {
  if (!fingerprint) {
    return null;
  }

  const userKey = sanitizeUserKey(recoveryUserKey) || getAnnotationDraftUserKey();
  const params = new URLSearchParams({ userKey, fingerprint });
  const data = await requestJson(`${CLOUD_DRAFT_API_BASE}/latest?${params.toString()}`);
  return data.draft || null;
};

export const deleteCloudAnnotationDraft = async (fingerprint) => {
  if (!fingerprint) {
    return { success: true };
  }

  const userKey = getAnnotationDraftUserKey();
  const params = new URLSearchParams({ userKey, fingerprint });
  return requestJson(`${CLOUD_DRAFT_API_BASE}/latest?${params.toString()}`, {
    method: 'DELETE'
  });
};
