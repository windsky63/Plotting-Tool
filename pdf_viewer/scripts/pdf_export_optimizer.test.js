const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {PDFDocument} = require('pdf-lib');
const {createPdfExportOptimizer} = require('./pdf_export_optimizer');

test('HTTP optimization, validation failure, bounded admission and cancellation', async () => {
  const service = createPdfExportOptimizer();
  const server = http.createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/pdf-export/optimize`;
  try {
    assert.equal((await (await fetch(base + '/status')).json()).available, true);
    const doc = await PDFDocument.create(); doc.addPage();
    await doc.attach(Buffer.from('{"annotations":[1]}'), 'annotations.json');
    doc.context.register(doc.context.stream(Buffer.alloc(100000, 65)));
    const bytes = await doc.save({useObjectStreams: false});
    const response = await fetch(base, {method: 'POST', body: bytes});
    assert.equal(response.status, 200);
    const output = new Uint8Array(await response.arrayBuffer());
    assert.ok(output.length < bytes.length); assert.equal((await PDFDocument.load(output)).getPageCount(), 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await fetch(base, {method: 'POST', body: 'not pdf'})).status, 422);
    await new Promise(resolve => setTimeout(resolve, 100));
    const hanging = http.request(base, {method: 'POST'}, res => res.resume());
    hanging.on('error', () => {}); hanging.write('partial');
    for (let i = 0; i < 30; i++) {
      if ((await (await fetch(base + '/status')).json()).busy) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await fetch(base, {method: 'POST', body: bytes})).status, 503);
    hanging.destroy();
    for (let i = 0; i < 50; i++) {
      if (!(await (await fetch(base + '/status')).json()).busy) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await (await fetch(base + '/status')).json()).busy, false);
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});
