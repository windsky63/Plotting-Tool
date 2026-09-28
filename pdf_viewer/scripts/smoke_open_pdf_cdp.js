const http = require('http');

const pdfPath = process.argv[2];
const debugPort = Number(process.argv[3] || 9333);
if (!pdfPath) throw new Error('Usage: node smoke_open_pdf_cdp.js <pdf-path> [debug-port]');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = url => new Promise((resolve, reject) => {
  http.get(url, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

(async () => {
  const targets = await readJson(`http://127.0.0.1:${debugPort}/json`);
  const target = targets.find(item => item.type === 'page' && item.url.includes(':3005'));
  if (!target) throw new Error('3005 page was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  let nextId = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      callback(message);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      errors.push((message.params.args || []).map(arg => arg.value || arg.description || '').join(' '));
    }
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Input.dispatchDragEvent', {
    type: 'dragEnter', x: 500, y: 350,
    data: { items: [], files: [pdfPath], dragOperationsMask: 1 }
  });
  await send('Input.dispatchDragEvent', {
    type: 'drop', x: 500, y: 350,
    data: { items: [], files: [pdfPath], dragOperationsMask: 1 }
  });
  await wait(2500);
  await send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input[placeholder*="输入项目关键字"]');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'PDF打开回归');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  });
  await wait(1000);
  await send('Runtime.evaluate', {
    expression: `Array.from(document.querySelectorAll('button')).find(node => node.innerText.includes('确认并打开PDF'))?.click()`
  });
  await wait(15000);
  const result = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ text: document.body.innerText.slice(0, 1000), htmlLength: document.body.innerHTML.length })`,
    returnByValue: true
  });
  const snapshot = JSON.parse(result.result.value);
  const pageCountMatch = snapshot.text.match(/\/\s*(\d+)/);
  const passed = snapshot.htmlLength > 10000 && Number(pageCountMatch?.[1] || 0) > 0 && errors.length === 0;
  console.log(JSON.stringify({ passed, snapshot, errors }, null, 2));
  await send('Browser.close');
  if (!passed) process.exitCode = 1;
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
