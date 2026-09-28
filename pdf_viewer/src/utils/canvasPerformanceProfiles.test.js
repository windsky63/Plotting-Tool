import {
  CANVAS_PERFORMANCE_MODES,
  getCanvasDevicePixelRatio,
  getCanvasPerformanceProfile,
  normalizeCanvasPerformanceMode
} from './canvasPerformanceProfiles';

test('unknown and legacy automatic settings fall back to smooth mode', () => {
  expect(CANVAS_PERFORMANCE_MODES.AUTO).toBeUndefined();
  expect(normalizeCanvasPerformanceMode('unsafe')).toBe(CANVAS_PERFORMANCE_MODES.SMOOTH);
  expect(normalizeCanvasPerformanceMode('auto')).toBe(CANVAS_PERFORMANCE_MODES.SMOOTH);

  const profile = getCanvasPerformanceProfile('auto');
  expect(profile.mode).toBe(CANVAS_PERFORMANCE_MODES.SMOOTH);
  expect(profile.maxCanvasPixels).toBe(1_500_000);
});

test('smooth mode never inherits a high display DPR directly', () => {
  const profile = getCanvasPerformanceProfile('smooth');
  expect(getCanvasDevicePixelRatio({
    profile,
    renderScale: 2,
    basePagePixels: 2_000_000,
    nativeDevicePixelRatio: 2
  })).toBeLessThan(0.5);
});

test('smooth mode keeps a 500% drawing inside its 1.5 megapixel budget', () => {
  const profile = getCanvasPerformanceProfile('smooth');
  const ratio = getCanvasDevicePixelRatio({
    profile,
    renderScale: 10,
    basePagePixels: 2_000_000,
    nativeDevicePixelRatio: 2
  });
  expect(2_000_000 * 100 * ratio * ratio).toBeLessThanOrEqual(profile.maxCanvasPixels + 1);
});

test('smooth mode caps a common large drawing at 1.5 megapixels', () => {
  const profile = getCanvasPerformanceProfile('smooth');
  const ratio = getCanvasDevicePixelRatio({
    basePagePixels: 2_000_000,
    renderScale: 2,
    nativeDevicePixelRatio: 1,
    profile
  });

  expect(2_000_000 * 4 * ratio * ratio).toBeLessThanOrEqual(1_500_001);
});

test('pixel budget dynamically reduces DPR at high zoom', () => {
  const profile = getCanvasPerformanceProfile('balanced');
  const ratio = getCanvasDevicePixelRatio({
    profile,
    renderScale: 6,
    basePagePixels: 2_000_000,
    nativeDevicePixelRatio: 2
  });
  expect(2_000_000 * 36 * ratio * ratio).toBeLessThanOrEqual(profile.maxCanvasPixels + 1);
});

test('even quality mode has a hard ceiling', () => {
  const profile = getCanvasPerformanceProfile('quality');
  const ratio = getCanvasDevicePixelRatio({
    profile,
    renderScale: 10,
    basePagePixels: 2_000_000,
    nativeDevicePixelRatio: 2
  });
  expect(ratio).toBeLessThan(0.5);
  expect(2_000_000 * 100 * ratio * ratio).toBeLessThanOrEqual(profile.maxCanvasPixels + 1);
});
