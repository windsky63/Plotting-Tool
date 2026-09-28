export const DEFAULT_OCR_SERVER_HOST = '192.168.32.61';
export const DEFAULT_OCR_SERVER_PORT = 8766;

export function getCurrentPageHost() {
  if (typeof window === 'undefined') return DEFAULT_OCR_SERVER_HOST;
  const host = window.location?.hostname;
  return host || DEFAULT_OCR_SERVER_HOST;
}

export function getDefaultOcrServerHost() {
  const host = getCurrentPageHost();
  if (host === 'localhost' || host === '127.0.0.1') {
    return '127.0.0.1';
  }
  return DEFAULT_OCR_SERVER_HOST;
}

export function isSameOriginProxyRuntime() {
  if (typeof window === 'undefined') return false;
  if (window.electronAPI) return false;
  const host = window.location?.hostname;
  if (!host) return false;
  return !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host);
}

export function getSameOriginServerUrl() {
  if (typeof window === 'undefined') {
    return `http://${DEFAULT_OCR_SERVER_HOST}:${DEFAULT_OCR_SERVER_PORT}`;
  }
  return window.location.origin.replace(/\/+$/, '');
}

export function normalizeOcrServerHost(host) {
  const value = String(host || '').trim().replace(/\/+$/, '');
  if (!value) {
    return getDefaultOcrServerHost();
  }
  return value.replace(/^https?:\/\//, '') || getDefaultOcrServerHost();
}

export function buildOcrServerUrl(host = getDefaultOcrServerHost(), port = DEFAULT_OCR_SERVER_PORT) {
  if (isSameOriginProxyRuntime()) {
    return getSameOriginServerUrl();
  }
  return `http://${normalizeOcrServerHost(host)}:${port || DEFAULT_OCR_SERVER_PORT}`;
}
