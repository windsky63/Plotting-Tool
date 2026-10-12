import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { useAnnotationDragSession } from './useAnnotationDragSession';

const source = [
  { id: 'a', page: 1, text: 'F12', startX: 10, startY: 20, endX: 30, endY: 40, hasLeaderLine: true },
  { id: 'b', page: 2, text: 'F13', startX: 100, startY: 200, endX: 300, endY: 400 },
];
let container, root, config, frames, commit, preview, renders;
function Harness() {
  renders += 1;
  const [draggingAnnotation, setDraggingAnnotation] = useState('a');
  useAnnotationDragSession({
    annotations: source, currentPage: 1, scale: 2, documentKey: 'doc1', enabled: true,
    containerRef: { current: { getBoundingClientRect: () => ({ left: 100, top: 200 }) } },
    annotationDragStart: { x: 10, y: 10 }, annotationStartPos: source[0],
    dragType: 'leader', setDragType: () => {},
    draggingAnnotation, setDraggingAnnotation,
    onAnnotationMoveCommit: commit, onAnnotationDragPreview: preview,
    ...config,
  });
  return null;
}
const render = () => act(() => root.render(<Harness />));
const mouse = (type, x, y, button = 0) => act(() => document.dispatchEvent(
  new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true })));
const frame = () => act(() => {
  const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());
});
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container); config = {}; frames = new Map(); renders = 0;
  commit = jest.fn(); preview = jest.fn(); let nextFrame = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
});
afterEach(() => { act(() => root.unmount()); container.remove(); jest.restoreAllMocks(); });

test('500 pointer events only preview once per frame, without parent render or document writes', () => {
  render(); const initialRenders = renders;
  for (let i = 0; i < 500; i += 1) mouse('mousemove', 130, 250);
  expect(frames.size).toBe(1); expect(commit).not.toHaveBeenCalled();
  frame(); expect(preview).toHaveBeenCalledTimes(1); expect(renders).toBe(initialRenders);
  expect(preview.mock.calls[0][0][0]).toMatchObject({ text: 'F12', startX: 20, startY: 40, endX: 40, endY: 60 });
  mouse('mouseup', 150, 270);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][0]).toEqual([{ id: 'a', updates: { startX: 30, startY: 50, endX: 50, endY: 70 } }]);
  frame(); mouse('mouseup', 160, 280); expect(commit).toHaveBeenCalledTimes(1);
});

test('mouseup flushes last coordinates before RAF, right-drag keeps the pipe endpoint fixed', () => {
  config = { dragType: 'annotation' }; render();
  mouse('mousemove', 130, 250); mouse('mouseup', 130, 250, 0);
  expect(commit).not.toHaveBeenCalled();
  mouse('mouseup', 150, 270, 2);
  expect(commit.mock.calls[0][0][0].updates).toEqual({ startX: 10, startY: 20, endX: 50, endY: 70 });
  expect(frames.size).toBe(0);
});

test('group movement across pages commits all selected annotations in a single call', () => {
  config = { multiSelectedAnnotationIds: ['a', 'b'], multiAnnotationStartPositions: { a: source[0], b: source[1] } };
  render(); mouse('mousemove', 130, 250); frame();
  expect(preview.mock.calls[0][0]).toHaveLength(2);
  mouse('mouseup', 130, 250);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][0][1]).toEqual({ id: 'b', updates: { startX: 110, startY: 220, endX: 310, endY: 420 } });
});

test('drag start uses the shared ID index without scanning all annotations', () => {
  const find = jest.spyOn(source, 'find').mockImplementation(() => { throw new Error('full scan'); });
  const filter = jest.spyOn(source, 'filter').mockImplementation(() => { throw new Error('full scan'); });
  config = {
    annotationsById: new Map(source.map(annotation => [annotation.id, annotation])),
    multiSelectedAnnotationIds: ['a', 'b'],
    multiAnnotationStartPositions: { a: source[0], b: source[1] }
  };
  render(); mouse('mousemove', 130, 250); frame();
  expect(preview.mock.calls[0][0]).toHaveLength(2);
  expect(find).not.toHaveBeenCalled();
  expect(filter).not.toHaveBeenCalled();
  mouse('mouseup', 130, 250);
  expect(commit).toHaveBeenCalledTimes(1);
});

test('unrelated parent rerender does not cancel or restart an active gesture', () => {
  render(); mouse('mousemove', 130, 250); render(); frame(); mouse('mouseup', 150, 270);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][0][0].updates.endX).toBe(50);
});

test('Escape cancels and restores display without committing', () => {
  render(); mouse('mousemove', 130, 250); frame();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  mouse('mouseup', 150, 270); expect(commit).not.toHaveBeenCalled();
  expect(preview).toHaveBeenLastCalledWith([]); expect(frames.size).toBe(0);
});

test('window blur commits the last pointer once', () => {
  render(); mouse('mousemove', 130, 250);
  act(() => window.dispatchEvent(new Event('blur')));
  mouse('mouseup', 150, 270); expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][0][0].updates.endX).toBe(40);
});

test.each([
  { currentPage: 2 }, { scale: 3 }, { documentKey: 'doc2' }, { enabled: false },
  { annotations: source.map(a => ({ ...a, text: 'edited elsewhere' })) },
])('page/scale/file/mode/external changes cancel stale movement: %j', changed => {
  render(); mouse('mousemove', 130, 250); frame(); config = changed; render();
  mouse('mouseup', 150, 270); expect(commit).not.toHaveBeenCalled();
  expect(preview).toHaveBeenLastCalledWith([]);
});

test('click without movement creates no edit', () => {
  render(); mouse('mouseup', 110, 210); expect(commit).not.toHaveBeenCalled();
});

test('unmount during drag cannot commit into a replacement document', () => {
  render(); mouse('mousemove', 130, 250); act(() => root.render(null));
  frame(); mouse('mouseup', 150, 270); expect(commit).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});
