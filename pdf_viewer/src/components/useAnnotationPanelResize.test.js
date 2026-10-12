import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import useAnnotationPanelResize from './useAnnotationPanelResize';

let container, root, width, toggle, frames;
function Harness() {
  const { startResize } = useAnnotationPanelResize({
    visible: true,
    onWidthChange: width, onToggle: toggle
  });
  return <button onMouseDown={startResize}>width</button>;
}
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container); width = jest.fn(); toggle = jest.fn(); frames = new Map();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  let id = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++id, callback); return id; });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); jest.restoreAllMocks(); });
const mouse = (target, type, x, y) => act(() => target.dispatchEvent(new MouseEvent(type,
  { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })));

test('one drag movement works immediately and mouseup flushes the final width before RAF', () => {
  mouse(container.querySelectorAll('button')[0], 'mousedown', 700, 200);
  mouse(document, 'mousemove', 650, 200);
  expect(frames.size).toBe(1);
  mouse(document, 'mouseup', 400, 200);
  expect(width).toHaveBeenLastCalledWith(800);
  expect(toggle).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});
test('clicking the edge toggles the panel without changing its width', () => {
  mouse(container.querySelectorAll('button')[0], 'mousedown', 700, 200);
  mouse(document, 'mouseup', 700, 200);
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(width).not.toHaveBeenCalled();
});
test('blur cancels pending updates and restores existing body styles', () => {
  document.body.style.cursor = 'pointer'; document.body.style.userSelect = 'text';
  mouse(container.querySelectorAll('button')[0], 'mousedown', 700, 200);
  mouse(document, 'mousemove', 650, 200);
  act(() => window.dispatchEvent(new Event('blur')));
  expect(frames.size).toBe(0);
  expect(width).not.toHaveBeenCalled();
  expect(document.body.style.cursor).toBe('pointer');
  expect(document.body.style.userSelect).toBe('text');
  document.body.style.cursor = ''; document.body.style.userSelect = '';
});
