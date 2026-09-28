// Yield only around the user's current gesture. A long quiet period meant that
// someone actively annotating all day could prevent the cache from ever
// progressing. One second protects dragging/wheeling without pausing the
// background pipeline for the whole work session.
export const BACKGROUND_CACHE_INTERACTION_QUIET_MS = 1000;

export const getBackgroundCacheDeferral = ({
  paused = false,
  exporting = false,
  now = Date.now(),
  pauseUntil = 0,
  inputPending = false
} = {}) => {
  if (paused || exporting) return { defer: true, delay: 500, reason: paused ? 'paused' : 'exporting' };
  if (Number(pauseUntil) > Number(now)) {
    return {
      defer: true,
      delay: Math.max(250, Math.min(1000, Number(pauseUntil) - Number(now))),
      reason: 'recent-interaction'
    };
  }
  if (inputPending) return { defer: true, delay: 500, reason: 'input-pending' };
  return { defer: false, delay: 0, reason: '' };
};

export const getBackgroundCacheCooldown = ({ workDurationMs = 0, batchBoundary = false } = {}) => {
  const duration = Math.max(0, Number(workDurationMs) || 0);
  const base = batchBoundary ? 3000 : 600;
  if (duration < 750) return base;
  // A slow terminal should get a longer recovery window after each expensive
  // page. This changes only cache throughput, never PDF/OCR/export quality.
  return Math.max(base, Math.min(15000, Math.round(duration * 2)));
};
