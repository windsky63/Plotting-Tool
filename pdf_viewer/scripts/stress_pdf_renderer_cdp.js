const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const pdfPath = path.resolve(process.argv[2] || '');
const durationMinutes = Math.max(1, Number(process.argv[3] || 12));
const url = process.argv[4] || 'http://127.0.0.1:3004/';
const targetOrigin = new URL(url).origin;
const debugPort = Number(process.argv[5] || 9334);
const idleMinutes = Math.max(0, Number(process.argv[6] || 0));
const latencyMs = Math.max(0, Number(process.argv[7] || 0));
const downloadMbps = Math.max(0, Number(process.argv[8] || 0));
const annotationPageLimit = Math.max(0, Number(process.argv[9] || 0));
const annotationsPerPage = Math.max(0, Number(process.argv[10] ?? 3));
const exportAfterAnnotations = String(process.argv[11] || '') === '1';
const recognitionPageLimit = Math.max(0, Number(process.argv[12] || 0));
const autosavePauseEvery = Math.max(0, Number(process.argv[13] || 0));
const autosavePauseMs = Math.max(0, Number(process.argv[14] || 0));
const browserMemoryCeilingGb = Math.max(0, Number(process.argv[15] || 0));
if (!pdfPath || !fs.existsSync(pdfPath)) {
  throw new Error('Usage: node scripts/stress_pdf_renderer_cdp.js <pdf-path> [minutes=12] [url] [debug-port=9334]');
}

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const edgePath = edgeCandidates.find(candidate => fs.existsSync(candidate));
if (!edgePath) throw new Error('Microsoft Edge was not found');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sampleProcessTreeMemory = rootPid => {
  if (process.platform !== 'win32' || !rootPid) return null;
  const command = [
    `$root=${Number(rootPid)}`,
    '$all=Get-CimInstance Win32_Process',
    '$ids=@($root)',
    'do{$added=@($all|Where-Object{$ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId}|Select-Object -ExpandProperty ProcessId);$ids+=$added}while($added.Count -gt 0)',
    '$ps=@(Get-Process -Id $ids -ErrorAction SilentlyContinue)',
    '[pscustomobject]@{processCount=$ps.Count;privateBytes=[int64](($ps|Measure-Object PrivateMemorySize64 -Sum).Sum);workingSetBytes=[int64](($ps|Measure-Object WorkingSet64 -Sum).Sum)}|ConvertTo-Json -Compress'
  ].join(';');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    }).trim();
    return output ? JSON.parse(output) : null;
  } catch (error) {
    return { error: error.message };
  }
};
const readJson = endpoint => new Promise((resolve, reject) => {
  http.get(endpoint, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
  }).on('error', reject);
});

const connect = async endpoint => {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const eventWaiters = new Map();
  let nextId = 0;
  const errors = [];
  const networkStats = { pageSnapshotRequests: 0, pageSnapshotFailures: 0, pageSnapshotCancellations: 0 };
  const pageSnapshotRequestIds = new Set();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (eventWaiters.has(message.method)) {
      const waiter = eventWaiters.get(message.method);
      eventWaiters.delete(message.method);
      waiter.resolve(message.params || {});
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'runtime error');
    } else if (message.method === 'Network.requestWillBeSent') {
      const requestUrl = String(message.params?.request?.url || '');
      if (requestUrl.includes('/api/pdf-page-cache/page/')) {
        networkStats.pageSnapshotRequests += 1;
        if (message.params?.requestId) pageSnapshotRequestIds.add(message.params.requestId);
      }
    } else if (message.method === 'Network.loadingFailed') {
      if (pageSnapshotRequestIds.has(message.params?.requestId)) {
        if (message.params?.canceled || String(message.params?.errorText || '').includes('ERR_ABORTED')) {
          networkStats.pageSnapshotCancellations += 1;
        } else {
          networkStats.pageSnapshotFailures += 1;
        }
        pageSnapshotRequestIds.delete(message.params?.requestId);
      }
    } else if (message.method === 'Network.loadingFinished') {
      pageSnapshotRequestIds.delete(message.params?.requestId);
    }
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const waitForEvent = (method, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventWaiters.delete(method);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    eventWaiters.set(method, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject
    });
  });
  return { socket, send, waitForEvent, errors, networkStats };
};

