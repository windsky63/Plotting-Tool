import {TextEncoder, TextDecoder} from 'util';
import * as pdfLib from 'pdf-lib';
import {createPdfMetadataWorker} from '../workers/createPdfMetadataWorker';
import {readPdfMetadata, cancelPdfMetadataRead} from './pdfMetadataReader';
import {parsePdfMetadataPayload} from './pdfMetadataPayload';

jest.mock('../workers/createPdfMetadataWorker', () => ({createPdfMetadataWorker: jest.fn()}));
global.TextEncoder = TextEncoder; global.TextDecoder = TextDecoder;
const originalWorker = global.Worker;
let workers;
beforeEach(() => {
  workers = [];
  global.Worker = jest.fn();
  createPdfMetadataWorker.mockImplementation(() => {
    const worker = {postMessage: jest.fn(), terminate: jest.fn()}; workers.push(worker); return worker;
  });
});
afterEach(() => {global.Worker = originalWorker; jest.useRealTimers();});
test('worker completion returns editable data and terminates the PDF parser immediately', async () => {
  const file = new File(['fixture'], 'sample.pdf');
  const result = readPdfMetadata(file);
  const worker = workers[0];
  expect(worker.postMessage).toHaveBeenCalledWith({file});
  const payload = {annotationData: {annotations: [{id: 'a', page: 1}]}};
  worker.onmessage({data: {ok: true, result: payload}});
  await expect(result).resolves.toBe(payload);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(worker.onmessage).toBeNull();
  expect(window.__luotuPdfMetadataRead).toMatchObject({running: false, terminated: true});
});
test('opening another file cancels the old read and releases its worker', async () => {
  const first = readPdfMetadata(new File(['one'], 'one.pdf'));
  const rejected = expect(first).rejects.toMatchObject({name: 'AbortError'});
  const second = readPdfMetadata(new File(['two'], 'two.pdf'));
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  workers[1].onmessage({data: {ok: true, result: {annotationData: null}}});
  await rejected; await second;
});
test.each(['onerror', 'onmessageerror'])('%s releases the failed worker and permits a later read', async event => {
  const first = readPdfMetadata(new File(['one'], 'one.pdf'));
  workers[0][event]();
  await expect(first).rejects.toThrow();
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  const second = readPdfMetadata(new File(['two'], 'two.pdf'));
  workers[1].onmessage({data: {ok: true, result: {annotationData: null}}});
  await second;
});
test('a stuck parser times out without retaining a worker', async () => {
  jest.useFakeTimers();
  const pending = readPdfMetadata(new File(['one'], 'one.pdf'));
  const rejected = expect(pending).rejects.toThrow('超时');
  jest.advanceTimersByTime(180000); await rejected;
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  cancelPdfMetadataRead();
});
test('the parser returns current inline edits instead of an old attachment and no PDF object graph', async () => {
  const doc = await pdfLib.PDFDocument.create(); doc.addPage();
  const stream = doc.context.register(doc.context.flateStream(JSON.stringify({annotations: [{id: 'old', page: 1}]})));
  const spec = doc.context.register(doc.context.obj({Type: pdfLib.PDFName.of('Filespec'), F: pdfLib.PDFString.of('annotations.json'), EF: {F: stream}}));
  doc.catalog.set(pdfLib.PDFName.of('Names'), doc.context.obj({EmbeddedFiles: {Names: [pdfLib.PDFString.of('annotations.json'), spec]}}));
  doc.setKeywords([`ANNOTATION_DATA:PDF标注查看器:1.0:${JSON.stringify({version: 1, annotations: [{id: 'new', page: 1}]})}`]);
  const payload = await parsePdfMetadataPayload(await doc.save(), pdfLib);
  expect(payload.annotationData.annotations).toEqual([{id: 'new', page: 1}]);
  expect(payload.loadMethod).toBe('keywords');
  expect(Object.keys(payload).sort()).toEqual(['annotationData', 'hasImageAnnotations', 'keywordString', 'loadMethod']);
});
test('the original parser remains available when browser workers are unavailable', async () => {
  global.Worker = undefined;
  const doc = await pdfLib.PDFDocument.create(); doc.addPage();
  doc.setKeywords([`ANNOTATION_DATA:PDF标注查看器:1.0:${JSON.stringify({version: 1, annotations: [{id: 'fallback', page: 1}]})}`]);
  const bytes = await doc.save();
  const file = new File(['fixture'], 'sample.pdf');
  file.arrayBuffer = async () => bytes;
  const previousLib = window.PDFLib; window.PDFLib = pdfLib;
  try {expect((await readPdfMetadata(file)).annotationData.annotations[0].id).toBe('fallback');}
  finally {window.PDFLib = previousLib;}
});
