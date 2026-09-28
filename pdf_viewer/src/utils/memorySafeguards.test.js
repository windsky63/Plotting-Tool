import { PageDataCache } from './pageDataCache';
import { VectorExtractionUtils } from './vectorExtractionUtils';

describe('memory safeguards', () => {
  test('vector extraction accepts an injected PDF.js operator API', () => {
    const pdfjsApi = { OPS: { constructPath: 91 } };
    VectorExtractionUtils.configurePdfJs(pdfjsApi);
    expect(VectorExtractionUtils.pdfjsApi).toBe(pdfjsApi);
    expect(() => VectorExtractionUtils.configurePdfJs({})).toThrow(
      'Vector extraction requires a PDF.js API with OPS',
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    VectorExtractionUtils.vectorCache.clear();
  });

  test('emergency cleanup overrides the batch-mode cache window immediately', () => {
    jest.useFakeTimers();
    const cache = new PageDataCache(20);
    cache.enableBatchMode(1);
    for (let page = 1; page <= 50; page += 1) {
      cache.setPageData(page, { materials: [{ page }], detections: [{ page }] });
    }

    const stats = cache.emergencyCleanup(25);

    expect(stats.cachedPages).toBe(5);
    expect(cache.hasPage(22)).toBe(false);
    expect(cache.hasPage(23)).toBe(true);
    expect(cache.hasPage(27)).toBe(true);
    expect(cache.hasPage(28)).toBe(false);
    expect(cache.getPageData(1)._isLightData).toBe(true);
    jest.clearAllTimers();
  });

  test('vector cache evicts the least recently used page', () => {
    const previousLimit = VectorExtractionUtils.vectorCacheMaxEntries;
    VectorExtractionUtils.vectorCacheMaxEntries = 3;
    try {
      VectorExtractionUtils.cacheVectors('page:1', [1]);
      VectorExtractionUtils.cacheVectors('page:2', [2]);
      VectorExtractionUtils.cacheVectors('page:3', [3]);
      expect(VectorExtractionUtils.getCachedVectors('page:1')).toEqual([1]);
      VectorExtractionUtils.cacheVectors('page:4', [4]);

      expect(VectorExtractionUtils.vectorCache.has('page:2')).toBe(false);
      expect(VectorExtractionUtils.vectorCache.has('page:1')).toBe(true);
      expect(VectorExtractionUtils.vectorCache.size).toBe(3);
    } finally {
      VectorExtractionUtils.vectorCacheMaxEntries = previousLimit;
    }
  });
});
