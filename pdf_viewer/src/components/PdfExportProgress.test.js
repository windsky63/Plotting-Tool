import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import PdfExportProgress from './PdfExportProgress';
import { publishPdfExportProgress } from '../utils/pdfExportProgress';

jest.mock('antd', () => ({
  Button: props => <button onClick={props.onClick}>{props.children}</button>,
  Modal: props => props.open ? <section>{props.children}{props.footer}</section> : null,
  Progress: props => <span data-status={props.status}>{props.percent}%</span>,
}));

test('export dialog handles failure, retry, completion and listener cleanup', () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const listenerSpy = jest.spyOn(window, 'removeEventListener');
  const emit = detail => act(() => publishPdfExportProgress(detail));
  act(() => root.render(<PdfExportProgress />));
  expect(container.textContent).toBe('');
  emit({ start: true, percent: 0, status: '准备' });
  expect(container.querySelector('button')).toBeNull();
  emit({ percent: 53, status: '1/2' });
  emit({ error: true, status: '写入失败' });
  expect(container.textContent).toContain('53%');
  expect(container.querySelector('[data-status]').dataset.status).toBe('exception');
  act(() => container.querySelector('button').click());
  expect(container.textContent).toBe('');
  emit({ start: true, percent: 0, status: '重试' });
  expect(container.querySelector('[data-status]').dataset.status).toBe('active');
  expect(container.querySelector('button')).toBeNull();
  emit({ percent: 100, done: true, status: '已提交下载' });
  expect(container.querySelector('[data-status]').dataset.status).toBe('success');
  act(() => root.unmount());
  expect(listenerSpy).toHaveBeenCalledWith('pdf-export-progress', expect.any(Function));
  listenerSpy.mockRestore();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});
