import { estimateVectorBytes } from './pageVectorStore';

export function retainNearbyPageVectors(vectors, currentPage, maxBytes = 32 * 1024 * 1024) {
  const entries = Object.entries(vectors || {}).filter(([page, value]) =>
    Array.isArray(value) && Math.abs(Number(page) - Number(currentPage)) <= 2)
    .sort(([a], [b]) => Math.abs(Number(a) - currentPage) - Math.abs(Number(b) - currentPage));
  const result = {}; let bytes = 0;
  for (const [page, value] of entries) {
    const size = estimateVectorBytes(value);
    if (Object.keys(result).length && bytes + size > maxBytes) continue;
    result[page] = value; bytes += size;
  }
  return result;
}
