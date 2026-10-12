import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import BatchAnnotationAppearance from './BatchAnnotationAppearance';

const annotations = [
  { id: 'a', type: 'text', page: 1, borderShape: 'circle', color: '#ff0000' },
  { id: 'b', type: 'text', page: 2, borderShape: 'circle', color: '#ff0000' }
];
const render = (extra = {}) => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onBatchAnnotationUpdates = jest.fn();
  const props = { annotations, currentPage: 1, selectedIds: [], onBatchAnnotationUpdates,
    pdfDocument: { numPages: 3, getPage: async () => ({ getViewport: () => ({ width: 1190, height: 842 }) }) }, ...extra };
  act(() => root.render(<BatchAnnotationAppearance {...props} />));
  return { container, onBatchAnnotationUpdates, cleanup: () => {
    act(() => root.unmount()); container.remove(); delete global.IS_REACT_ACT_ENVIRONMENT;
  } };
};
const choose = async (container, label, value) => {
  const control = container.querySelector(`[aria-label="${label}"]`).closest('.ant-select');
  await act(async () => {
    control.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  const option = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
    .find(node => node.textContent === value);
  expect(option).toBeDefined();
  await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const applyButton = container => [...container.querySelectorAll('button')].find(button => button.textContent.includes('应用外观'));

test('current page appearance settings apply only on explicit click in one batch', async () => {
  const { container, onBatchAnnotationUpdates, cleanup } = render();
  try {
    expect(applyButton(container).disabled).toBe(true);
    await choose(container, '修改后的框形', '方形');
    act(() => container.querySelector('input[type="checkbox"]').click());
    expect(onBatchAnnotationUpdates).not.toHaveBeenCalled();
    await act(async () => applyButton(container).click());
    expect(onBatchAnnotationUpdates).toHaveBeenCalledTimes(1);
    expect(onBatchAnnotationUpdates.mock.calls[0][0]).toMatchObject({ a: { borderShape: 'rectangle', color: '#0000ff' } });
    expect(Object.keys(onBatchAnnotationUpdates.mock.calls[0][0])).toEqual(['a']);
  } finally { cleanup(); }
});

test('specified pages validate input and apply to the chosen pages only', async () => {
  const { container, onBatchAnnotationUpdates, cleanup } = render();
  try {
    await choose(container, '外观处理范围', '指定多页');
    expect(applyButton(container).disabled).toBe(true);
    const input = container.querySelector('[aria-label="外观处理页码"]');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2-3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => container.querySelector('input[type="checkbox"]').click());
    await act(async () => applyButton(container).click());
    expect(onBatchAnnotationUpdates).toHaveBeenCalledWith({ b: { color: '#0000ff' } }, expect.any(String));
  } finally { cleanup(); }
});

test('selected scope does not fall back to the whole page if selection is empty', async () => {
  const { container, onBatchAnnotationUpdates, cleanup } = render();
  try {
    await choose(container, '外观处理范围', '当前页已选');
    act(() => container.querySelector('input[type="checkbox"]').click());
    expect(applyButton(container).disabled).toBe(true);
    expect(onBatchAnnotationUpdates).not.toHaveBeenCalled();
  } finally { cleanup(); }
});
