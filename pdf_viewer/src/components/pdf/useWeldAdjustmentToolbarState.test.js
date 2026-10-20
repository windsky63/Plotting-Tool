import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useWeldAdjustmentToolbarState} from './useWeldAdjustmentToolbarState';

let root, container, options, published, renders;
function Viewer({onStateChange}) {
  useWeldAdjustmentToolbarState({...options, onStateChange});
  return null;
}
function Parent() {
  const [toolbar, setToolbar] = useState(null);
  renders += 1;
  if (renders > 20) throw new Error('Toolbar publication caused an update loop');
  published = toolbar;
  // Reproduce the changing callback chain in App/PDFViewer on every render.
  const handleAction = action => options.handleAction(action);
  useWeldAdjustmentToolbarState({...options, handleAction, onStateChange: setToolbar});
  return null;
}
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
  options = {available: true, mode: 'idle', handleAction: jest.fn()};
  published = null;
  renders = 0;
});
afterEach(() => {act(() => root.unmount()); container.remove();});

test('publishing to parent state settles despite newly created action callbacks', () => {
  act(() => root.render(<Parent />));
  expect(renders).toBe(2);
  expect(published).toMatchObject({available: true, mode: 'idle'});
});

test('stable toolbar action calls the latest handler without republishing', () => {
  const notify = jest.fn();
  act(() => root.render(<Viewer onStateChange={notify} />));
  const action = notify.mock.calls[0][0].handleAction;
  const oldHandler = options.handleAction;
  options = {...options, handleAction: jest.fn()};
  act(() => root.render(<Viewer onStateChange={notify} />));
  expect(notify).toHaveBeenCalledTimes(1);
  act(() => action({key: 'insert'}));
  expect(oldHandler).not.toHaveBeenCalled();
  expect(options.handleAction).toHaveBeenCalledWith({key: 'insert'});
});

test('availability and insert/delete/exit transitions publish with one action identity', () => {
  const notify = jest.fn();
  const render = () => act(() => root.render(<Viewer onStateChange={notify} />));
  render();
  for (const mode of ['insert', 'delete', 'idle']) {
    options = {...options, mode}; render();
  }
  options = {...options, available: false}; render();
  expect(notify.mock.calls.map(([state]) => [state.available, state.mode])).toEqual([
    [true, 'idle'], [true, 'insert'], [true, 'delete'], [true, 'idle'], [false, 'idle']
  ]);
  expect(new Set(notify.mock.calls.map(([state]) => state.handleAction)).size).toBe(1);
});
