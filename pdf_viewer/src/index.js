import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

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
