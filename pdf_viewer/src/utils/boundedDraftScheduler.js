// Debounce quiet periods without allowing continuous editing to starve saves.
export const createBoundedDraftScheduler = (save, { delay = 8000, maxWait = 60000 } = {}) => {
  let timer = null;
  let startedAt = null;
  let pending = null;
  let retryAt = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    startedAt = null;
    pending = null;
    retryAt = 0;
  };
  const flush = () => {
    const value = pending;
    cancel();
    return value ? save(value) : null;
  };
  const schedule = (value, wait = delay) => {
    pending = value;
    if (startedAt === null) startedAt = Date.now();
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, retryAt - Date.now(), Math.min(wait, maxWait - (Date.now() - startedAt))));
  };
  const retry = (value, wait = 60000) => {
    cancel();
    retryAt = Date.now() + wait;
    schedule(value, wait);
  };
  return { schedule, retry, flush, cancel };
};