(async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luotu-oom-stress-'));
  const edge = spawn(edgePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--disable-extensions',
    '--no-first-run',
    '--disable-features=msEdgeSidebarV2',
    url
  ], { windowsHide: true, stdio: 'ignore' });

  let cdp;
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const targets = await readJson(`http://127.0.0.1:${debugPort}/json`);
        const target = targets.find(item => item.type === 'page' && item.url.startsWith(targetOrigin));
        if (target) { cdp = await connect(target.webSocketDebuggerUrl); break; }
      } catch {}
      await wait(500);
    }
    if (!cdp) throw new Error(`Unable to connect to the stress-test Edge page at ${targetOrigin}`);
    const { send, waitForEvent, errors, networkStats } = cdp;
    await send('Runtime.enable');
    await send('Performance.enable');
    await send('HeapProfiler.enable');
    await send('Page.enable');
    await send('Network.enable');
    if (latencyMs > 0 || downloadMbps > 0) {
      await send('Network.emulateNetworkConditions', {
        offline: false,
        latency: latencyMs,
        downloadThroughput: downloadMbps > 0 ? downloadMbps * 1024 * 1024 / 8 : -1,
        uploadThroughput: downloadMbps > 0 ? downloadMbps * 1024 * 1024 / 8 : -1,
        connectionType: 'wifi'
      });
    }
    // Force the application's test-safe <input type=file> fallback. CDP can
    // attach a file to that chooser, but not to showOpenFilePicker's native
    // File System Access dialog.
    let openButtonReady = false;
    for (let attempt = 0; attempt < 60 && !openButtonReady; attempt += 1) {
      const ready = await send('Runtime.evaluate', {
        expression: `(() => Array.from(document.querySelectorAll('button')).some(button =>
          button.querySelector('.anticon-upload') ||
          button.querySelector('.anticon-file-add') ||
          button.innerText.includes('上传 PDF 文件') ||
          button.innerText.includes('选择 PDF 文件')
        ))()`,
        returnByValue: true
      });
      openButtonReady = Boolean(ready.result.value);
      if (!openButtonReady) await wait(500);
    }
    if (!openButtonReady) throw new Error('PDF open button did not become ready');
    const dragData = {
      items: [{ mimeType: 'application/pdf', data: '' }],
      files: [pdfPath],
      dragOperationsMask: 1
    };
    await send('Input.dispatchDragEvent', {
      type: 'dragEnter', x: 500, y: 350, data: dragData
    });
    await send('Input.dispatchDragEvent', {
      type: 'dragOver', x: 500, y: 350, data: dragData
    });
    await send('Input.dispatchDragEvent', {
      type: 'drop', x: 500, y: 350, data: dragData
    });
    let projectConfirmed = false;
    for (let attempt = 0; attempt < 30 && !projectConfirmed; attempt += 1) {
      await wait(500);
      const confirmation = await send('Runtime.evaluate', {
        expression: `(() => {
        const modal = Array.from(document.querySelectorAll('.ant-modal-content')).find(node =>
          node.innerText.includes('选择氚云项目')
        );
        if (!modal) return false;
        const select = modal.querySelector('select');
        if (select && !select.value) {
          const option = Array.from(select.options).find(item => item.value);
          if (option) {
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            setter.call(select, option.value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return false;
        }
        const confirm = modal.querySelector('.ant-modal-footer .ant-btn-primary') ||
          Array.from(modal.querySelectorAll('button')).find(node => node.innerText.includes('确认'));
        confirm?.click();
        return Boolean(confirm);
      })()`,
        returnByValue: true
      });
      projectConfirmed = Boolean(confirmation.result.value);
    }
    if (!projectConfirmed) throw new Error('PDF drop did not open the project-selection dialog');

    const startedAt = Date.now();
    const deadline = startedAt + durationMinutes * 60 * 1000;
    const samples = [];
    let direction = 1;
    let lastActionDirection = direction;
    let actions = 0;
    let loaded = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await wait(500);
      const state = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          canvas: document.querySelectorAll('[data-page-number] canvas').length,
          snapshot: document.querySelectorAll('img[data-pdf-page-snapshot="true"]').length,
          total: window.__pdfBackgroundSnapshotProgress?.total || 0,
          text: document.body.innerText.slice(0, 500)
        })`,
        returnByValue: true
      });
      const parsed = JSON.parse(state.result.value);
      if ((parsed.canvas > 0 || parsed.snapshot > 0) && parsed.total > 1) { loaded = true; break; }
      if (attempt === 89) throw new Error(`PDF did not finish opening: ${parsed.text}`);
    }
    if (!loaded) throw new Error('PDF was not loaded');

    if (annotationPageLimit > 0) {
      const outputDir = path.resolve(__dirname, '..', 'runtime', 'stress-results');
      fs.mkdirSync(outputDir, { recursive: true });
      const runId = new Date().toISOString().replace(/[:.]/g, '-');
      const downloadDir = path.join(outputDir, `annotation-downloads-${runId}`);
      if (exportAfterAnnotations) {
        fs.mkdirSync(downloadDir, { recursive: true });
        await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
      }

      let apiReady = false;
      for (let attempt = 0; attempt < 60 && !apiReady; attempt += 1) {
        const ready = await send('Runtime.evaluate', {
          expression: 'Boolean(window.__luotuAnnotationStressApi)',
          returnByValue: true
        });
        apiReady = Boolean(ready.result.value);
        if (!apiReady) await wait(250);
      }
      if (!apiReady) throw new Error('Annotation stress API was not enabled; add ?codex-annotation-stress=1 to the URL');

      const totalResult = await send('Runtime.evaluate', {
        expression: 'window.__luotuAnnotationStressApi.getState().totalPages',
        returnByValue: true
      });
      const pagesToAnnotate = Math.min(annotationPageLimit, Number(totalResult.result.value) || annotationPageLimit);
      const annotationSamples = [];
      const retainedHeapSamples = [];
      const allocationProfilerEnabled = browserMemoryCeilingGb <= 0;
      if (allocationProfilerEnabled) {
        await send('HeapProfiler.startSampling', { samplingInterval: 32768 });
      }
      const annotationStartedAt = Date.now();
      for (let page = 1; page <= pagesToAnnotate; page += 1) {
        await send('Runtime.evaluate', {
          expression: `(() => {
            const api = window.__luotuAnnotationStressApi;
            api.goToPage(${page});
            for (let index = 0; index < ${annotationsPerPage}; index += 1) {
              api.addAnnotation({
                id: 'codex-stress-${runId}-' + ${page} + '-' + index,
                page: ${page},
                startX: 120 + index * 90,
                startY: 140 + ((${page} + index) % 8) * 55,
                endX: 160 + index * 90,
                endY: 180 + ((${page} + index) % 8) * 55,
                text: 'TEST-' + String(${page}).padStart(4, '0') + '-' + index,
                fontSize: 18,
                frameSize: 56.7,
                borderShape: index % 2 ? 'diamond' : 'circle'
              });
            }
            return true;
          })()`,
          returnByValue: true
        });
        await wait(45);
        if (autosavePauseEvery > 0 && autosavePauseMs > 0 && page % autosavePauseEvery === 0) {
          await wait(autosavePauseMs);
        }
        if (page === 1 || page % 20 === 0 || page === pagesToAnnotate) {
          const sampleResult = await send('Runtime.evaluate', {
            expression: `JSON.stringify({
              page: ${page},
              at: Date.now(),
              jsHeapUsed: performance.memory?.usedJSHeapSize || 0,
              jsHeapTotal: performance.memory?.totalJSHeapSize || 0,
              domNodes: document.getElementsByTagName('*').length,
              canvases: document.querySelectorAll('canvas').length,
              state: window.__luotuAnnotationStressApi.getState(),
              renderer: window.__luotuRendererMemoryDiagnostic || null
            })`,
            returnByValue: true
          });
          const sample = JSON.parse(sampleResult.result.value);
          sample.browserProcessTree = sampleProcessTreeMemory(edge.pid);
          annotationSamples.push(sample);
          const memoryCeilingBytes = browserMemoryCeilingGb * 1024 * 1024 * 1024;
          if (
            memoryCeilingBytes > 0 &&
            Number(sample.browserProcessTree?.privateBytes || 0) > memoryCeilingBytes
          ) {
            throw new Error(`Browser process tree exceeded ${browserMemoryCeilingGb} GB memory ceiling at page ${page}`);
          }
          if (page === 1 || page % 100 === 0 || page === pagesToAnnotate) {
            await send('HeapProfiler.collectGarbage');
            await wait(150);
            const heapUsage = await send('Runtime.getHeapUsage');
            retainedHeapSamples.push({
              page,
              usedSize: Number(heapUsage.usedSize || 0),
              totalSize: Number(heapUsage.totalSize || 0),
              annotations: annotationSamples[annotationSamples.length - 1]?.state?.annotations || 0
            });
          }
        }
      }

      const samplingResult = allocationProfilerEnabled
        ? await send('HeapProfiler.stopSampling')
        : null;
      const allocationTotals = new Map();
      const collectAllocationSites = node => {
        if (!node) return;
        const frame = node.callFrame || {};
        const key = `${frame.functionName || '(anonymous)'} @ ${frame.url || '(native)'}:${Number(frame.lineNumber || 0) + 1}:${Number(frame.columnNumber || 0) + 1}`;
        allocationTotals.set(key, (allocationTotals.get(key) || 0) + Number(node.selfSize || 0));
        (node.children || []).forEach(collectAllocationSites);
      };
      collectAllocationSites(samplingResult?.profile?.head);
      const topAllocationSites = Array.from(allocationTotals.entries())
        .map(([site, bytes]) => ({ site, bytes }))
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, 30);

      const recognitionSamples = [];
      if (recognitionPageLimit > 0) {
        const recognitionPages = Math.min(recognitionPageLimit, Number(totalResult.result.value) || recognitionPageLimit);
        await send('Runtime.evaluate', {
          expression: 'window.__luotuAnnotationStressApi.beginRecognitionStress()',
          returnByValue: true
        });
        for (let page = 1; page <= recognitionPages; page += 1) {
          await send('Runtime.evaluate', {
            expression: `window.__luotuAnnotationStressApi.seedRecognitionPage(${page}, 80, 20)`,
            returnByValue: true
          });
          if (page === 1 || page % 50 === 0 || page === recognitionPages) {
            await wait(150);
            await send('HeapProfiler.collectGarbage');
            const heapUsage = await send('Runtime.getHeapUsage');
            const state = await send('Runtime.evaluate', {
              expression: 'JSON.stringify(window.__luotuAnnotationStressApi.getRecognitionStressState())',
              returnByValue: true
            });
            recognitionSamples.push({
              page,
              usedSize: Number(heapUsage.usedSize || 0),
              totalSize: Number(heapUsage.totalSize || 0),
              state: JSON.parse(state.result.value)
            });
          }
        }
        await send('Runtime.evaluate', {
          expression: `JSON.stringify(window.__luotuAnnotationStressApi.finishRecognitionStress(${recognitionPages}))`,
          returnByValue: true
        });
      }

      await wait(4000);
      await send('Runtime.evaluate', {
        expression: 'window.__luotuAnnotationStressApi.flushDraft().then(() => true)',
        awaitPromise: true,
        returnByValue: true
      });
      const draftResult = await send('Runtime.evaluate', {
        expression: `(async () => {
          const records = await new Promise((resolve, reject) => {
            const request = indexedDB.open('pdf_viewer_annotation_drafts', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const tx = request.result.transaction('drafts', 'readonly');
              const get = tx.objectStore('drafts').getAll();
              get.onsuccess = () => resolve(get.result || []);
              get.onerror = () => reject(get.error);
            };
          });
          const draft = records.find(record => record?.id === 'latest') || null;
          const pageShards = records.filter(record => record?.type === 'annotation-page');
          const persistedPages = pageShards.map(record => Number(record.page)).sort((a, b) => a - b);
          const expectedPages = Array.from({ length: Number(draft?.totalPages) || 0 }, (_, index) => index + 1);
          const annotations = draft?.storageMode === 'page-shards-v1'
            ? pageShards.reduce((total, record) => total + (record?.annotations?.length || 0), 0)
            : (draft?.annotations?.length || 0);
          return JSON.stringify({
            annotations,
            dirty: Boolean(draft?.dirty),
            storageMode: draft?.storageMode || 'legacy',
            pageShards: pageShards.length,
            missingPages: expectedPages.filter(page => !persistedPages.includes(page)),
            metaAnnotationCount: Number(draft?.annotationCount || 0)
          });
        })()`,
        awaitPromise: true,
        returnByValue: true
      });
      const persistedDraft = JSON.parse(draftResult.result.value);

      const revisitPages = Array.from(new Set([1, Math.ceil(pagesToAnnotate / 2), pagesToAnnotate]));
      const revisits = [];
      for (const page of revisitPages) {
        await send('Runtime.evaluate', {
          expression: `window.__luotuAnnotationStressApi.goToPage(${page})`,
          returnByValue: true
        });
        await wait(1200);
        const revisit = await send('Runtime.evaluate', {
          expression: `JSON.stringify({
            page: ${page},
            rendered: document.querySelectorAll('[data-page-number="${page}"] [data-pdf-annotation-id]').length,
            stored: window.__luotuAnnotationStressApi.getPageAnnotationCount(${page}),
            heap: performance.memory?.usedJSHeapSize || 0
          })`,
          returnByValue: true
        });
        revisits.push(JSON.parse(revisit.result.value));
      }

      let exportResult = null;
      if (exportAfterAnnotations) {
        const exportStartedAt = Date.now();
        await send('HeapProfiler.startSampling', { samplingInterval: 32768 });
        const result = await send('Runtime.evaluate', {
          expression: `window.__luotuAnnotationStressApi.exportBoth().then(() => JSON.stringify({
            failure: window.__lastPdfExportFailure || null,
            serialization: window.__lastPdfSerializationTiming || null,
            stage: window.__lastPdfExportStage || null
          }))`,
          awaitPromise: true,
          returnByValue: true
        });
        const postExportHeap = [];
        let previousDelay = 0;
        for (const delayMs of [2000, 10000, 30000]) {
          await wait(delayMs - previousDelay);
          previousDelay = delayMs;
          await send('HeapProfiler.collectGarbage');
          const heapUsage = await send('Runtime.getHeapUsage');
          postExportHeap.push({
            delayMs,
            usedSize: Number(heapUsage.usedSize || 0),
            totalSize: Number(heapUsage.totalSize || 0)
          });
        }
        const exportSamplingResult = await send('HeapProfiler.stopSampling');
        const exportAllocationTotals = new Map();
        const collectExportAllocationSites = node => {
          if (!node) return;
          const frame = node.callFrame || {};
          const key = `${frame.functionName || '(anonymous)'} @ ${frame.url || '(native)'}:${Number(frame.lineNumber || 0) + 1}:${Number(frame.columnNumber || 0) + 1}`;
          exportAllocationTotals.set(key, (exportAllocationTotals.get(key) || 0) + Number(node.selfSize || 0));
          (node.children || []).forEach(collectExportAllocationSites);
        };
        collectExportAllocationSites(exportSamplingResult?.profile?.head);
        exportResult = {
          durationMs: Date.now() - exportStartedAt,
          diagnostics: JSON.parse(result.result.value),
          postExportHeap,
          topAllocationSites: Array.from(exportAllocationTotals.entries())
            .map(([site, bytes]) => ({ site, bytes }))
            .sort((left, right) => right.bytes - left.bytes)
            .slice(0, 30),
          files: fs.readdirSync(downloadDir).map(name => {
            const target = path.join(downloadDir, name);
            return { name, bytes: fs.statSync(target).size, path: target };
          })
        };
      }

      const beforeGcResult = await send('Runtime.evaluate', {
        expression: 'performance.memory?.usedJSHeapSize || 0',
        returnByValue: true
      });
      await send('HeapProfiler.collectGarbage');
      await wait(1200);
      const finalHeapUsage = await send('Runtime.getHeapUsage');
      const afterGcResult = await send('Runtime.evaluate', {
        expression: 'performance.memory?.usedJSHeapSize || 0',
        returnByValue: true
      });
      const finalStateResult = await send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__luotuAnnotationStressApi.getState())',
        returnByValue: true
      });
      const outputPath = path.join(outputDir, `annotation-stress-${runId}.json`);
      const report = {
        summary: {
          url, pdfPath, pagesToAnnotate, annotationsPerPage,
          annotationsExpected: pagesToAnnotate * annotationsPerPage,
          durationMs: Date.now() - annotationStartedAt,
          firstHeapMB: Number(annotationSamples[0]?.jsHeapUsed || 0) / 1048576,
          maxHeapMB: Math.max(0, ...annotationSamples.map(item => Number(item.jsHeapUsed || 0))) / 1048576,
          lastHeapMB: Number(annotationSamples[annotationSamples.length - 1]?.jsHeapUsed || 0) / 1048576,
          beforeGcHeapMB: Number(beforeGcResult.result.value || 0) / 1048576,
          afterGcHeapMB: Number(afterGcResult.result.value || 0) / 1048576,
          browserMemoryCeilingGb,
          maxBrowserPrivateMB: Math.max(0, ...annotationSamples.map(item => Number(item.browserProcessTree?.privateBytes || 0))) / 1048576,
          maxBrowserWorkingSetMB: Math.max(0, ...annotationSamples.map(item => Number(item.browserProcessTree?.workingSetBytes || 0))) / 1048576,
          persistedDraft,
          revisits,
          finalState: JSON.parse(finalStateResult.result.value),
          runtimeErrors: errors.slice(-20),
          finalRetainedHeapMB: Number(finalHeapUsage.usedSize || 0) / 1048576,
          outputPath
        },
        samples: annotationSamples,
        retainedHeapSamples,
        topAllocationSites,
        recognitionSamples,
        exportResult
      };
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report.summary, null, 2));
      await send('Browser.close');
      return;
    }

    while (Date.now() < deadline) {
      const burstUntil = Math.min(deadline, Date.now() + 10000);
      while (Date.now() < burstUntil) {
        lastActionDirection = direction;
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: direction > 0 ? 'ArrowRight' : 'ArrowLeft',
          code: direction > 0 ? 'ArrowRight' : 'ArrowLeft',
          windowsVirtualKeyCode: direction > 0 ? 39 : 37
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: direction > 0 ? 'ArrowRight' : 'ArrowLeft',
          code: direction > 0 ? 'ArrowRight' : 'ArrowLeft',
          windowsVirtualKeyCode: direction > 0 ? 39 : 37
        });
        actions += 1;
        if (actions % 180 === 0) direction *= -1;
        await wait(55);
      }

      // A cached page request may be cancelled repeatedly while keys are still
      // arriving. Once the burst stops, the active page must always recover to
      // either a decoded snapshot or a live PDF.js canvas within five seconds.
      const visualStartedAt = Date.now();
      let activeVisual = { ready: false, page: null, canvas: false, snapshot: false };
      for (let attempt = 0; attempt < 50 && !activeVisual.ready; attempt += 1) {
        const visualResult = await send('Runtime.evaluate', {
          expression: `JSON.stringify((() => {
            const pages = Array.from(document.querySelectorAll('[data-page-number]'));
            const active = pages.find(node => node.getAttribute('aria-hidden') !== 'true') || pages[0];
            const canvas = active?.querySelector('canvas');
            const snapshot = active?.querySelector('img[data-pdf-page-snapshot="true"]');
            const canvasReady = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
            const snapshotReady = Boolean(snapshot && snapshot.complete && snapshot.naturalWidth > 0);
            return {
              ready: canvasReady || snapshotReady,
              page: Number(active?.getAttribute('data-page-number')) || null,
              canvas: canvasReady,
              snapshot: snapshotReady
            };
          })())`,
          returnByValue: true
        });
        activeVisual = JSON.parse(visualResult.result.value);
        if (!activeVisual.ready) await wait(100);
      }

      const result = await send('Runtime.evaluate', {
        expression: `(async () => {
          const start = performance.now();
          await new Promise(resolve => setTimeout(resolve, 100));
          const canvases = Array.from(document.querySelectorAll('canvas'));
          const snapshots = Array.from(document.querySelectorAll('img[data-pdf-page-snapshot="true"]'));
          return JSON.stringify({
            at: Date.now(),
            eventLoopDelayMs: Math.max(0, performance.now() - start - 100),
            jsHeapUsed: performance.memory?.usedJSHeapSize || 0,
            jsHeapTotal: performance.memory?.totalJSHeapSize || 0,
            domNodes: document.getElementsByTagName('*').length,
            canvasCount: canvases.length,
            canvasPixels: canvases.reduce((sum, item) => sum + item.width * item.height, 0),
            snapshotCount: snapshots.length,
            imageFirstCount: document.querySelectorAll('img[data-pdf-page-image-first="true"]').length,
            page: Number(document.querySelector('[data-page-number]')?.getAttribute('data-page-number')) ||
              window.__lastPdfPageRenderTiming?.page || null,
            renderMs: window.__lastPdfPageRenderTiming?.durationMs || null,
            cache: window.__pdfBackgroundSnapshotProgress || null
          });
        })()`,
        awaitPromise: true,
        returnByValue: true
      });
      samples.push({
        ...JSON.parse(result.result.value),
        activeVisualReady: activeVisual.ready,
        pageTurnDirection: lastActionDirection,
        activeVisualPage: activeVisual.page,
        activeVisualSource: activeVisual.snapshot ? 'snapshot' : (activeVisual.canvas ? 'canvas' : 'none'),
        activeVisualSettleMs: Date.now() - visualStartedAt
      });
      await wait(5000);
      const settledResult = await send('Runtime.evaluate', {
        expression: `JSON.stringify((() => {
          const pages = Array.from(document.querySelectorAll('[data-page-number]'));
          const active = pages.find(node => node.getAttribute('aria-hidden') !== 'true') || pages[0];
          const canvas = active?.querySelector('canvas');
          const snapshot = active?.querySelector('img[data-pdf-page-snapshot="true"]');
          return {
            page: Number(active?.getAttribute('data-page-number')) || null,
            source: snapshot?.complete && snapshot?.naturalWidth > 0
              ? 'snapshot'
              : (canvas?.width > 0 && canvas?.height > 0 ? 'canvas' : 'none')
          };
        })())`,
        returnByValue: true
      });
      const settledVisual = JSON.parse(settledResult.result.value);
      samples[samples.length - 1].postIdleVisualPage = settledVisual.page;
      samples[samples.length - 1].postIdleVisualSource = settledVisual.source;
    }

    const idleSamples = [];
    const idleDeadline = Date.now() + idleMinutes * 60 * 1000;
    while (Date.now() < idleDeadline) {
      await wait(Math.min(30000, Math.max(1, idleDeadline - Date.now())));
      const idleResult = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          at: Date.now(),
          jsHeapUsed: performance.memory?.usedJSHeapSize || 0,
          jsHeapTotal: performance.memory?.totalJSHeapSize || 0,
          cache: window.__pdfVisitedPageCacheInfo || null,
          memoryDiagnostic: window.__luotuRendererMemoryDiagnostic || null,
          idleRelease: window.__luotuIdleRuntimeRelease || null
        })`,
        returnByValue: true
      });
      idleSamples.push(JSON.parse(idleResult.result.value));
    }

    const outputDir = path.resolve(__dirname, '..', 'runtime', 'stress-results');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `renderer-stress-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await send('HeapProfiler.enable');
    const beforeForcedGc = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        used: performance.memory?.usedJSHeapSize || 0,
        total: performance.memory?.totalJSHeapSize || 0,
        cache: window.__pdfVisitedPageCacheInfo || null,
        pending: window.__luotuRendererMemoryDiagnostic || null
      })`,
      returnByValue: true
    });
    await send('HeapProfiler.collectGarbage');
    await wait(1200);
    const afterForcedGc = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        used: performance.memory?.usedJSHeapSize || 0,
        total: performance.memory?.totalJSHeapSize || 0,
        cache: window.__pdfVisitedPageCacheInfo || null,
        idleRelease: window.__luotuIdleRuntimeRelease || null
      })`,
      returnByValue: true
    });
    const forcedGc = {
      before: JSON.parse(beforeForcedGc.result.value),
      after: JSON.parse(afterForcedGc.result.value)
    };
    const heapValues = samples.map(item => item.jsHeapUsed).filter(Boolean);
    const blankSamples = samples.filter(item => !item.activeVisualReady);
    const directionSummary = directionValue => {
      const group = samples.filter(item => item.pageTurnDirection === directionValue);
      return {
        samples: group.length,
        blankSamples: group.filter(item => !item.activeVisualReady).length,
        averageSettleMs: group.length
          ? Math.round(group.reduce((sum, item) => sum + Number(item.activeVisualSettleMs || 0), 0) / group.length)
          : 0,
        maxSettleMs: Math.max(0, ...group.map(item => item.activeVisualSettleMs || 0))
      };
    };
    const summary = {
      url, pdfPath, durationMinutes, idleMinutes, latencyMs, downloadMbps, actions, samples: samples.length,
      maxEventLoopDelayMs: Math.max(0, ...samples.map(item => item.eventLoopDelayMs || 0)),
      firstHeapMB: heapValues.length ? heapValues[0] / 1048576 : 0,
      lastHeapMB: heapValues.length ? heapValues[heapValues.length - 1] / 1048576 : 0,
      maxHeapMB: heapValues.length ? Math.max(...heapValues) / 1048576 : 0,
      beforeForcedGcHeapMB: forcedGc.before.used / 1048576,
      afterForcedGcHeapMB: forcedGc.after.used / 1048576,
      afterForcedGcTotalHeapMB: forcedGc.after.total / 1048576,
      pageSnapshotRequests: networkStats.pageSnapshotRequests,
      pageSnapshotFailures: networkStats.pageSnapshotFailures,
      pageSnapshotCancellations: networkStats.pageSnapshotCancellations,
      blankPageSamples: blankSamples.length,
      maxVisualSettleMs: Math.max(0, ...samples.map(item => item.activeVisualSettleMs || 0)),
      postIdleSnapshotSamples: samples.filter(item => item.postIdleVisualSource === 'snapshot').length,
      forward: directionSummary(1),
      backward: directionSummary(-1),
      runtimeErrors: errors.slice(-20), outputPath
    };
    fs.writeFileSync(outputPath, JSON.stringify({ summary, forcedGc, samples, idleSamples }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (blankSamples.length > 0) process.exitCode = 2;
    await send('Browser.close');
  } finally {
    try { cdp?.socket?.close(); } catch {}
    try { edge.kill(); } catch {}
    await wait(1000);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
