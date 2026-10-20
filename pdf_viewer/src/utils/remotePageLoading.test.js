import { REMOTE_PAGE_FALLBACK_MS, startRemotePageLoading } from './remotePageLoading';

let options, surface, full, busy, resolvePreview, resolveFull, cancel;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  jest.useFakeTimers(); surface = false; full = false; busy = false;
  options = {
    hasSurface: () => surface, hasFullImage: () => full,
    previewAvailable: true, fullAvailable: true, isBusy: () => busy,
    loadPreview: jest.fn(() => new Promise(resolve => { resolvePreview = resolve; })),
    loadFullImage: jest.fn(() => new Promise(resolve => { resolveFull = resolve; })),
    enableCanvas: jest.fn(),
  };
});
afterEach(() => { cancel?.(); jest.useRealTimers(); });

test('a stalled preview falls back at exactly 700 ms without starting competing full-image work', () => {
  expect(REMOTE_PAGE_FALLBACK_MS).toBe(700);
  cancel = startRemotePageLoading(options);
  jest.advanceTimersByTime(699);
  expect(options.enableCanvas).not.toHaveBeenCalled();
  expect(options.loadFullImage).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(options.enableCanvas).toHaveBeenCalledTimes(1);
  expect(options.loadPreview.mock.calls[0][0].aborted).toBe(true);
  jest.advanceTimersByTime(500);
  expect(options.loadFullImage).not.toHaveBeenCalled();
  surface = true; // Canvas has finished its fallback render.
  jest.advanceTimersByTime(100);
  expect(options.loadFullImage).toHaveBeenCalledTimes(1);
});

test('a decoded preview suppresses Canvas even while the full image is slow', async () => {
  cancel = startRemotePageLoading(options);
  jest.advanceTimersByTime(400);
  surface = true; resolvePreview(true); await flush();
  jest.advanceTimersByTime(100);
  expect(options.loadFullImage).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(2000);
  expect(options.enableCanvas).not.toHaveBeenCalled();
});

test('explicit preview or decoder failure falls back immediately', async () => {
  cancel = startRemotePageLoading(options);
  resolvePreview(false); await flush();
  expect(options.enableCanvas).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(700);
  expect(options.enableCanvas).toHaveBeenCalledTimes(1);
  expect(options.loadFullImage).not.toHaveBeenCalled();
});

test('an existing local image needs no preview fetch or Canvas fallback', () => {
  surface = true; full = true;
  cancel = startRemotePageLoading(options);
  jest.advanceTimersByTime(2000);
  expect(options.loadPreview).not.toHaveBeenCalled();
  expect(options.loadFullImage).not.toHaveBeenCalled();
  expect(options.enableCanvas).not.toHaveBeenCalled();
});

test('full-image-only pages load directly and fall back immediately on failure', async () => {
  options.previewAvailable = false;
  cancel = startRemotePageLoading(options);
  expect(options.loadFullImage).toHaveBeenCalledTimes(1);
  expect(options.loadPreview).not.toHaveBeenCalled();
  resolveFull(false); await flush();
  expect(options.enableCanvas).toHaveBeenCalledTimes(1);
});

test('dragging defers the full-image upgrade until the gesture ends', async () => {
  cancel = startRemotePageLoading(options);
  surface = true; busy = true; resolvePreview(true); await flush();
  jest.advanceTimersByTime(1500);
  expect(options.loadFullImage).not.toHaveBeenCalled();
  expect(options.enableCanvas).not.toHaveBeenCalled();
  busy = false; jest.advanceTimersByTime(100);
  expect(options.loadFullImage).toHaveBeenCalledTimes(1);
});

test('page/document replacement cancels pending preview and prevents stale callbacks', async () => {
  cancel = startRemotePageLoading(options);
  cancel();
  expect(options.loadPreview.mock.calls[0][0].aborted).toBe(true);
  resolvePreview(false); await flush(); jest.advanceTimersByTime(2000);
  expect(options.enableCanvas).not.toHaveBeenCalled();
  expect(options.loadFullImage).not.toHaveBeenCalled();
});

test('availability updates retain the remaining deadline instead of restarting 700 ms', () => {
  options.fallbackDelayMs = 200;
  cancel = startRemotePageLoading(options);
  jest.advanceTimersByTime(199); expect(options.enableCanvas).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); expect(options.enableCanvas).toHaveBeenCalledTimes(1);
});

test('metadata advertised without either image uses Canvas immediately', () => {
  options.previewAvailable = false; options.fullAvailable = false;
  cancel = startRemotePageLoading(options);
  expect(options.enableCanvas).toHaveBeenCalledTimes(1);
});
