import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {Modal, message} from 'antd';
import DraftSaveStatus from './DraftSaveStatus';
import {createDraftSaveHealth} from '../utils/draftSaveHealth';

jest.mock('antd', () => {
  const Modal = ({open, children}) => open ? <div>{children}</div> : null;
  Modal.confirm = jest.fn(() => ({destroy: jest.fn()}));
  return {Modal, message: {success: jest.fn(), error: jest.fn()},
    Button: ({children, onClick, loading}) => <button disabled={loading} onClick={onClick}>{children}</button>};
});
let store, root, node, props;
beforeEach(async () => {
  jest.useFakeTimers(); jest.clearAllMocks(); global.IS_REACT_ACT_ENVIRONMENT = true;
  store = createDraftSaveHealth(); node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
  props = {store, onRetry: jest.fn(async () => {}), onExport: jest.fn(), onRecover: jest.fn()};
  await act(async () => root.render(<DraftSaveStatus {...props}/>));
});
afterEach(async () => {await act(async () => root.unmount()); node.remove(); jest.useRealTimers();});
const change = async fn => act(async () => fn());
test('continued cloud failures display persistent banner and its retry is actionable', async () => {
  await change(() => {store.edited(1); store.saved('local', 1); store.failed('cloud', '503');});
  expect(node.querySelector('.draft-save-warning')).toBeNull();
  await change(() => store.failed('cloud', '503'));
  expect(node.textContent).toContain('本机已保存最新修改');
  expect(node.querySelector('.draft-save-warning')).not.toBeNull();
  await change(() => [...node.querySelectorAll('button')].find(b => b.textContent === '立即重试').click());
  expect(props.onRetry).toHaveBeenCalledTimes(1);
  expect(node.querySelector('.draft-save-warning')).not.toBeNull();
  await change(() => store.saved('cloud', 1));
  expect(node.querySelector('.draft-save-warning')).toBeNull(); expect(message.success).toHaveBeenCalledTimes(1);
});
test('dual failure prompts once and retrying does not hide the red warning', async () => {
  await change(() => {store.edited(1); store.failed('local', 'quota'); store.failed('cloud', '503');});
  expect(Modal.confirm).toHaveBeenCalledTimes(1);
  await change(() => {store.started('local'); store.started('cloud'); store.failed('cloud', '503');});
  expect(Modal.confirm).toHaveBeenCalledTimes(1); expect(node.querySelector('.danger')).not.toBeNull();
  await change(() => Modal.confirm.mock.calls[0][0].onOk()); expect(props.onExport).toHaveBeenCalled();
});
test('timer escalates unsynchronized edits without another user action', async () => {
  await change(() => {store.edited(1); store.saved('local', 1);});
  await change(() => jest.advanceTimersByTime(120000));
  expect(node.querySelector('.draft-save-warning')).not.toBeNull();
});
test('new edits replace saved text immediately and old acknowledgements cannot restore it', async () => {
  await change(() => {store.edited(1); store.saved('local', 1); store.saved('cloud', 1);});
  await change(() => {store.edited(2); store.saved('local', 1);});
  expect(node.textContent).not.toContain('本机已保存最新修改');
  expect(node.textContent).not.toContain('云端已同步最新修改');
});
