import { createRemotePageSnapshotRecord, getRemotePageSnapshotScale } from './remotePageSnapshotGeometry';
import { getAnnotationPageSizeFromSnapshot } from './pageAnnotationScale';

test('capped A1 page keeps physical dimensions after prefetch, persistence and reopening', () => {
  const pdfWidth = 2383.94, pdfHeight = 1683.78;
  const renderScale = 1.22234623;
  const pageInfo = {
    width: Math.ceil(pdfWidth * renderScale),
    height: Math.ceil(pdfHeight * renderScale),
    renderScale
  };
  const record = createRemotePageSnapshotRecord({
    key: 'drawing|page:2', scope: 'drawing', pageNumber: 2, pageInfo, blob: new Blob(['png'])
  });
  // IndexedDB read feeds record.scale back into the decoded snapshot.
  const restored = getAnnotationPageSizeFromSnapshot({ ...record, snapshotScale: record.scale });
  expect(record.scale).toBeCloseTo(0.611173115, 9);
  // Raster rounding can change the inferred size by less than one source pixel.
  expect(Math.abs(restored.width / 2 - pdfWidth)).toBeLessThan(1 / renderScale);
  expect(Math.abs(restored.height / 2 - pdfHeight)).toBeLessThan(1 / renderScale);

  // A mark placed on that bitmap must retain its relative pipe position at
  // another zoom, and when exported using the fixed 2x PDF coordinates.
  const pipePdfX = 1913.9368;
  const screenX = pipePdfX * renderScale * (0.8 / record.scale);
  const storedAnnotationX = screenX / 0.8;
  expect(storedAnnotationX / 2).toBeCloseTo(pipePdfX, 7);

  // The previous fixed 0.625 record produced the observed ~2.2% contraction.
  const oldStoredX = pipePdfX * renderScale / 0.625;
  expect((oldStoredX / 2) / pipePdfX).toBeCloseTo(0.977876984, 6);
});

test.each([1.25, 0.61117311, 2])('direct and persisted loaders agree for render scale %s', renderScale => {
  const pageInfo = { width: 1000, height: 800, renderScale };
  const record = createRemotePageSnapshotRecord({ pageInfo, pageNumber: '3', blob: new Blob(['png']) });
  expect(record.scale).toBe(getRemotePageSnapshotScale(pageInfo));
  expect(record.pageNumber).toBe(3);
  expect(record.cssWidth).toBe(1000);
});

test('legacy fixed-scale manifests retain their original geometry', () => {
  expect(getRemotePageSnapshotScale({ width: 2105, height: 1489 })).toBe(0.625);
});
