import { buildBatchFontUpdates } from './batchAnnotationFont';
import { selectAppearanceTargets } from './batchAnnotationAppearance';
const annotations = [
  ...['a', 'b', 'c'].map(id => ({ id, type: 'text', page: 1, borderShape: 'circle', text: 'F1' })),
  { id: 'd', type: 'text', page: 2, borderShape: 'split-circle' },
  { id: 'e', type: 'text', page: 2, borderShape: 'rectangle' }
];
const a3 = { width: 420 * 72 / 25.4, height: 297 * 72 / 25.4 };
const document = { getPage: async page => ({ getViewport: () => page === 1
  ? { width: a3.width * 2, height: a3.height * 2 } : a3 }) };
const build = targets => buildBatchFontUpdates({ targets, regularSize: 34, topSize: 16, bottomSize: 34, pdfDocument: document });
test('three circles receive the same page-scaled sizes from current, selected, multi-page and all scopes', async () => {
  const expected = { a: { fontSize: 68 }, b: { fontSize: 68 }, c: { fontSize: 68 } };
  for (const scope of ['current', 'selected', 'pages', 'all']) {
    const targets = selectAppearanceTargets({ annotations, scope, currentPage: 1, selectedIds: ['a', 'b', 'c'],
      pageRange: '1-2', totalPages: 2 });
    const updates = await build(targets);
    expect({ a: updates.a, b: updates.b, c: updates.c }).toEqual(expected);
  }
});
test('split-circle and square fonts share the same scale convention and do not modify frames or text', async () => {
  expect(await build(annotations.slice(3))).toEqual({ d: { topFontSize: 16, bottomFontSize: 34 }, e: { fontSize: 34 } });
});
test('already matching sizes do not create redundant patches', async () => {
  expect(await build([{ ...annotations[0], fontSize: 68 }])).toEqual({});
});
test.each([0, null, NaN, 97])('rejects invalid font size %s', async regularSize => {
  await expect(buildBatchFontUpdates({ targets: [annotations[0]], regularSize, pdfDocument: document })).rejects.toThrow();
});
test('page-load failure prevents any font update result', async () => {
  await expect(buildBatchFontUpdates({ targets: annotations, regularSize: 34, topSize: 16, bottomSize: 34,
    pdfDocument: { getPage: async () => { throw new Error('failed'); } } })).rejects.toThrow('failed');
});
