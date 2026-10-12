import { buildAppearanceUpdates, parseAppearancePages, selectAppearanceTargets } from './batchAnnotationAppearance';
import { getFixedA3TenMmFrameSize } from './pageAnnotationScale';

const annotations = [
  { id: 'a', type: 'text', page: 1, borderShape: 'circle', color: '#ff0000', frameSize: 100, text: 'F1', weldData: { weldNumber: 1 } },
  { id: 'b', type: 'text', page: 2, borderShape: 'circle', color: '#ff0000' },
  { id: 'c', type: 'text', page: 3, borderShape: 'rectangle', color: '#0000ff', frameSize: 84 },
  { id: 'd', type: 'arrow', page: 1, color: '#ff0000' },
  { id: 'e', type: 'text', page: 1, borderShape: 'split-circle', fontSize: 40 }
];
const targets = options => selectAppearanceTargets({ annotations, currentPage: 1, totalPages: 5, ...options });

test('page ranges support lists, inclusive ranges and duplicates', () => {
  expect([...parseAppearancePages('1，3-5, 3', 5)]).toEqual([1, 3, 4, 5]);
});
test.each(['', '0', '6', '3-2', '1-x', '1.5', '-2'])('rejects invalid page range %s', value => {
  expect(() => parseAppearancePages(value, 5)).toThrow();
});
test('current page scope does not silently follow selection or include arrows', () => {
  expect(targets({ scope: 'current', selectedIds: ['b'] }).map(a => a.id)).toEqual(['a', 'e']);
});
test('selected scope is limited to selected annotations on the current page', () => {
  expect(targets({ scope: 'selected', selectedIds: ['a', 'b'] }).map(a => a.id)).toEqual(['a']);
  expect(targets({ scope: 'selected', selectedIds: [] })).toEqual([]);
});
test('multiple page scope and source shape filter work together', () => {
  expect(targets({ scope: 'pages', pageRange: '2-3', sourceShape: 'circle' }).map(a => a.id)).toEqual(['b']);
  expect(targets({ scope: 'all' }).map(a => a.id)).toEqual(['a', 'b', 'c', 'e']);
});
test('color-only changes preserve shape, size, text and weld metadata', async () => {
  const snapshot = JSON.stringify(annotations);
  expect(await buildAppearanceUpdates({ targets: [annotations[0]], color: '#0000ff' })).toEqual({ a: { color: '#0000ff' } });
  expect(JSON.stringify(annotations)).toBe(snapshot);
});
test('red circles become blue squares with their actual page-dependent size', async () => {
  const dimensions = [{ width: 1190, height: 842 }, { width: 2380, height: 1684 }];
  const pdfDocument = { getPage: jest.fn(async page => ({ getViewport: () => dimensions[page - 1] })) };
  const updates = await buildAppearanceUpdates({ targets: annotations.slice(0, 2), shape: 'rectangle', color: '#0000ff', pdfDocument });
  expect(updates.a).toEqual({ borderShape: 'rectangle', color: '#0000ff', frameSize: getFixedA3TenMmFrameSize(dimensions[0]) });
  expect(updates.b.frameSize).toBeCloseTo(updates.a.frameSize * 2);
  expect(pdfDocument.getPage).toHaveBeenCalledTimes(2);
  expect(updates.a.text).toBeUndefined();
  expect(updates.a.weldData).toBeUndefined();
});
test('requires page dimensions before freezing an automatic frame size', async () => {
  await expect(buildAppearanceUpdates({ targets: [annotations[0]], shape: 'rectangle' })).rejects.toThrow('页面尺寸');
});
test('restores text rectangle fitting and leaves its content intact', async () => {
  expect(await buildAppearanceUpdates({ targets: [annotations[0]], shape: 'text-rectangle' }))
    .toEqual({ a: { borderShape: 'text-rectangle', frameSize: 56.7 } });
});
test('conversion to split circles initializes fonts but preserves existing split fonts', async () => {
  expect(await buildAppearanceUpdates({ targets: [annotations[2]], shape: 'split-circle' }))
    .toEqual({ c: { borderShape: 'split-circle', topFontSize: 16, bottomFontSize: 34 } });
  expect(await buildAppearanceUpdates({ targets: [annotations[4]], shape: 'split-circle' })).toEqual({});
});
test('same appearance creates no undo command patches', async () => {
  expect(await buildAppearanceUpdates({ targets: [annotations[2]], shape: 'rectangle', color: '#0000FF' })).toEqual({});
});
test('rejects unsupported appearance values', async () => {
  await expect(buildAppearanceUpdates({ targets: [], shape: 'bad' })).rejects.toThrow();
  await expect(buildAppearanceUpdates({ targets: [], color: 'blue' })).rejects.toThrow();
});
