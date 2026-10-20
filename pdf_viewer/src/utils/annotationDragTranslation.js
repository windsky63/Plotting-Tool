const positionKeys = new Set(['startX', 'startY', 'endX', 'endY']);
const close = (a, b) => Math.abs(a - b) < 1e-7;

// A rigid move can reuse the already painted SVG. Changes to endpoints only,
// content, styles, selection membership or ordering require a fresh render.
export const getAnnotationDragTranslation = (baseline, next) => {
  if (!baseline?.length || baseline.length !== next.length) return null;
  const dx = next[0].endX - baseline[0].endX;
  const dy = next[0].endY - baseline[0].endY;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  for (let i = 0; i < baseline.length; i += 1) {
    const before = baseline[i];
    const after = next[i];
    for (const key of positionKeys) {
      const delta = after[key] - before[key];
      if (!Number.isFinite(delta) || !close(delta, key.endsWith('X') ? dx : dy)) return null;
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (!positionKeys.has(key) && before[key] !== after[key]) return null;
    }
  }
  return { dx, dy };
};

export const getAnnotationFrameDragTranslation = (baseline, next) => {
  if (!baseline?.length || baseline.length !== next?.length) return null;
  const dx = next[0].endX - baseline[0].endX, dy = next[0].endY - baseline[0].endY;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  for (let i = 0; i < baseline.length; i++) {
    const before = baseline[i], after = next[i];
    if (!before.hasLeaderLine || before.startX !== after.startX || before.startY !== after.startY ||
        !close(after.endX - before.endX, dx) || !close(after.endY - before.endY, dy)) return null;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!positionKeys.has(key) && before[key] !== after[key]) return null;
    }
  }
  return { dx, dy };
};
