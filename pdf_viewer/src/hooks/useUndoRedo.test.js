import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {useUndoRedo} from './useUndoRedo';

let root, history, value;
const command = (description, delta = 1) => ({
  description,
  execute: () => { value += delta; },
  undo: () => { value -= delta; },
});
function Harness() {
  history = useUndoRedo({maxHistorySize: 50});
  return null;
}
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  value = 0;
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
});
afterEach(() => act(() => root.unmount()));

test('callbacks retained by old annotation commands read current history without retaining old stacks', () => {
  const original = history;
  act(() => history.executeCommand(command('first')));
  act(() => history.executeCommand(command('second')));
  for (const method of ['undo', 'redo', 'executeCommand', 'getHistoryInfo', 'trimHistory']) {
    expect(history[method]).toBe(original[method]);
  }
  act(() => original.undo());
  expect(value).toBe(1);
  expect(original.getHistoryInfo()).toMatchObject({undoCount: 1, redoCount: 1, lastUndoDescription: 'first'});
  act(() => original.redo());
  expect(value).toBe(2);
});

test('2360 individual commands stay bounded and the latest 50 remain reversible', () => {
  for (let i = 0; i < 2360; i++) act(() => history.executeCommand(command(String(i))));
  expect(history.undoCount).toBe(50);
  // Exercise consecutive calls in the same React event, as well as re-renders.
  act(() => {for (let i = 0; i < 50; i++) history.undo();});
  expect(value).toBe(2310);
  expect(history.getHistoryInfo()).toMatchObject({undoCount: 0, redoCount: 50});
  act(() => {for (let i = 0; i < 50; i++) history.redo();});
  expect(value).toBe(2360);
  expect(history.getHistoryInfo()).toMatchObject({undoCount: 50, redoCount: 0});
});

test('checkpoint trimming releases history and a new edit invalidates redo', () => {
  act(() => {for (let i = 0; i < 20; i++) history.executeCommand(command(String(i)));});
  act(() => history.trimHistory(5));
  expect(history.getHistoryInfo()).toMatchObject({undoCount: 5, redoCount: 0, lastUndoDescription: '19'});
  act(() => history.undo());
  act(() => history.executeCommand(command('replacement', 5)));
  expect(value).toBe(24);
  expect(history.canRedo).toBe(false);
  act(() => history.clearHistory());
  expect(history.getHistoryInfo()).toMatchObject({undoCount: 0, redoCount: 0, isBatching: false});
});

test('history descriptions are current when a bounded stack keeps the same length', () => {
  act(() => {for (let i = 0; i < 51; i++) history.executeCommand(command(String(i)));});
  expect(history.getHistoryInfo().lastUndoDescription).toBe('50');
  act(() => history.executeCommand(command('newest')));
  expect(history.getHistoryInfo().lastUndoDescription).toBe('newest');
});

test('rapid undo and redo use each command in order before React commits', () => {
  const events = [];
  const ordered = id => ({description: id, execute: () => events.push('do:' + id), undo: () => events.push('undo:' + id)});
  act(() => {history.executeCommand(ordered('a')); history.executeCommand(ordered('b'));});
  events.length = 0;
  act(() => {history.undo(); history.undo();});
  expect(events).toEqual(['undo:b', 'undo:a']);
  events.length = 0;
  act(() => {history.redo(); history.redo();});
  expect(events).toEqual(['do:a', 'do:b']);
});

test('failed execute and failed undo leave history intact', () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  act(() => history.executeCommand({execute: () => {throw Error('execute');}, undo() {}}));
  expect(history.undoCount).toBe(0);
  act(() => history.executeCommand({execute() {}, undo: () => {throw Error('undo');}}));
  act(() => history.undo());
  expect(history.getHistoryInfo()).toMatchObject({undoCount: 1, redoCount: 0});
  error.mockRestore();
});
