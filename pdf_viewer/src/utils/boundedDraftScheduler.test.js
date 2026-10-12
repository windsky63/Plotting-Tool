import { createBoundedDraftScheduler } from './boundedDraftScheduler';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test('quiet edits save once after eight seconds with the latest snapshot', () => {
  const save = jest.fn();
  const scheduler = createBoundedDraftScheduler(save);
  scheduler.schedule({ revision: 1 });
  jest.advanceTimersByTime(4000);
  scheduler.schedule({ revision: 2 });
  jest.advanceTimersByTime(7999);
  expect(save).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(save).toHaveBeenCalledWith({ revision: 2 });
});

test('continuous edits cannot postpone upload beyond one minute', () => {
  const save = jest.fn();
  const scheduler = createBoundedDraftScheduler(save);
  scheduler.schedule({ revision: 0 });
  for (let revision = 1; revision <= 11; revision += 1) {
    jest.advanceTimersByTime(5000);
    scheduler.schedule({ revision });
  }
  expect(save).not.toHaveBeenCalled();
  jest.advanceTimersByTime(5000);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({ revision: 11 });
});

test('failed snapshots retry after one minute without further editing', () => {
  let scheduler;
  const save = jest.fn(value => {
    if (save.mock.calls.length === 1) scheduler.retry(value);
  });
  scheduler = createBoundedDraftScheduler(save);
  scheduler.schedule({ revision: 1 });
  scheduler.flush();
  jest.advanceTimersByTime(59999);
  expect(save).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1);
  expect(save).toHaveBeenCalledTimes(2);
});

test('editing during a network failure keeps the latest snapshot without shortening the retry interval', () => {
  const save = jest.fn();
  const scheduler = createBoundedDraftScheduler(save);
  scheduler.retry({ revision: 1 });
  jest.advanceTimersByTime(10000);
  scheduler.schedule({ revision: 2 });
  jest.advanceTimersByTime(49999);
  expect(save).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(save).toHaveBeenCalledWith({ revision: 2 });
});

test('document reset cancels old snapshots and flush consumes a pending save once', () => {
  const save = jest.fn();
  const scheduler = createBoundedDraftScheduler(save);
  scheduler.schedule({ document: 'old' });
  scheduler.cancel();
  jest.advanceTimersByTime(60000);
  expect(save).not.toHaveBeenCalled();
  scheduler.schedule({ document: 'new' });
  scheduler.flush();
  jest.advanceTimersByTime(60000);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({ document: 'new' });
});
