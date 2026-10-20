export async function optimizePdfExport(blob, {onStatus, fetchImpl = fetch, timeoutMs = 125000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const status = await fetchImpl('/api/pdf-export/optimize/status', {signal: controller.signal});
    if (!status.ok) throw Error('优化接口尚未部署');
    const health = await status.json();
    if (!health.available || health.busy) throw Error('优化服务不可用或正在忙碌');
    if (blob.size > health.maxBytes) throw Error('文件超过本次优化大小限制');
    onStatus?.('正在无损优化 PDF 并校验页面和标注数据');
    const response = await fetchImpl('/api/pdf-export/optimize', {method: 'POST',
      headers: {'Content-Type': 'application/pdf'}, body: blob, signal: controller.signal});
    if (response.status === 204) return {blob, optimized: false, unchanged: true};
    if (!response.ok || !response.headers.get('Content-Type')?.includes('application/pdf')) throw Error('优化或完整性校验未通过');
    const optimized = await response.blob();
    if (!optimized.size || optimized.size >= blob.size) throw Error('优化结果大小异常');
    return {blob: optimized, optimized: true, savedBytes: blob.size - optimized.size};
  } catch (error) {
    return {blob, optimized: false, warning: error.name === 'AbortError' ? '优化超时' : error.message};
  } finally {clearTimeout(timer);}
}
