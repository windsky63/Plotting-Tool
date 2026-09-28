import {
  BACKGROUND_CACHE_INTERACTION_QUIET_MS,
  getBackgroundCacheCooldown,
  getBackgroundCacheDeferral
} from './backgroundPdfCacheScheduling';

test('foreground interaction owns the main thread for a real quiet period', () => {
  expect(BACKGROUND_CACHE_INTERACTION_QUIET_MS).toBe(1000);
  expect(getBackgroundCacheDeferral({ now: 1000, pauseUntil: 2000 })).toMatchObject({
    defer: true, reason: 'recent-interaction'
  });
  expect(getBackgroundCacheDeferral({ now: 2000, pauseUntil: 2000 }).defer).toBe(false);
});

test('pause, export and pending input always defer background rendering', () => {
  expect(getBackgroundCacheDeferral({ paused: true }).reason).toBe('paused');
  expect(getBackgroundCacheDeferral({ exporting: true }).reason).toBe('exporting');
  expect(getBackgroundCacheDeferral({ inputPending: true }).reason).toBe('input-pending');
});

test('slow page work receives an adaptive recovery interval', () => {
  expect(getBackgroundCacheCooldown({ workDurationMs: 200 })).toBe(600);
  expect(getBackgroundCacheCooldown({ workDurationMs: 2400 })).toBe(4800);
  expect(getBackgroundCacheCooldown({ workDurationMs: 20000 })).toBe(15000);
  expect(getBackgroundCacheCooldown({ workDurationMs: 200, batchBoundary: true })).toBe(3000);
});
