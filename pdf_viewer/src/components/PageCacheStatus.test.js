import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import PageCacheStatus from './PageCacheStatus';
import DraftSaveStatus from './DraftSaveStatus';
import {createDraftSaveHealth} from '../utils/draftSaveHealth';

jest.mock('antd', () => ({Button: ({children, onClick}) => <button onClick={onClick}>{children}</button>,
  Modal: Object.assign(() => null, {confirm: jest.fn()}), message: {success: jest.fn()}}));
let root, node, host, containerRef, progress, props;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  host=document.createElement('div');document.body.appendChild(host);containerRef={current:host};
  progress={total:236,completed:40,failed:0,skipped:0,running:true,stage:'rendering'};
  props={containerRef,serverMode:true,onRetry:jest.fn(),onTogglePause:jest.fn()};
});
afterEach(() => {act(() => root.unmount());node.remove();host.remove();});
const render=()=>act(() => root.render(<PageCacheStatus {...props} progress={progress}/>));
test('progress lives in shared status host, with no bottom-left duplicate', () => {
  render();expect(host.textContent).toContain('页面缓存 40/236');expect(node.querySelector('[data-page-cache-status]')).toBeNull();
  progress={...progress,stage:'uploading',uploadedBytes:1024*1024,sourceSize:10*1024*1024};render();
  expect(host.textContent).toContain('图纸上传 1.0/10.0 MB');
  progress={...progress,stage:'complete',completed:236,running:false};render();
  expect(host.querySelector('.saved')).not.toBeNull();
});
test('failure details, retry and skipped pages survive the move', () => {
  progress={...progress,running:false,failed:2,skipped:1,error:'网络失败'};render();
  expect(host.textContent).toContain('失败2');expect(host.textContent).toContain('跳过超大页1');
  expect(host.querySelector('[title]').title).toBe('网络失败');
  act(() => host.querySelector('button').click());expect(props.onRetry).toHaveBeenCalledTimes(1);
});
test('local cache pause and resume remain actionable', () => {
  props={...props,serverMode:false};render();
  act(() => host.querySelector('button').click());expect(props.onTogglePause).toHaveBeenCalledTimes(1);
  props={...props,paused:true};render();expect(host.textContent).toContain('已暂停');expect(host.querySelector('button').textContent).toBe('继续');
});
test('document reset clears stale progress and unmount removes portal', () => {
  render();progress={...progress,total:0};render();expect(host.textContent).toBe('');
  progress={...progress,total:236};render();act(() => root.render(null));expect(host.textContent).toBe('');
});
test('cache actions do not bubble through the portal and start dragging the drawing', () => {
  const drag=jest.fn();props={...props,serverMode:false};
  act(() => root.render(<div onMouseDown={drag}><PageCacheStatus {...props} progress={progress}/></div>));
  act(() => host.querySelector('button').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})));
  expect(drag).not.toHaveBeenCalled();
});
test('progress ticks do not re-render the App or draft save status', () => {
  let update, parentRenders=0;
  const ref={current:null},store=createDraftSaveHealth();
  function Viewer(){const [value,setValue]=useState(progress);update=setValue;return <PageCacheStatus containerRef={ref} progress={value} serverMode/>;}
  function App(){parentRenders++;return <><DraftSaveStatus store={store} pageCacheContainerRef={ref}/><Viewer/></>;}
  act(() => root.render(<App/>));
  for(let i=0;i<100;i++)act(() => update({...progress,completed:i}));
  expect(parentRenders).toBe(1);expect(node.querySelector('[data-draft-save-status] [data-page-cache-status]').textContent).toContain('99/236');
});
