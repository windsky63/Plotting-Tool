import { buildAnnotationMoveTransaction, applyAnnotationMovePatches } from './annotationMoveTransaction';

test('move transaction preserves numbering/content/other pages and supports undo/redo', () => {
  const original = [
    { id: 'a', page: 1, text: 'F12X', pipelineNumber: 'P1', topText: '6BW', frameSize: 57, startX: 1, startY: 2, endX: 3, endY: 4, origin: 'auto' },
    { id: 'b', page: 2, text: 'F13X', startX: 10, startY: 20, endX: 30, endY: 40 },
  ];
  const { before, after } = buildAnnotationMoveTransaction(original, [
    { id: 'a', updates: { startX: 2, startY: 3, endX: 4, endY: 5, text: 'must ignore' } },
  ], a => a.origin === 'auto');
  const moved = applyAnnotationMovePatches(original, after);
  expect(moved[1]).toBe(original[1]);
  expect(moved[0]).toEqual({ ...original[0], startX: 2, startY: 3, endX: 4, endY: 5, qualityModified: true });
  const edited = [{ ...moved[0], topText: '8RR' }, moved[1]];
  const undone = applyAnnotationMovePatches(edited, before);
  expect(undone[0]).toMatchObject({ startX: 1, endX: 3, topText: '8RR', text: 'F12X', frameSize: 57 });
  const redone = applyAnnotationMovePatches(undone, after);
  expect(redone[0]).toMatchObject({ startX: 2, endX: 4, topText: '8RR', qualityModified: true });
  expect(applyAnnotationMovePatches(redone, after)).toBe(redone);
  expect(applyAnnotationMovePatches([original[1]], after)).toEqual([original[1]]);
});

test('no-op, missing, and invalid coordinates do not produce commands', () => {
  const a = { id: 'a', startX: 1, startY: 2, endX: 3, endY: 4 };
  for (const move of [ { id: 'a', updates: a }, { id: 'missing', updates: a }, { id: 'a', updates: { ...a, endX: NaN } } ]) {
    expect(buildAnnotationMoveTransaction([a], [move]).after.size).toBe(0);
  }
});
