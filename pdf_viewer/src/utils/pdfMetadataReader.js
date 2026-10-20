import {createPdfMetadataWorker} from '../workers/createPdfMetadataWorker';
import {parsePdfMetadataPayload} from './pdfMetadataPayload';

let activeRead = null;

export const cancelPdfMetadataRead = () => activeRead?.cancel();

export async function readPdfMetadata(file, {useWorker = true} = {}) {
  cancelPdfMetadataRead();
  let worker;
  if (useWorker && file instanceof Blob && typeof Worker === 'function') {
    try {worker = createPdfMetadataWorker();} catch { /* Use the original parser if workers cannot start. */ }
  }
  if (!worker) {
    const bytes = typeof file === 'string' ? await (await fetch(file)).arrayBuffer() : await file.arrayBuffer();
    const pdfLib = window.PDFLib || await import('pdf-lib');
    return parsePdfMetadataPayload(bytes, pdfLib);
  }
  const startedAt = Date.now();
  window.__luotuPdfMetadataRead = {running: true, mode: 'worker', fileBytes: file.size, startedAt};
  return new Promise((resolve, reject) => {
    let finished = false, timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (activeRead?.worker === worker) activeRead = null;
      window.__luotuPdfMetadataRead = {running: false, mode: 'worker', fileBytes: file.size,
        startedAt, finishedAt: Date.now(), terminated: true, error: error?.message || null};
      if (error) reject(error); else resolve(result);
    };
    activeRead = {worker, cancel: () => finish(new DOMException('PDF metadata read cancelled', 'AbortError'))};
    timer = setTimeout(() => finish(new Error('PDF 标注读取超时，请从恢复入口重试')), 180000);
    worker.onmessage = ({data}) => data?.ok ? finish(null, data.result) : finish(new Error(data?.error || 'PDF 标注读取失败'));
    worker.onerror = event => finish(new Error(`PDF 标注读取线程失败，请重新打开 PDF 或从恢复入口重试${event?.message ? `：${event.message}` : ''}`));
    worker.onmessageerror = () => finish(new Error('PDF 标注数据传输失败，请重试'));
    try {worker.postMessage({file});} catch (error) {finish(error);}
  });
}
