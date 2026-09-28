// Intentionally small state helpers keep preview request races testable outside
// the large PDF viewer component.
export const getDirectionalPreviewCacheKey = (scope, pageNumber) => (
  `${String(scope || '')}|preview:${Number(pageNumber)}`
);

export const isDirectionalPreviewStateForScope = (state, scope) => (
  Boolean(scope) && state?.scope === scope
);

export const acquireDirectionalPreviewRequest = (pending, key, signal, token) => {
  const existing = pending.get(key);
  if (existing && !existing.signal?.aborted) return false;
  pending.set(key, { signal, token });
  return true;
};

export const releaseDirectionalPreviewRequest = (pending, key, token) => {
  if (pending.get(key)?.token === token) pending.delete(key);
};

export const getDirectionalPreviewPages = ({ currentPage, direction, totalPages }) => {
  const current = Number(currentPage) || 1;
  const predicted = current + (Number(direction) < 0 ? -1 : 1);
  return [current, predicted].filter(page => page >= 1 && page <= Number(totalPages || 0));
};
