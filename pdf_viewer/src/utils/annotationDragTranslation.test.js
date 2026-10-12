import { getAnnotationDragTranslation } from './annotationDragTranslation';
const baseline = [
  { id: 'a', text: 'F1', color: '#ff0000', startX: 10, startY: 20, endX: 30, endY: 40 },
  { id: 'b', text: 'F2', color: '#0000ff', startX: 50, startY: 60, endX: 70, endY: 80 }
];
const moved = () => baseline.map(a => ({ ...a, startX: a.startX + 5, startY: a.startY - 2,
  endX: a.endX + 5, endY: a.endY - 2 }));
test('recognizes a shared translation of multiple annotations', () => {
  expect(getAnnotationDragTranslation(baseline, moved())).toEqual({ dx: 5, dy: -2 });
});
test.each(['startX', 'text', 'color', 'id'])('rejects nonrigid or visual changes to %s', key => {
  const next = moved(); next[0][key] = key === 'startX' ? 10 : 'changed';
  expect(getAnnotationDragTranslation(baseline, next)).toBeNull();
});
test('selection changes and invalid coordinates cannot reuse the previous SVG', () => {
  expect(getAnnotationDragTranslation(baseline, moved().slice(0, 1))).toBeNull();
  const next = moved(); next[1].endX = NaN;
  expect(getAnnotationDragTranslation(baseline, next)).toBeNull();
  expect(getAnnotationDragTranslation([], [])).toBeNull();
});
