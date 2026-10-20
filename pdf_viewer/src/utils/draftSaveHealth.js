export const DRAFT_SYNC_WARNING_MS = 120000;
const channel = () => ({savedRevision: -1, savedAt: null, pendingSince: null,
  saving: false, error: '', failures: 0, failedAt: null});

// Scalar status only. Keep annotations and PDF buffers out of the status UI.
export function createDraftSaveHealth() {
  let state = {revision: 0, edited: false, local: channel(), cloud: channel()};
  const listeners = new Set();
  const publish = next => {state = next; listeners.forEach(fn => fn());};
  return {
    getSnapshot: () => state,
    subscribe: fn => {listeners.add(fn); return () => listeners.delete(fn);},
    reset: () => publish({revision: 0, edited: false, local: channel(), cloud: channel()}),
    edited(revision, now = Date.now()) {
      publish({...state, revision, edited: true,
        local: {...state.local, pendingSince: state.local.pendingSince ?? now},
        cloud: {...state.cloud, pendingSince: state.cloud.pendingSince ?? now}});
    },
    started(target) {
      publish({...state, [target]: {...state[target], saving: true}});
    },
    saved(target, revision, now = Date.now()) {
      const old = state[target];
      if (revision < old.savedRevision) return;
      const current = revision >= state.revision;
      publish({...state, [target]: {...old, savedRevision: revision, savedAt: now,
        saving: false, ...(current ? {error: '', failures: 0, failedAt: null, pendingSince: null} : {})}});
    },
    failed(target, error, now = Date.now()) {
      const old = state[target];
      publish({...state, [target]: {...old, saving: false,
        error: String(error?.message || error || '保存失败'), failures: old.failures + 1,
        failedAt: now, pendingSince: old.pendingSince ?? now}});
    }
  };
}

export function getDraftSaveHealth(state, now = Date.now()) {
  const current = target => state.edited && state[target].savedRevision >= state.revision;
  const localCurrent = current('local'), cloudCurrent = current('cloud');
  const overdue = target => state.edited && !current(target) && state[target].pendingSince != null &&
    now - state[target].pendingSince >= DRAFT_SYNC_WARNING_MS;
  const cloudWarning = !cloudCurrent && (state.cloud.failures >= 2 || overdue('cloud'));
  const localWarning = !localCurrent && (Boolean(state.local.error) || overdue('local'));
  const danger = !localCurrent && !cloudCurrent && Boolean(state.local.error && state.cloud.error);
  return {localCurrent, cloudCurrent, cloudWarning, localWarning, danger,
    warning: danger || cloudWarning || localWarning,
    pending: state.edited && (!localCurrent || !cloudCurrent)};
}
