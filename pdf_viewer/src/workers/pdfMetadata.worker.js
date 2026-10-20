/* eslint-env worker */
/* global __webpack_public_path__ */
import {parsePdfMetadataPayload} from '../utils/pdfMetadataPayload';

// CRA's relative PUBLIC_URL is relative to the worker's /static/js/ URL.
// Resolve lazy parser chunks against the app root, including subpath installs.
__webpack_public_path__ = new URL('../../', self.location.href).href;
self.onmessage = async ({data}) => {
  try {
    const pdfLib = await import('pdf-lib');
    const bytes = await data.file.arrayBuffer();
    const result = await parsePdfMetadataPayload(bytes, pdfLib);
    self.postMessage({ok: true, result});
  } catch (error) {
    self.postMessage({ok: false, error: error.message});
  }
};
