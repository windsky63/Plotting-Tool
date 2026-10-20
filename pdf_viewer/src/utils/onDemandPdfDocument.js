// Own PDF.js directly: React-PDF's Document source cache otherwise retains a
// full ArrayBuffer in addition to the buffer transferred to the PDF.js worker.
export function createOnDemandPdfDocument({file, pdfjs, onReady = () => {}, onState = () => {}, idleMs = 60000}) {
  let task = null, loading = null, closing = Promise.resolve(), disposed = false, resolved = false;
  let active = 0, timer = null, total = 0, loads = 0, releases = 0;
  const pages = new Map();
  const report = () => onState({loaded: resolved, loading: Boolean(loading) && !resolved, active, loads, releases, numPages: total});
  const touch = () => {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => { release().catch(() => {}); }, idleMs);
  };
  const check = () => { if (disposed) throw new DOMException('PDF document closed', 'AbortError'); };
  const ensure = () => {
    check(); touch();
    if (!loading) {
      loading = (async () => {
        await closing; check();
        let source;
        if (typeof Blob !== 'undefined' && file instanceof Blob) {
          const bytes = await file.arrayBuffer();
          check();
          source = {data: new Uint8Array(bytes)};
        } else source = file;
        task = pdfjs.getDocument(source);
        task.onPassword = (updatePassword, reason) => updatePassword(window.prompt(
          reason === 2 ? '密码错误，请重新输入 PDF 密码' : '请输入 PDF 密码'
        ));
        loads += 1; report();
        const pdf = await task.promise;
        check(); total = pdf.numPages; resolved = true;
        onReady(document); report();
        return pdf;
      })().catch(async error => {
        const failed = task;
        task = null; loading = null; resolved = false;
        await failed?.destroy().catch(() => {});
        report(); throw error;
      });
    }
    return loading;
  };
  const run = async operation => {
    active += 1; touch();
    try { return await operation(await ensure()); }
    finally { active -= 1; touch(); report(); }
  };
  const rawPage = async (pdf, entry) => {
    if (!entry.raw) entry.raw = await pdf.getPage(entry.number);
    return entry.raw;
  };
  const getPage = number => run(async pdf => {
    let entry = pages.get(number);
    if (!entry) { entry = {number, raw: null}; pages.set(number, entry); }
    const raw = await rawPage(pdf, entry);
    if (!entry.handle) {
      // The retained handle contains only geometry. Its methods reacquire the
      // page after idle destruction; page caches cannot retain the old worker.
      const viewport = raw.getViewport({scale: 1});
      const geometry = {_pageIndex: number - 1, pageNumber: number, rotate: raw.rotate,
        userUnit: raw.userUnit, view: [...raw.view], ref: raw.ref};
      const methods = {
        getViewport: options => viewport.clone(options),
        cleanup: (...args) => entry.raw?.cleanup(...args) ?? true,
        getOperatorList: (...args) => run(async doc => (await rawPage(doc, entry)).getOperatorList(...args)),
        getTextContent: (...args) => run(async doc => (await rawPage(doc, entry)).getTextContent(...args)),
        getAnnotations: (...args) => run(async doc => (await rawPage(doc, entry)).getAnnotations(...args)),
        getStructTree: (...args) => run(async doc => (await rawPage(doc, entry)).getStructTree(...args)),
        render: options => {
          let renderTask, cancelled = false;
          const result = {
            cancel: () => { cancelled = true; renderTask?.cancel(); },
            promise: run(async doc => {
              const page = await rawPage(doc, entry);
              if (cancelled) throw Object.assign(new Error('Rendering cancelled'), {name: 'RenderingCancelledException'});
              renderTask = page.render(options);
              if (result.onContinue) renderTask.onContinue = result.onContinue;
              return renderTask.promise;
            })
          };
          return result;
        }
      };
      entry.handle = new Proxy(geometry, {get: (target, key, receiver) => {
        if (key in methods) return methods[key];
        if (key in target) return Reflect.get(target, key, receiver);
        touch();
        const value = entry.raw?.[key];
        return typeof value === 'function' ? value.bind(entry.raw) : value;
      }});
    }
    return entry.handle;
  });
  const release = async () => {
    if (active) { touch(); return false; }
    clearTimeout(timer);
    const previous = task;
    task = null; loading = null; resolved = false;
    pages.forEach(entry => { entry.raw = null; });
    if (previous) {
      releases += 1;
      closing = previous.destroy().catch(() => {});
      await closing;
    }
    report(); return true;
  };
  const document = {
    get numPages() { return total; },
    getPage,
    cleanup: () => active || !task ? Promise.resolve() : run(pdf => pdf.cleanup?.()),
    setPageCount: count => {
      if (Number.isInteger(count) && count > 0 && !total) {
        total = count; onReady(document); report();
      }
    },
    ensure: () => run(pdf => pdf.numPages),
    release,
    destroy: async () => {
      disposed = true; total = 0; clearTimeout(timer);
      const previous = task; task = null; loading = null; resolved = false;
      pages.forEach(entry => { entry.raw = null; }); pages.clear();
      await previous?.destroy().catch(() => {});
      await closing;
    }
  };
  report();
  return document;
}
