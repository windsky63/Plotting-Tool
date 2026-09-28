/** @jest-environment node */
import * as PDFLib from 'pdf-lib';
import { savePdfWithTimeBudget } from './pdfSerialization';
import { Blob as NodeBlob } from 'buffer';
import fs from 'fs';
import path from 'path';
import UPNG from '@pdf-lib/upng';

global.Blob = NodeBlob;

const oldSave = doc => doc.save({ useObjectStreams: false, updateFieldAppearances: false });
const sameBytes = (left, right) => Buffer.from(left).equals(Buffer.from(right));

test('small document has byte-identical output, including images, rotation, crop and attachments', async () => {
  const doc = await PDFLib.PDFDocument.create();
  doc.setTitle('小样本封装回归');
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const png = await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1kAAAAASUVORK5CYII=', 'base64'));
  for (let i = 0; i < 12; i += 1) {
    const page = doc.addPage(i % 2 ? [842, 595] : [1191, 842]);
    page.drawText(`WELD ${i + 1}`, { x: 100, y: 100, font, size: 16 });
    page.drawImage(png, { x: 10, y: 20, width: 57, height: 57 });
    if (i % 3 === 0) page.setRotation(PDFLib.degrees(90));
    if (i % 5 === 0) page.setCropBox(5, 10, 800, 500);
  }
  await doc.attach(Buffer.from('{"annotations":[{"text":"焊口1"}]}'), 'annotations.json', { mimeType: 'application/json' });
  const original = await oldSave(doc);
  const events = [];
  const { bytes, diagnostics } = await savePdfWithTimeBudget(doc, { pdfLib: PDFLib, onProgress: e => events.push(e) });
  expect(sameBytes(bytes, original)).toBe(true);
  expect((await PDFLib.PDFDocument.load(bytes)).getPageCount()).toBe(12);
  expect(diagnostics.mode).toBe('time-budget-writer');
  expect(events.at(-1).completedSteps).toBe(events.at(-1).totalSteps);
  const chunked = await savePdfWithTimeBudget(doc, { pdfLib: PDFLib, output: 'blob', chunkSizeBytes: 1024 });
  expect(sameBytes(new Uint8Array(await chunked.blob.arrayBuffer()), original)).toBe(true);
  expect(chunked.blob.type).toBe('application/pdf');
  expect(chunked.diagnostics.mode).toBe('chunked-blob-writer');
  expect(chunked.diagnostics.blobAssemblyMode).toBe('main-thread');
}, 30000);

