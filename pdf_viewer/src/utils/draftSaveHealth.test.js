import {createDraftSaveHealth, getDraftSaveHealth} from './draftSaveHealth';

test('only a receipt for the current edit can claim that latest changes are saved', () => {
  const store = createDraftSaveHealth(); store.edited(1, 100); store.started('local'); store.edited(2, 200);
  store.saved('local', 1, 300);
  expect(getDraftSaveHealth(store.getSnapshot(), 300).localCurrent).toBe(false);
  store.saved('local', 2, 400);
  expect(getDraftSaveHealth(store.getSnapshot(), 400).localCurrent).toBe(true);
});
test('cloud warning appears on second failure and persists across retries and stale successes', () => {
  const store = createDraftSaveHealth(); store.edited(1, 100);
  store.failed('cloud', 'offline', 200);
  expect(getDraftSaveHealth(store.getSnapshot(), 200).cloudWarning).toBe(false);
  store.failed('cloud', 'offline', 300);
  store.started('cloud'); store.edited(2, 400); store.saved('cloud', 1, 500);
  expect(getDraftSaveHealth(store.getSnapshot(), 500).cloudWarning).toBe(true);
  expect(store.getSnapshot().cloud.error).toBe('offline');
  store.saved('cloud', 2, 600);
  expect(getDraftSaveHealth(store.getSnapshot(), 600).cloudWarning).toBe(false);
});
test('two minutes without a current acknowledgement warns even if requests have not failed', () => {
  const store = createDraftSaveHealth(); store.edited(1, 100);
  expect(getDraftSaveHealth(store.getSnapshot(), 120099).warning).toBe(false);
  expect(getDraftSaveHealth(store.getSnapshot(), 120100).cloudWarning).toBe(true);
  store.edited(2, 120101);
  expect(getDraftSaveHealth(store.getSnapshot(), 120101).cloudWarning).toBe(true);
});
test('both failed destinations escalate; a current local receipt removes dual failure but retains cloud warning', () => {
  const store = createDraftSaveHealth(); store.edited(1, 100);
  store.failed('local', 'QuotaExceededError'); store.failed('cloud', '503'); store.failed('cloud', '503');
  expect(getDraftSaveHealth(store.getSnapshot()).danger).toBe(true);
  store.started('local'); store.started('cloud');
  expect(getDraftSaveHealth(store.getSnapshot()).danger).toBe(true);
  store.saved('local', 1);
  expect(getDraftSaveHealth(store.getSnapshot())).toMatchObject({danger: false, cloudWarning: true, localCurrent: true});
});
test('file reset clears old errors and acknowledged revisions', () => {
  const store = createDraftSaveHealth(); store.edited(9); store.failed('cloud', 'old'); store.saved('local', 9);
  store.reset(); expect(getDraftSaveHealth(store.getSnapshot())).toMatchObject({warning: false, pending: false});
  expect(store.getSnapshot().cloud.error).toBe(''); expect(store.getSnapshot().local.savedAt).toBeNull();
});
