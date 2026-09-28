import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useWeldAdjustmentPipelineSync } from './useWeldAdjustmentPipelineSync';

let root, container, options, finish;
function Harness() { useWeldAdjustmentPipelineSync(options); return null; }
const render = () => act(() => root.render(<Harness />));
const result = { page: 1, status: 'resolved', pipelineNumber: 'PIPE-A', matchedPages: [1] };
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
  options = { page: 1, mode: 'insert', documentKey: 'doc1', context: {}, welds: [],
    resolve: jest.fn(() => new Promise(resolve => { finish = resolve; })), apply: jest.fn() };
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

test.each(['insert', 'delete'])('%s fills on initial entry without changing page', async mode => {
  options.mode = mode; render();
  options = { ...options, context: { page: 1, status: 'resolving' } }; render();
  await act(async () => finish(result));
  expect(options.resolve).toHaveBeenCalledTimes(1);
  expect(options.apply).toHaveBeenCalledWith(result);
});
test('uses latest sequence callback after progress rerenders, without resubmission', async () => {
  render(); const oldApply = options.apply;
  const latestApply = jest.fn();
  options = { ...options, welds: [{ id: 'new-manual-point' }], apply: latestApply }; render();
  await act(async () => finish(result));
  expect(oldApply).not.toHaveBeenCalled();
  expect(latestApply).toHaveBeenCalledWith(result);
  expect(options.resolve).toHaveBeenCalledTimes(1);
});
test.each([{ page: 2 }, { mode: null }, { documentKey: 'doc2' }])('rejects obsolete result after %j', async change => {
  render(); const completeOld = finish; const isCurrent = options.resolve.mock.calls[0][2];
  options = { ...options, ...change }; render();
  await act(async () => completeOld(result));
  expect(isCurrent()).toBe(false);
  expect(options.apply).not.toHaveBeenCalled();
});
test('resolved entry binds immediately without another recognition call', async () => {
  options.context = result; render();
  await act(async () => {});
  expect(options.resolve).not.toHaveBeenCalled();
  expect(options.apply).toHaveBeenCalledWith(result);
});
