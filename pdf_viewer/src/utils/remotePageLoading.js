export const REMOTE_PAGE_FALLBACK_MS = 700;

// One session owns the visible page. Metadata polling must not restart its
// deadline; callers cancel it only when the page/document/availability changes.
export function startRemotePageLoading({
  hasSurface, hasFullImage, previewAvailable, fullAvailable,
  loadPreview, loadFullImage, enableCanvas, isBusy = () => false,
  fallbackDelayMs = REMOTE_PAGE_FALLBACK_MS,
}) {
  const controller = new AbortController();
  let stopped = false;
  let fallback = false;
  let upgradeTimer = null;
  let fallbackTimer = null;
  const showCanvas = () => {
    if (stopped || fallback || hasSurface()) return;
    fallback = true;
    clearTimeout(fallbackTimer);
    enableCanvas();
    // Stop a stalled preview competing with the fallback renderer. A failed
    // preview is likewise replaced immediately, without waiting 700 ms.
    controller.abort();
  };
  const upgrade = () => {
    if (stopped || !fullAvailable || hasFullImage()) return;
    if (isBusy() || (fallback && !hasSurface())) {
      upgradeTimer = setTimeout(upgrade, 100);
      return;
    }
    Promise.resolve(loadFullImage()).then(ok => {
      if (!ok) showCanvas();
    }).catch(showCanvas);
  };
  const scheduleUpgrade = () => {
    if (stopped || !fullAvailable || hasFullImage()) return;
    clearTimeout(upgradeTimer);
    upgradeTimer = setTimeout(upgrade, 100);
  };
  if (!hasSurface()) fallbackTimer = setTimeout(() => {
    showCanvas();
    if (fallback) scheduleUpgrade();
  }, fallbackDelayMs);

  if (hasSurface()) scheduleUpgrade();
  else if (previewAvailable) {
    Promise.resolve(loadPreview(controller.signal)).then(ok => {
      if (stopped || fallback) return;
      if (!ok) showCanvas();
      scheduleUpgrade();
    }).catch(() => { showCanvas(); scheduleUpgrade(); });
  } else if (fullAvailable) upgrade();
  else showCanvas();

  return () => {
    stopped = true;
    controller.abort();
    clearTimeout(fallbackTimer);
    clearTimeout(upgradeTimer);
  };
}
