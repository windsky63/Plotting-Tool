import {saveLocalAnnotationDraftOffMainThread, releaseIdleDraftWorker, disposeAnnotationDraftWorker} from './annotationDraftPersistenceWorker';
import {createPageAnnotationIndex} from './pageAnnotationIndex';

const originalWorker = window.Worker;
let workers;
beforeEach(() => {
  jest.useFakeTimers(); workers = [];
  window.Worker = class {
    constructor() {this.postMessage = jest.fn(); this.terminate = jest.fn(); workers.push(this);}
  };
});
afterEach(() => {disposeAnnotationDraftWorker(); releaseIdleDraftWorker(); window.Worker = originalWorker; jest.useRealTimers();});
const indexes = new WeakMap();
const draft = annotations => {
  const value = {fileInfo: {fingerprint: 'same'}, annotations, annotationCount: annotations.length};
  if (!indexes.has(annotations)) indexes.set(annotations, createPageAnnotationIndex(annotations));
  Object.defineProperty(value, '__pageIndex', {value: indexes.get(annotations)});
  return value;
};
const save = data => {const pending = saveLocalAnnotationDraftOffMainThread(data); pending.catch(() => {}); return pending;};
const ack = worker => worker.onmessage({data: {requestId: worker.postMessage.mock.calls.slice(-1)[0][0].requestId,
  ok: true, result: {annotationCount: 2}}});

test('document switching waits for a confirmed save, then releases clones and fully resyncs on next save', async () => {
  const annotations = [{id: 1, page: 1}, {id: 2, page: 2}];
  const saving = save(draft(annotations));
  expect(releaseIdleDraftWorker()).toBe(false);
  expect(workers[0].terminate).not.toHaveBeenCalled();
  ack(workers[0]); await expect(saving).resolves.toMatchObject({annotationCount: 2});
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  const next = save(draft(annotations));
  const payload = workers[1].postMessage.mock.calls[0][0].draft;
  expect(payload.resetPageSnapshot).toBe(true);
  expect(payload.annotationPageUpdates).toHaveLength(2);
  ack(workers[1]); await next;
});
test('idle cleanup restarts its deadline when more edits arrive', async () => {
  const annotations = [{id: 1, page: 1}, {id: 2, page: 2}];
  const first = save(draft(annotations)); ack(workers[0]); await first;
  jest.advanceTimersByTime(100000);
  const second = save(draft(annotations));
  expect(workers).toHaveLength(1);
  expect(workers[0].postMessage.mock.calls.slice(-1)[0][0].draft.annotationPageUpdates).toHaveLength(0);
  ack(workers[0]); await second;
  jest.advanceTimersByTime(30000); expect(workers[0].terminate).not.toHaveBeenCalled();
  jest.advanceTimersByTime(90000); expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});
test('a timed out request is still protected until the worker finishes writing', async () => {
  const saving = save(draft([{id: 1, page: 1}]));
  const rejected = expect(saving).rejects.toThrow('超时');
  jest.advanceTimersByTime(15000); await rejected;
  expect(releaseIdleDraftWorker()).toBe(false);
  expect(workers[0].terminate).not.toHaveBeenCalled();
  ack(workers[0]); expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});
