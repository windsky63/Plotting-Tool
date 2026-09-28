import {
  acquireDirectionalPreviewRequest,
  getDirectionalPreviewCacheKey,
  getDirectionalPreviewPages,
  isDirectionalPreviewStateForScope,
  releaseDirectionalPreviewRequest
} from './directionalPreviewCache';

test('preview cache keys cannot reuse the same page from another PDF', () => {
  expect(getDirectionalPreviewCacheKey('drawing-a', 1)).not.toBe(
    getDirectionalPreviewCacheKey('drawing-b', 1)
  );
});

test('preview state from a previous PDF cannot schedule requests in the new PDF scope', () => {
  const previousDocumentState = {
    scope: 'drawing-a|snapshot:v2',
    cacheId: 'old-cache',
    previews: { 1: { width: 1000, height: 1500 } }
  };

  expect(isDirectionalPreviewStateForScope(
    previousDocumentState,
    'drawing-b|snapshot:v2'
  )).toBe(false);
  expect(isDirectionalPreviewStateForScope(
    previousDocumentState,
    'drawing-a|snapshot:v2'
  )).toBe(true);
});

test('an aborted preview request can be replaced without stale cleanup deleting its successor', () => {
  const pending = new Map();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstToken = {};
  const secondToken = {};
  const key = getDirectionalPreviewCacheKey('drawing-a', 7);

  expect(acquireDirectionalPreviewRequest(pending, key, firstController.signal, firstToken)).toBe(true);
  firstController.abort();
  expect(acquireDirectionalPreviewRequest(pending, key, secondController.signal, secondToken)).toBe(true);

  releaseDirectionalPreviewRequest(pending, key, firstToken);
  expect(pending.get(key)?.token).toBe(secondToken);
  releaseDirectionalPreviewRequest(pending, key, secondToken);
  expect(pending.has(key)).toBe(false);
});

test('directional buffer contains only current and predicted next page', () => {
  expect(getDirectionalPreviewPages({ currentPage: 5, direction: 1, totalPages: 10 })).toEqual([5, 6]);
  expect(getDirectionalPreviewPages({ currentPage: 5, direction: -1, totalPages: 10 })).toEqual([5, 4]);
  expect(getDirectionalPreviewPages({ currentPage: 10, direction: 1, totalPages: 10 })).toEqual([10]);
});
