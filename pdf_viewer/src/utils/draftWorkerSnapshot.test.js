import fs from 'fs';
import path from 'path';
import vm from 'vm';

const makeWorker = () => {
  const replies = [], bodies = [];
  const context = {self: {postMessage: reply => replies.push(reply)}, Map, Set, Promise, JSON, Number,
    String, Math, Date, Array, Object, Error, AbortController: class {signal = {}; abort() {}}, setTimeout, clearTimeout,
    fetch: jest.fn(async (url, options) => {bodies.push(JSON.parse(options.body)); return {ok: true, status: 200, text: async () => '{"success":true}'};})};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'public/annotation-draft-worker.js'), 'utf8'), context);
  return {context, replies, bodies, send: async draft => context.self.onmessage({data: {requestId: String(replies.length), type: 'save-cloud', userKey: 'u', apiUrl: '/mock', draft}})};
};
test('cloud worker reconstructs complete snapshots, preserves order and retains omitted metadata', async () => {
  const w = makeWorker();
  await w.send({fileInfo: {fingerprint: 'a'}, resetPageSnapshot: true, annotationPages: [1, 2],
    annotationPageUpdates: [{page: 1, annotations: [{id: 'a', page: 1}]}, {page: 2, annotations: [{id: 'b', page: 2}]}],
    annotationOrder: ['b', 'a'], batchSequenceState: {saved: true}});
  await w.send({fileInfo: {fingerprint: 'a'}, annotationPages: [1, 2], annotationOrder: ['b', 'a'],
    annotationPageUpdates: [{page: 1, annotations: [{id: 'a', page: 1, endX: 99}]}]});
  expect(w.bodies[1].annotations).toEqual([{id: 'b', page: 2}, {id: 'a', page: 1, endX: 99}]);
  expect(w.bodies[1].batchSequenceState).toEqual({saved: true});
  expect(w.bodies[1].annotationPageUpdates).toBeUndefined();
  await w.send({fileInfo: {fingerprint: 'a'}, annotationPages: [1], annotationPageUpdates: [{page: 2, annotations: []}]});
  expect(w.bodies[2].annotations).toHaveLength(1);
});
test('missing pages reject before POST and a new document discards old pages', async () => {
  const w = makeWorker();
  await w.send({fileName: 'a', resetPageSnapshot: true, annotationPages: [1], annotationPageUpdates: []});
  expect(w.replies[0].ok).toBe(false); expect(w.bodies).toHaveLength(0);
  await w.send({fileName: 'b', resetPageSnapshot: true, annotationPages: [2], annotationPageUpdates: [{page: 2, annotations: [{id: 2, page: 2}]}]});
  expect(w.bodies[0].annotations).toEqual([{id: 2, page: 2}]);
});
test('HTML and unsuccessful JSON acknowledgements are rejected, retry still sends complete snapshot', async () => {
  const w = makeWorker();
  const draft = {fileName: 'a', resetPageSnapshot: true, annotationPages: [1], annotationPageUpdates: [{page: 1, annotations: [{id: 1, page: 1}]}]};
  w.context.fetch.mockResolvedValueOnce({ok: true, status: 200, text: async () => '<html>proxy</html>'});
  await w.send(draft); expect(w.replies[0].ok).toBe(false);
  w.context.fetch.mockResolvedValueOnce({ok: true, status: 200, text: async () => '{"success":false}'});
  await w.send(draft); expect(w.replies[1].ok).toBe(false);
  await w.send(draft); expect(w.replies[2].ok).toBe(true);
  expect(w.bodies[0].annotations).toEqual([{id: 1, page: 1}]);
});