test('browser worker assembles transferred chunks byte-identically and is terminated', async () => {
  const OriginalWorker = global.Worker;
  const originalCreateObjectURL = global.URL.createObjectURL;
  const originalRevokeObjectURL = global.URL.revokeObjectURL;
  let terminated = false;
  let revoked = false;

  class FakeWorker {
    constructor() {
      this.chunks = [];
      setImmediate(() => this.onmessage?.({ data: { type: 'ready' } }));
    }

    postMessage(message) {
      if (message.type === 'chunk') {
        this.chunks.push(message.buffer);
      } else if (message.type === 'finish') {
        const blob = new NodeBlob(this.chunks, { type: 'application/pdf' });
        this.chunks.length = 0;
        setImmediate(() => this.onmessage?.({ data: { type: 'done', blob } }));
      }
    }

    terminate() {
      terminated = true;
      this.chunks.length = 0;
    }
  }

  global.Worker = FakeWorker;
  global.URL.createObjectURL = () => 'blob:pdf-worker-test';
  global.URL.revokeObjectURL = () => { revoked = true; };
  try {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([842, 595]).drawText('isolated worker export');
    const original = await oldSave(doc);
    const result = await savePdfWithTimeBudget(doc, {
      pdfLib: PDFLib,
      output: 'blob',
      chunkSizeBytes: 1024
    });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(sameBytes(bytes, original)).toBe(true);
    expect(result.diagnostics.blobAssemblyMode).toBe('isolated-worker');
    expect(terminated).toBe(true);
    expect(revoked).toBe(true);
  } finally {
    global.Worker = OriginalWorker;
    global.URL.createObjectURL = originalCreateObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('fresh document matches save default-page behavior', async () => {
  const doc = await PDFLib.PDFDocument.create();
  const { bytes } = await savePdfWithTimeBudget(doc, { pdfLib: PDFLib });
  expect(doc.getPageCount()).toBe(1);
  expect(sameBytes(bytes, await oldSave(doc))).toBe(true);
});

test('chunked export never invokes the whole-file allocation and preserves large objects and xref gaps', async () => {
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage();
  for (let i = 0; i < 8; i += 1) {
    const data = new Uint8Array(6000 + i);
    data.fill(i + 1);
    doc.context.register(doc.context.stream(data));
  }
  const removed = doc.context.register(doc.context.obj({ Test: 1 }));
  doc.context.delete(removed);
  doc.context.register(doc.context.obj({ Test: 2 }));
  const original = await oldSave(doc);
  const wholeFileWriter = jest.spyOn(PDFLib.PDFWriter.prototype, 'serializeToBuffer')
    .mockImplementation(() => { throw new Error('whole file allocation forbidden'); });
  try {
    const result = await savePdfWithTimeBudget(doc, { pdfLib: PDFLib, output: 'blob', chunkSizeBytes: 1024 });
    expect(wholeFileWriter).not.toHaveBeenCalled();
    expect(result.bytes).toBeUndefined();
    expect(result.diagnostics.maxBufferBytes).toBeLessThan(6500);
    expect(result.blob.size).toBe(original.length);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(sameBytes(bytes, original)).toBe(true);
    expect((await PDFLib.PDFDocument.load(bytes)).getPageCount()).toBe(1);
  } finally {
    wholeFileWriter.mockRestore();
  }
});

test('embedding each image immediately releases decoded pixels without changing RGB or alpha streams', async () => {
  const pngBytes = new Uint8Array(UPNG.encode([new Uint8Array([255, 0, 0, 128, 0, 0, 0, 0]).buffer], 2, 1, 0));
  const doc = await PDFLib.PDFDocument.create();
  const pending = await doc.embedPng(pngBytes);
  const immediate = await doc.embedPng(pngBytes);
  expect(pending.embedder).toBeDefined();
  await immediate.embed();
  expect(immediate.embedder).toBeUndefined();
  await doc.flush();
  const pendingStream = doc.context.lookup(pending.ref);
  const immediateStream = doc.context.lookup(immediate.ref);
  expect(sameBytes(pendingStream.getContents(), immediateStream.getContents())).toBe(true);
  const mask = image => doc.context.lookup(image.dict.get(PDFLib.PDFName.of('SMask'))).getContents();
  expect(sameBytes(mask(pendingStream), mask(immediateStream))).toBe(true);
  const source = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8');
  expect(source).toMatch(/await annotImage\.embed\(\);/);
  expect(source).toContain("exportReporter('annotated'), 'blob'");
});

test('slow timer resume receives a fresh work budget, not a new wait after every object', async () => {
  let time = 0;
  const waits = [];
  const writer = {
    shouldWaitForTick: () => true,
    serializeToBuffer: async () => {
      for (const nextTime of [0, 13, 1000, 1001, 1014, 2000, 2001, 2014, 3000, 3001]) {
        time = nextTime;
        waits.push(writer.shouldWaitForTick(1));
      }
      return new Uint8Array([1, 2]);
    },
  };
  const pdfDoc = { getPageCount: () => 1, flush: async () => {}, context: { enumerateIndirectObjects: () => Array(5) } };
  const { diagnostics } = await savePdfWithTimeBudget(pdfDoc, {
    pdfLib: { PDFWriter: { forContext: () => writer } }, now: () => time,
  });
  expect(waits).toEqual([false, true, false, false, true, false, false, true, false, false]);
  expect(diagnostics.yieldCount).toBe(3);
});

test('unsupported library uses unchanged save options', async () => {
  const doc = { save: jest.fn(async () => new Uint8Array([1])) };
  const result = await savePdfWithTimeBudget(doc, { pdfLib: {} });
  expect(doc.save).toHaveBeenCalledWith({ useObjectStreams: false, updateFieldAppearances: false });
  expect(result.diagnostics.mode).toBe('compatible-save');
});

test('write failure is not retried, avoiding another big buffer allocation', async () => {
  const doc = {
    getPageCount: () => 1, flush: async () => {}, save: jest.fn(),
    context: { enumerateIndirectObjects: () => [] },
  };
  await expect(savePdfWithTimeBudget(doc, { pdfLib: { PDFWriter: { forContext: () => ({
    shouldWaitForTick: () => false,
    serializeToBuffer: async () => { throw new Error('allocation failed'); },
  }) } } })).rejects.toThrow('allocation failed');
  expect(doc.save).not.toHaveBeenCalled();
});
