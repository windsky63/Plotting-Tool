const { isReusablePageManifest } = require('../../scripts/pdf_page_cache_service');

test('a fully rendered page cache remains reusable while previews are queued or rendering', () => {
  const base = {
    total: 2,
    completed: [1, 2],
    pages: { 1: { width: 100, height: 80 }, 2: { width: 100, height: 80 } }
  };

  expect(isReusablePageManifest({ ...base, status: 'complete' })).toBe(true);
  expect(isReusablePageManifest({ ...base, status: 'queued' })).toBe(true);
  expect(isReusablePageManifest({ ...base, status: 'rendering' })).toBe(true);
});

test('a partial or failed page cache is not advertised as reusable', () => {
  expect(isReusablePageManifest({
    status: 'rendering',
    total: 2,
    completed: [1],
    pages: { 1: { width: 100, height: 80 } }
  })).toBe(false);
  expect(isReusablePageManifest({
    status: 'error',
    total: 2,
    completed: [1, 2],
    pages: { 1: {}, 2: {} }
  })).toBe(false);
});
