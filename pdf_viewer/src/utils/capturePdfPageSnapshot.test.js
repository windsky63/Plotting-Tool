import { capturePdfPageSnapshot } from './capturePdfPageSnapshot';
import { getAnnotationPageSizeFromSnapshot } from './pageAnnotationScale';

const setup = () => {
  let complete;
  const canvas = {
    width: 2400, height: 1600, clientWidth: 1200, clientHeight: 800,
    dataset: { pdfSnapshotScale: '0.5' },
    toBlob: jest.fn(callback => { complete = callback; })
  };
  const onSnapshot = jest.fn(), onDiscard = jest.fn();
  const options = { canvas, onSnapshot, onDiscard, isCurrent: () => true };
  return { canvas, options, onSnapshot, onDiscard, complete: blob => complete(blob) };
};

test('zoom during PNG encoding preserves bitmap geometry for display and reopening', () => {
  const run = setup();
  expect(capturePdfPageSnapshot(run.options)).toBe('pending');
  // A new Canvas render finishes while the old PNG callback is still queued.
  run.canvas.dataset.pdfSnapshotScale = '1';
  run.canvas.clientWidth = 2400;
  run.canvas.clientHeight = 1600;
  run.complete(new Blob(['png']));
  const snapshot = run.onSnapshot.mock.calls[0][0];
  expect(snapshot).toMatchObject({ cssWidth: 1200, cssHeight: 800, snapshotScale: 0.5 });
  // The persisted record must recover the same fixed 2x PDF coordinates.
  const reopened = getAnnotationPageSizeFromSnapshot(snapshot);
  expect(reopened.width).toBe(2400);
  expect(reopened.height).toBe(1600);
  expect(snapshot.cssWidth / snapshot.snapshotScale).toBe(reopened.width);
});

test('a PNG callback from a replaced document cannot install or persist its bitmap', () => {
  const run = setup();
  let generation = 1;
  const captured = generation;
  capturePdfPageSnapshot({ ...run.options, isCurrent: () => generation === captured });
  generation++;
  run.complete(new Blob(['old document']));
  expect(run.onSnapshot).not.toHaveBeenCalled();
  expect(run.onDiscard).toHaveBeenCalledTimes(1);
});

test('an incomplete Canvas cannot supply a guessed snapshot scale', () => {
  const run = setup();
  delete run.canvas.dataset.pdfSnapshotScale;
  expect(capturePdfPageSnapshot(run.options)).toBe('unavailable');
  expect(run.canvas.toBlob).not.toHaveBeenCalled();
});

test('failed PNG encoding releases the pending snapshot', () => {
  const run = setup();
  capturePdfPageSnapshot(run.options);
  run.complete(null);
  expect(run.onDiscard).toHaveBeenCalledTimes(1);
  expect(run.onSnapshot).not.toHaveBeenCalled();
});
