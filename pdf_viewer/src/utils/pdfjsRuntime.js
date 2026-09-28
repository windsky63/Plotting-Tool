let runtimeInfo = { apiVersion: '', workerSrc: '' };

export const PDFJS_VERSION = '6.3.289';
export const PDFJS_WORKER_FILE = `pdf.worker-${PDFJS_VERSION}.min.mjs`;

export const configurePdfJsRuntime = (pdfjsApi, workerSrc) => {
  const assetPath = String(workerSrc || '').split(/[?#]/, 1)[0];
  if (!assetPath.endsWith('.mjs')) {
    throw new Error('PDF.js 6 worker must use a .mjs asset');
  }

  pdfjsApi.GlobalWorkerOptions.workerSrc = workerSrc;
  runtimeInfo = {
    apiVersion: String(pdfjsApi.version || ''),
    workerSrc,
  };

  if (typeof window !== 'undefined') {
    window.__luotuPdfJsRuntime = { ...runtimeInfo };
  }

  return { ...runtimeInfo };
};

export const getPdfJsRuntimeInfo = () => ({ ...runtimeInfo });
