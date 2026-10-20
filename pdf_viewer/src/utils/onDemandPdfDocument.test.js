import {createOnDemandPdfDocument} from './onDemandPdfDocument';

const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
function fixture() {
  const viewport = {width: 600, height: 400, clone: ({scale = 1} = {}) => ({width: 600 * scale, height: 400 * scale})};
  const page = {view: [0, 0, 600, 400], rotate: 0, userUnit: 1, getViewport: () => viewport,
    cleanup: jest.fn(), getTextContent: jest.fn(async () => ({items: ['text']})),
    getOperatorList: jest.fn(async () => ({fnArray: [1]})), render: jest.fn(() => ({promise: Promise.resolve(), cancel: jest.fn()}))};
  const raw = {numPages: 236, getPage: jest.fn(async () => page)};
  const tasks = [];
  const pdfjs = {getDocument: jest.fn(() => {const task = {promise: Promise.resolve(raw), destroy: jest.fn(async () => {})}; tasks.push(task); return task;})};
  const file = new File(['pdf'], 'sample.pdf'); file.arrayBuffer = jest.fn(async () => new ArrayBuffer(3));
  const onReady = jest.fn(), onState = jest.fn();
  const doc = createOnDemandPdfDocument({file, pdfjs, onReady, onState, idleMs: 1000});
  return {doc, pdfjs, file, page, tasks, onReady, onState};
}
afterEach(() => jest.useRealTimers());
test('a cached page count enables viewing without reading the source PDF', async () => {
  const f = fixture(); f.doc.setPageCount(236);
  expect(f.doc.numPages).toBe(236); expect(f.onReady).toHaveBeenCalledWith(f.doc);
  expect(f.file.arrayBuffer).not.toHaveBeenCalled(); expect(f.pdfjs.getDocument).not.toHaveBeenCalled();
  await f.doc.destroy();
});
test('concurrent requests share one buffer and PDF task; retained page handles reload after release', async () => {
  const f = fixture();
  const [page] = await Promise.all([f.doc.getPage(1), f.doc.getPage(2)]);
  expect(f.file.arrayBuffer).toHaveBeenCalledTimes(1);
  expect(f.pdfjs.getDocument.mock.calls[0][0].data).toBeInstanceOf(Uint8Array);
  Object.defineProperty(page, 'width', {get() {return this.getViewport({scale: 2}).width;}});
  expect(page.width).toBe(1200);
  await f.doc.release(); expect(f.tasks[0].destroy).toHaveBeenCalledTimes(1);
  expect(page.getViewport({scale: 1}).width).toBe(600);
  expect(await page.getTextContent()).toEqual({items: ['text']});
  expect(f.file.arrayBuffer).toHaveBeenCalledTimes(2);
  await f.doc.destroy();
});
test('idle release waits for text extraction and rendering to finish', async () => {
  jest.useFakeTimers(); const f = fixture(), gate = deferred();
  const page = await f.doc.getPage(1);
  f.page.getTextContent.mockReturnValue(gate.promise);
  const reading = page.getTextContent();
  jest.advanceTimersByTime(2000);
  expect(await f.doc.release()).toBe(false); expect(f.tasks[0].destroy).not.toHaveBeenCalled();
  gate.resolve({items: []}); await reading;
  const renderGate = deferred(); f.page.render.mockReturnValue({promise: renderGate.promise});
  const rendering = page.render({});
  expect(await f.doc.release()).toBe(false);
  renderGate.resolve(); await rendering.promise;
  jest.advanceTimersByTime(1000); await Promise.resolve();
  expect(f.tasks[0].destroy).toHaveBeenCalledTimes(1);
  await f.doc.destroy();
});
test('switching files during a source read prevents the abandoned PDF from starting', async () => {
  const f = fixture(), gate = deferred(); f.file.arrayBuffer.mockReturnValue(gate.promise);
  f.doc.setPageCount(236);
  const pending = f.doc.ensure(); const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
  await Promise.resolve(); await f.doc.destroy(); gate.resolve(new ArrayBuffer(3)); await rejected;
  expect(f.pdfjs.getDocument).not.toHaveBeenCalled();
  expect(f.doc.numPages).toBe(0);
});
test('a failed load is destroyed and a later request retries', async () => {
  const f = fixture(), destroy = jest.fn(async () => {});
  f.pdfjs.getDocument.mockReturnValueOnce({promise: Promise.reject(Error('broken')), destroy});
  await expect(f.doc.ensure()).rejects.toThrow('broken'); expect(destroy).toHaveBeenCalledTimes(1);
  await expect(f.doc.ensure()).resolves.toBe(236); await f.doc.destroy();
});
test('render cancellation also works before a released document has reloaded', async () => {
  const f = fixture(); const page = await f.doc.getPage(1); await f.doc.release();
  const task = page.render({}); task.cancel();
  await expect(task.promise).rejects.toMatchObject({name: 'RenderingCancelledException'});
  expect(f.page.render).not.toHaveBeenCalled(); await f.doc.destroy();
});
