import { createPageAnnotationIndex } from './pageAnnotationIndex';
import { collectChangedAnnotationPages, acknowledgeCheckpointPages } from './annotationCheckpoint';
import { prepareDraftPageTransfer } from './draftPageTransfer';
import { PageVectorStore } from './pageVectorStore';
import { createAnchoredAnnotationPreview } from './anchoredAnnotationPreview';

test('batch insertion, move, deletion and undo all identify affected pages', () => {
  const initial = createPageAnnotationIndex([]);
  const annotations = Array.from({length: 30}, (_, i) => ({id: i, page: i + 1}));
  const batch = createPageAnnotationIndex(annotations, initial);
  expect(collectChangedAnnotationPages(initial, batch)).toHaveLength(30);
  const moved = createPageAnnotationIndex(annotations.map(a => a.id === 4 ? {...a, page: 6} : a), batch);
  expect(collectChangedAnnotationPages(batch, moved)).toEqual([5, 6]);
  const deleted = createPageAnnotationIndex(annotations.slice(1), batch);
  expect(collectChangedAnnotationPages(batch, deleted)).toEqual([1]);
  expect(collectChangedAnnotationPages(deleted, batch)).toEqual([1]);
});

test('checkpoint acknowledgement preserves changes made during the save', () => {
  const pending = new Map([[1, 2], [2, 3], [3, 1]]);
  acknowledgeCheckpointPages(pending, new Map([[1, 1], [2, 3]]));
  expect(Array.from(pending)).toEqual([[1, 2], [3, 1]]);
});

test('5000 annotations transfer only the changed page after first acknowledgement', () => {
  const annotations = Array.from({length: 5000}, (_, i) => ({id: i, page: Math.floor(i / 100) + 1}));
  const index = createPageAnnotationIndex(annotations);
  const sequence = {welds: annotations};
  const draft = {fileInfo: {fingerprint: 'pdf-a'}, annotations, batchSequenceState: sequence, __pageIndex: index};
  // App supplies this index as a non-enumerable property.
  Object.defineProperty(draft, '__pageIndex', {value: index, enumerable: false});
  const first = prepareDraftPageTransfer(draft);
  const nextAnnotations = annotations.map(a => a.id === 1 ? {...a, endX: 20} : a);
  const next = {...draft, annotations: nextAnnotations};
  Object.defineProperty(next, '__pageIndex', {value: createPageAnnotationIndex(nextAnnotations, index)});
  const delta = prepareDraftPageTransfer(next, first.next);
  expect(delta.payload.annotationPageUpdates).toHaveLength(1);
  expect(delta.payload.annotationPageUpdates[0].annotations).toHaveLength(100);
  expect(delta.payload.annotations).toBeUndefined();
  expect(delta.payload.__pageIndex).toBeUndefined();
  expect(delta.payload.batchSequenceState).toBeUndefined();
  expect(delta.payload.annotationOrder).toEqual(annotations.map(a => a.id));
  expect(prepareDraftPageTransfer({...draft, fileInfo: {fingerprint: 'pdf-b'}}, first.next).payload.resetPageSnapshot).toBe(true);
});

test('deleting the last annotation of a page sends a tombstone', () => {
  const first = prepareDraftPageTransfer({fileName: 'x', annotations: [{id: 1, page: 1}]});
  const next = prepareDraftPageTransfer({fileName: 'x', annotations: []}, first.next);
  expect(next.payload.annotationPageUpdates).toEqual([{page: 1, annotations: []}]);
  expect(next.payload.annotationPages).toEqual([]);
});

const memoryDisk = () => {
  const entries = new Map();
  return {write: async (key, value) => entries.set(key, value), read: async key => entries.get(key)};
};
test('60 extracted pages remain complete on disk with at most five resident pages', async () => {
  const cache = new PageVectorStore({storage: memoryDisk()}); cache.activate('pdf');
  for (let page = 1; page <= 60; page++) await cache.set(page, [{page, x: page * 10}]);
  expect(cache.getStats().residentPages).toBe(5);
  expect(cache.getStats().knownPages).toBe(60);
  expect(await cache.get(1)).toEqual([{page: 1, x: 10}]);
  expect(cache.getStats().residentPages).toBe(5);
  expect(cache.getSummary()[60].vectorCount).toBe(1);
});
test('byte budget evicts pages and disk failure can rebuild from the source', async () => {
  const cache = new PageVectorStore({storage: memoryDisk(), maxBytes: 500}); cache.activate('a');
  await cache.set(1, [{text: 'x'.repeat(200)}]); await cache.set(2, [{text: 'y'.repeat(200)}]);
  expect(cache.getStats().residentPages).toBe(1);
  const recoverable = new PageVectorStore({storage: {read: async () => {throw Error('quota');}, write: async () => {throw Error('quota');}}, maxPages: 1, rebuild: async page => [{page}]});
  recoverable.activate('a'); await recoverable.set(1, [{page: 1}]); await recoverable.set(2, [{page: 2}]);
  expect(await recoverable.get(1)).toEqual([{page: 1}]);
});
test('late disk reads cannot pollute a different document', async () => {
  let finish;
  const cache = new PageVectorStore({storage: {read: () => new Promise(resolve => {finish = resolve;})}});
  cache.activate('a'); const pending = cache.get(1); cache.activate('b'); finish([{page: 1}]);
  await expect(pending).rejects.toThrow(); expect(cache.getStats().residentPages).toBe(0);
});

test('120 anchored drag frames preserve start, move body and restore the original DOM', () => {
  document.body.innerHTML = '<svg viewBox="0 0 120 120"><line x1="10" y1="10" x2="90" y2="90"/><circle cx="10" cy="10" r="2"/><circle cx="100" cy="100" r="10"/><text x="100" y="100">F1</text></svg>';
  const svg = document.querySelector('svg'), original = svg.outerHTML;
  const base = {startX: 10, startY: 10, endX: 100, endY: 100};
  const preview = createAnchoredAnnotationPreview(svg, base, a => ({connectionX: a.endX - 10, connectionY: a.endY - 10}));
  for(let i = 1; i <= 120; i++) expect(preview.update({...base, endX: 100 + i, endY: 100 + i})).toBe(true);
  expect(svg.querySelector('line').getAttribute('x1')).toBe('10');
  expect(svg.querySelector('line').getAttribute('x2')).toBe('210');
  expect(svg.querySelector('text').getAttribute('transform')).toBe('translate(120 120)');
  preview.restore(); expect(svg.outerHTML).toBe(original);
});
