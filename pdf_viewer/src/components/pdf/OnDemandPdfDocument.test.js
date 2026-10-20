import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {OnDemandPdfDocument, OnDemandPdfPage} from './OnDemandPdfDocument';
import {createOnDemandPdfDocument} from '../../utils/onDemandPdfDocument';

jest.mock('react-pdf', () => ({pdfjs: {}, Document: ({children}) => <div>{children}</div>,
  Page: ({pdf}) => <span data-ready={Boolean(pdf)}>canvas</span>}));
jest.mock('../../utils/onDemandPdfDocument', () => ({createOnDemandPdfDocument: jest.fn()}));
let root, container, sessions;
beforeEach(() => {
  jest.useFakeTimers(); global.IS_REACT_ACT_ENVIRONMENT = true; sessions = [];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  createOnDemandPdfDocument.mockImplementation(({onReady}) => {
    const pdf = {setPageCount: jest.fn(n => {if(n > 0) onReady(pdf);}),
      ensure: jest.fn(async () => onReady(pdf)), destroy: jest.fn(async () => {})};
    sessions.push(pdf); return pdf;
  });
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); jest.useRealTimers();});
const render = async props => act(async () => root.render(<OnDemandPdfDocument enabled file="fixture" onLoadSuccess={() => {}} onLoadError={() => {}} {...props}>
  <OnDemandPdfPage pageNumber={1}/>
</OnDemandPdfDocument>));
test('a cached document renders children without parsing the source', async () => {
  await render({knownPageCount: 236});
  expect(container.querySelector('[data-ready="true"]')).not.toBeNull();
  await act(async () => jest.advanceTimersByTime(1000));
  expect(sessions[0].ensure).not.toHaveBeenCalled();
});
test('metadata arriving within 700 ms cancels the initial PDF fallback', async () => {
  await render({knownPageCount: 0});
  await act(async () => jest.advanceTimersByTime(699));
  expect(sessions[0].ensure).not.toHaveBeenCalled();
  await render({knownPageCount: 236});
  await act(async () => jest.advanceTimersByTime(1));
  expect(sessions[0].ensure).not.toHaveBeenCalled();
});
test('missing server metadata triggers the fallback at 700 ms', async () => {
  await render({knownPageCount: 0});
  await act(async () => jest.advanceTimersByTime(699)); expect(sessions[0].ensure).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(1)); expect(sessions[0].ensure).toHaveBeenCalledTimes(1);
});
test('continuous view starts the renderer even with a cached page count', async () => {
  await render({knownPageCount: 236, eager: true});
  await act(async () => jest.advanceTimersByTime(1)); expect(sessions[0].ensure).toHaveBeenCalledTimes(1);
});
test('switching files destroys the old document and cancels its scheduled fallback', async () => {
  await render({file: 'old', knownPageCount: 0});
  await render({file: 'new', knownPageCount: 236});
  await act(async () => jest.advanceTimersByTime(1000));
  expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
  expect(sessions[0].ensure).not.toHaveBeenCalled(); expect(sessions[1].ensure).not.toHaveBeenCalled();
});
