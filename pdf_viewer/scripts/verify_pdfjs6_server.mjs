import assert from 'node:assert/strict';

const origin = process.env.SERVER_ORIGIN || 'http://127.0.0.1:3005';
const workerPath = '/pdf.worker-6.3.289.min.mjs';

const response = await fetch(new URL(workerPath, origin));
assert.equal(response.status, 200, `Worker request returned HTTP ${response.status}`);
assert.match(
  response.headers.get('content-type') || '',
  /(?:application|text)\/javascript/i,
  'The deployment server must serve .mjs workers with a JavaScript MIME type',
);

console.log(`${response.url} -> ${response.headers.get('content-type')}`);
