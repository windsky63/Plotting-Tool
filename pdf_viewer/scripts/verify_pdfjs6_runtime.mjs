import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const expectedVersion = '6.3.289';
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

assert.equal(
  pdfjs.version,
  expectedVersion,
  `Expected pdfjs-dist ${expectedVersion}, received ${pdfjs.version}`,
);

const source = await PDFDocument.create();
const page = source.addPage([320, 180]);
const font = await source.embedFont(StandardFonts.Helvetica);
page.drawText('PDFJS6-SMOKE', { x: 24, y: 90, size: 18, font });
const bytes = await source.save();
const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
const document = await loadingTask.promise;

try {
  assert.equal(document.numPages, 1);
  const firstPage = await document.getPage(1);
  const text = await firstPage.getTextContent();
  assert.match(text.items.map((item) => item.str).join(' '), /PDFJS6-SMOKE/);

  const operators = await firstPage.getOperatorList();
  assert.ok(operators.fnArray.length > 0, 'Expected a non-empty PDF operator list');
  assert.equal(typeof pdfjs.OPS.showText, 'number');
} finally {
  await loadingTask.destroy();
}

console.log(`pdfjs-dist ${pdfjs.version} loaded text and operators successfully`);
