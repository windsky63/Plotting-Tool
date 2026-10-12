import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import BatchAnnotationFont from './BatchAnnotationFont';

test('one font form shows a single size for circles and applies identical sizes after switching scope', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const updates = jest.fn();
  const annotations = ['a', 'b', 'c'].map(id => ({ id, type: 'text', page: 1, borderShape: 'circle', text: 'F1' }));
  try {
    act(() => root.render(<BatchAnnotationFont annotations={annotations} currentPage={1} selectedIds={[]}
      pdfDocument={{ numPages: 2, getPage: async () => ({ getViewport: () => ({ width: 2380, height: 1684 }) }) }}
      onBatchAnnotationUpdates={updates} />));
    expect(container.querySelectorAll('[aria-label="已有标注字号"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="普通标注字号"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="分割圆上半字号"]')).toBeNull();
    const apply = () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('应用字号'));
    await act(async () => apply().click());
    const first = updates.mock.calls[0][0];
    act(() => container.querySelector('[aria-label="字号处理范围"]').closest('.ant-select')
      .querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    const option = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
      .find(node => node.textContent === '所有页');
    await act(async () => option.click());
    await act(async () => apply().click());
    expect(updates.mock.calls[1][0]).toEqual(first);
    expect(Object.keys(first)).toEqual(['a', 'b', 'c']);
  } finally { act(() => root.unmount()); container.remove(); }
});
