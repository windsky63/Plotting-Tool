export const CANVAS_PERFORMANCE_STORAGE_KEY = 'luotu:canvas-performance-mode';

export const CANVAS_PERFORMANCE_MODES = Object.freeze({
  SMOOTH: 'smooth',
  BALANCED: 'balanced',
  QUALITY: 'quality'
});

export const CANVAS_PERFORMANCE_OPTIONS = Object.freeze([
  { value: CANVAS_PERFORMANCE_MODES.SMOOTH, label: '流畅' },
  { value: CANVAS_PERFORMANCE_MODES.BALANCED, label: '均衡' },
  { value: CANVAS_PERFORMANCE_MODES.QUALITY, label: '高清' }
]);

export const normalizeCanvasPerformanceMode = mode => (
  CANVAS_PERFORMANCE_OPTIONS.some(option => option.value === mode)
    ? mode
    : CANVAS_PERFORMANCE_MODES.SMOOTH
);

export const getCanvasPerformanceProfile = mode => {
  const normalizedMode = normalizeCanvasPerformanceMode(mode);
  const common = { mode: normalizedMode };

  if (normalizedMode === CANVAS_PERFORMANCE_MODES.SMOOTH) {
    return {
      ...common,
      maxCanvasPixels: 1_500_000,
      maxOutputScale: 1.5,
      maxDevicePixelRatio: 0.75,
      snapshotMaxPixels: 1_500_000,
      snapshotMaxEntries: 1,
      snapshotLimitBytes: 32 * 1024 * 1024
    };
  }
  if (normalizedMode === CANVAS_PERFORMANCE_MODES.BALANCED) {
    return {
      ...common,
      maxCanvasPixels: 12 * 1024 * 1024,
      maxOutputScale: 2.5,
      maxDevicePixelRatio: 1.25,
      snapshotMaxPixels: 5 * 1024 * 1024,
      snapshotMaxEntries: 2,
      snapshotLimitBytes: 64 * 1024 * 1024
    };
  }
  if (normalizedMode === CANVAS_PERFORMANCE_MODES.QUALITY) {
    return {
      ...common,
      maxCanvasPixels: 24 * 1024 * 1024,
      maxOutputScale: 3.5,
      maxDevicePixelRatio: 1.5,
      snapshotMaxPixels: 6 * 1024 * 1024,
      snapshotMaxEntries: 3,
      snapshotLimitBytes: 96 * 1024 * 1024
    };
  }

  return {
    ...common,
    maxCanvasPixels: 1_500_000,
    maxOutputScale: 1.5,
    maxDevicePixelRatio: 0.75,
    snapshotMaxPixels: 1_500_000,
    snapshotMaxEntries: 1,
    snapshotLimitBytes: 32 * 1024 * 1024
  };
};

export const getCanvasDevicePixelRatio = ({
  profile,
  renderScale,
  basePagePixels = 0,
  nativeDevicePixelRatio = 1
}) => {
  const safeRenderScale = Math.max(0.01, Number(renderScale) || 1);
  const nativeRatio = Math.max(0.1, Number(nativeDevicePixelRatio) || 1);
  const ratioLimits = [
    nativeRatio,
    Math.max(0.1, Number(profile?.maxDevicePixelRatio) || 1),
    Math.max(0.1, (Number(profile?.maxOutputScale) || 2) / safeRenderScale)
  ];
  const pagePixels = Number(basePagePixels) || 0;
  const pixelBudget = Number(profile?.maxCanvasPixels) || 0;
  if (pagePixels > 0 && pixelBudget > 0) {
    ratioLimits.push(Math.sqrt(pixelBudget / (pagePixels * safeRenderScale * safeRenderScale)));
  }

  // React-PDF accepts fractional output DPR. Keep the result positive without
  // imposing a floor that could exceed the hard pixel budget at high zoom.
  return Math.max(Number.EPSILON, Math.min(...ratioLimits));
};
