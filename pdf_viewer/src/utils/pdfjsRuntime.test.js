import { configurePdfJsRuntime, getPdfJsRuntimeInfo } from './pdfjsRuntime';

describe('PDF.js runtime configuration', () => {
  test('configures a versioned ESM worker and exposes diagnostics', () => {
    const pdfjsApi = {
      version: '6.3.289',
      GlobalWorkerOptions: { workerSrc: '' },
    };
    const workerSrc = '/static/media/pdf.worker.min.abc123.mjs';

    expect(configurePdfJsRuntime(pdfjsApi, workerSrc)).toEqual({
      apiVersion: '6.3.289',
      workerSrc,
    });
    expect(pdfjsApi.GlobalWorkerOptions.workerSrc).toBe(workerSrc);
    expect(getPdfJsRuntimeInfo()).toEqual({
      apiVersion: '6.3.289',
      workerSrc,
    });
    expect(window.__luotuPdfJsRuntime).toEqual({
      apiVersion: '6.3.289',
      workerSrc,
    });
  });

  test('rejects classic JavaScript workers', () => {
    const pdfjsApi = {
      version: '6.3.289',
      GlobalWorkerOptions: { workerSrc: '' },
    };

    expect(() => configurePdfJsRuntime(pdfjsApi, '/pdf.worker.min.js')).toThrow(
      'PDF.js 6 worker must use a .mjs asset',
    );
  });
});
