import {
  getAnnotationPageSizeFromSnapshot,
  getFixedA3TenMmFrameSize,
  isFixedA3TenMmShape
} from './pageAnnotationScale';

const PDF_POINTS_PER_MM = 72 / 25.4;

const printedMillimetres = (frameSize, pageWidthPt, pageHeightPt) => {
  const printScale = Math.min(
    (420 * PDF_POINTS_PER_MM) / Math.max(pageWidthPt, pageHeightPt),
    (297 * PDF_POINTS_PER_MM) / Math.min(pageWidthPt, pageHeightPt)
  );
  const sourceDiameterPt = frameSize / 2;
  return sourceDiameterPt * printScale / PDF_POINTS_PER_MM;
};

test.each([
  ['A3 landscape', 1190.55, 841.89],
  ['A1 landscape', 2383.94, 1683.78],
  ['A4 portrait', 595.28, 841.89],
  ['long custom page', 3600, 900]
])('%s frame prints as 10 mm on A3', (_name, width, height) => {
  const frameSize = getFixedA3TenMmFrameSize({ width, height });
  expect(printedMillimetres(frameSize, width, height)).toBeCloseTo(10, 8);
});

test('millimetre page dimensions produce the same A3 invariant', () => {
  const frameSize = getFixedA3TenMmFrameSize({ widthMM: 841, heightMM: 594 });
  const widthPt = 841 * PDF_POINTS_PER_MM;
  const heightPt = 594 * PDF_POINTS_PER_MM;
  expect(printedMillimetres(frameSize, widthPt, heightPt)).toBeCloseTo(10, 5);
});

test('server page snapshot restores the same physical page and frame size', () => {
  const widthPt = 1683.78;
  const heightPt = 1190.55;
  const snapshotScale = 0.625;
  const pageSize = getAnnotationPageSizeFromSnapshot({
    width: widthPt * 1.25,
    height: heightPt * 1.25,
    snapshotScale
  });

  expect(pageSize.width).toBeCloseTo(widthPt * 2, 8);
  expect(pageSize.height).toBeCloseTo(heightPt * 2, 8);
  expect(pageSize.widthMM).toBeCloseTo(widthPt / PDF_POINTS_PER_MM, 8);
  expect(getFixedA3TenMmFrameSize(pageSize)).toBeCloseTo(
    getFixedA3TenMmFrameSize({ width: widthPt, height: heightPt }),
    8
  );
});

test('invalid snapshot dimensions do not invent a page size', () => {
  expect(getAnnotationPageSizeFromSnapshot({ width: 0, height: 100, snapshotScale: 0.625 })).toBeNull();
  expect(getAnnotationPageSizeFromSnapshot({ width: 100, height: 100, snapshotScale: 0 })).toBeNull();
});

test.each(['circle', 'split-circle', 'diamond'])(
  '%s is locked to the fixed A3 size',
  shape => expect(isFixedA3TenMmShape(shape)).toBe(true)
);

test.each(['rectangle', 'text-rectangle', 'pipe-tag', 'field-weld', 'shop-weld', 'none'])(
  '%s keeps its existing sizing logic',
  shape => expect(isFixedA3TenMmShape(shape)).toBe(false)
);
