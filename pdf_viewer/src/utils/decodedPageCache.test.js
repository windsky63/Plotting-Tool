import {getDecodedPageBytes, trimDecodedPageCache} from './decodedPageCache';

test('small compressed PNGs cannot keep several large decoded pages resident', () => {
  const cache = new Map([1, 2, 3].map(page => [page, {size: 1000, pixelWidth: 4096, pixelHeight: 4096, lastUsed: page}]));
  const released = [];
  const stats = trimDecodedPageCache(cache, {protectedKey: 3, maxEntries: 3, maxBytes: 96 * 1024 * 1024, onEvict: (_, key) => released.push(key)});
  expect(Array.from(cache.keys())).toEqual([3]);
  expect(released).toEqual([1, 2]);
  expect(stats.decodedBytes).toBe(64 * 1024 * 1024);
});
test('the visible page survives a tight budget and extra pages are released first', () => {
  const cache = new Map([[1, {decodedBytes: 1000, size: 50, lastUsed: 1}], [2, {decodedBytes: 2000, size: 50, lastUsed: 2}]]);
  expect(trimDecodedPageCache(cache, {protectedKey: 1, maxEntries: 2, maxBytes: 100}).pages).toBe(1);
  expect(cache.has(1)).toBe(true);
  expect(getDecodedPageBytes({cssWidth: 300, cssHeight: 200})).toBe(240000);
});
test('ordinary pages still retain their configured cache count', () => {
  const cache = new Map([1, 2, 3].map(page => [page, {decodedBytes: 1000, size: 10, lastUsed: page}]));
  expect(trimDecodedPageCache(cache, {protectedKey: 3, maxEntries: 2, maxBytes: 3000}).pages).toBe(2);
  expect(Array.from(cache.keys())).toEqual([2, 3]);
});
