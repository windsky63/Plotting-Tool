import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import AnnotationDragPreview from './AnnotationDragPreview';

test('preview renders selected items without rerendering parent and restores original visibility', () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); const ref = createRef(); let parentRenders = 0;
  const renderer = jest.fn((page, annotations) => annotations.map(a => <svg key={a.id}><text>{a.text}</text></svg>));
  const Parent = () => {
    parentRenders += 1;
    return <div><svg data-pdf-annotation-id="a" /><svg data-pdf-annotation-id="b" />
      <AnnotationDragPreview ref={ref} pageNumber={1} renderAnnotations={renderer} /></div>;
  };
  try {
    act(() => root.render(<Parent />));
    for (let i = 0; i < 10; i += 1) act(() => ref.current.update([{ id: 'a', page: 1, text: `F${i}`, endX: i }]));
    expect(parentRenders).toBe(1);
    expect(renderer).toHaveBeenLastCalledWith(1, [{ id: 'a', page: 1, text: 'F9', endX: 9 }]);
    expect(container.querySelector('[data-pdf-annotation-id="a"]').style.visibility).toBe('hidden');
    expect(container.querySelector('[data-pdf-annotation-id="b"]').style.visibility).toBe('');
    act(() => ref.current.clear());
    expect(container.querySelector('[data-pdf-annotation-id="a"]').style.visibility).toBe('');
    expect(container.querySelector('[data-annotation-drag-preview]').textContent).toBe('');
  } finally { act(() => root.unmount()); container.remove(); }
});

test('120 rigid moves reuse one SVG render and apply the scaled final translation', () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); const ref = createRef();
  const renderer = jest.fn((page, annotations) => annotations.map(a => <svg key={a.id}><text>{a.text}</text></svg>));
  const original = { id: 'a', page: 1, text: 'F1', startX: 10, startY: 20, endX: 30, endY: 40 };
  try {
    act(() => root.render(<div><svg data-pdf-annotation-id="a" />
      <AnnotationDragPreview ref={ref} pageNumber={1} scale={2} renderAnnotations={renderer} /></div>));
    for (let i = 0; i < 120; i += 1) act(() => ref.current.update([{
      ...original, startX: 10 + i, startY: 20 + i, endX: 30 + i, endY: 40 + i
    }]));
    expect(renderer).toHaveBeenCalledTimes(1);
    const preview = container.querySelector('[data-annotation-drag-preview]');
    expect(preview.style.transform).toBe('translate(238px, 238px)');
    expect(container.querySelector('[data-pdf-annotation-id="a"]').style.visibility).toBe('hidden');
    act(() => ref.current.clear());
    expect(preview.style.transform).toBe('');
    expect(container.querySelector('[data-pdf-annotation-id="a"]').style.visibility).toBe('');
    act(() => ref.current.update([{ ...original, endX: 80 }]));
    expect(preview.style.transform).toBe('');
    expect(renderer).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); container.remove(); }
});

test('moving only the frame endpoint still redraws the anchored leader', () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); const ref = createRef();
  const renderer = jest.fn(() => <svg />);
  const original = { id: 'a', page: 1, text: 'F1', startX: 10, startY: 20, endX: 30, endY: 40 };
  try {
    act(() => root.render(<AnnotationDragPreview ref={ref} pageNumber={1} renderAnnotations={renderer} />));
    act(() => ref.current.update([original]));
    act(() => ref.current.update([{ ...original, endX: 80 }]));
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-annotation-drag-preview]').style.transform).toBe('');
  } finally { act(() => root.unmount()); container.remove(); }
});
