import React from 'react';
import ReactDOM from 'react-dom/client';
import {unstableSetRender} from 'antd';
import './index.css';
import App from './App';

// Ant Design 5 static dialogs otherwise fall back to ReactDOM.render, which
// React 19 removed. In production this can silently hide the recovery prompt.
const dialogRoots = new WeakMap();
unstableSetRender((node, container) => {
  let dialogRoot = dialogRoots.get(container);
  if (!dialogRoot) {
    dialogRoot = ReactDOM.createRoot(container);
    dialogRoots.set(container, dialogRoot);
  }
  dialogRoot.render(node);
  return async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (dialogRoots.get(container) === dialogRoot) {
      dialogRoot.unmount();
      dialogRoots.delete(container);
    }
  };
});

// The application contains extensive legacy diagnostics. Browsers may retain
// logged object graphs for the lifetime of the tab, so production must not
// turn a long annotation session into an unbounded console cache.
if (process.env.NODE_ENV === 'production') {
  console.log = () => {};
  console.debug = () => {};
  console.info = () => {};
}

// 在开发环境中过滤掉 findDOMNode 的警告
// 这是 antd 内部组件的已知问题，不影响功能
if (process.env.NODE_ENV === 'development') {
  const originalError = console.error;
  console.error = (...args) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('findDOMNode is deprecated')
    ) {
      return;
    }
    originalError.call(console, ...args);
  };
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <App />
);
