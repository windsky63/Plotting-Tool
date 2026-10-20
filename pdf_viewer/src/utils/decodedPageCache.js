export const getDecodedPageBytes = item => {
  if (Number.isFinite(item?.decodedBytes)) return Math.max(0, item.decodedBytes);
  const width = Number(item?.pixelWidth || item?.cssWidth) || 0;
  const height = Number(item?.pixelHeight || item?.cssHeight) || 0;
  return Math.max(0, width) * Math.max(0, height) * 4;
};

export function trimDecodedPageCache(cache, {protectedKey, maxEntries, maxBytes, onEvict}) {
  let encodedBytes = 0, decodedBytes = 0;
  cache.forEach(item => {
    encodedBytes += Math.max(0, Number(item?.size) || 0);
    decodedBytes += getDecodedPageBytes(item);
  });
  const candidates = Array.from(cache.entries()).filter(([key]) => key !== protectedKey)
    .sort((a, b) => Number(a[1]?.lastUsed || 0) - Number(b[1]?.lastUsed || 0));
  // Keep the current visible page even if it alone exceeds the budget. Extra
  // pages are reloadable from disk/server without changing display quality.
  while (candidates.length && (cache.size > maxEntries || encodedBytes + decodedBytes > maxBytes)) {
    const [key, item] = candidates.shift();
    cache.delete(key);
    encodedBytes -= Math.max(0, Number(item?.size) || 0);
    decodedBytes -= getDecodedPageBytes(item);
    onEvict?.(item, key);
  }
  return {pages: cache.size, encodedBytes, decodedBytes, totalBytes: encodedBytes + decodedBytes};
}
