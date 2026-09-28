const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// Completed caches are shared by every terminal. Active projects refresh
// lastUsed on status lookup; inactive caches expire after 24 hours.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MANIFEST_PAGE_BATCH = 10;
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;
const CACHE_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const UPLOAD_PROGRESS_WRITE_BYTES = 16 * 1024 * 1024;
const UPLOAD_PROGRESS_WRITE_MS = 2000;

const findPythonRenderer = () => {
  const configured = String(process.env.PDF_PAGE_CACHE_PYTHON || '').trim();
  if (configured && fs.existsSync(configured)) return { command: configured, args: [] };

  if (process.platform === 'win32') {
    const localPrograms = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python')
      : '';
    if (localPrograms && fs.existsSync(localPrograms)) {
      const versions = fs.readdirSync(localPrograms, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const version of versions) {
        const executable = path.join(localPrograms, version, 'python.exe');
        if (fs.existsSync(executable)) return { command: executable, args: [] };
      }
    }
    const launcher = path.join(process.env.WINDIR || 'C:\\Windows', 'py.exe');
    if (fs.existsSync(launcher)) return { command: launcher, args: ['-3'] };
  }

  return { command: process.platform === 'win32' ? 'python.exe' : 'python3', args: [] };
};

const json = (res, status, body) => {
  if (res.writableEnded || res.destroyed) return;
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(data);
};

const isReusablePageManifest = manifest => {
  if (!manifest || manifest.status === 'error' || manifest.status === 'uploading') return false;
  if (manifest.status === 'complete') return true;
  if (!['queued', 'rendering'].includes(manifest.status)) return false;
  const total = Number(manifest.total || 0);
  if (total <= 0) return false;
  const completed = new Set(
    (Array.isArray(manifest.completed) ? manifest.completed : []).map(Number)
  );
  const pageCount = Object.keys(manifest.pages || {})
    .map(Number)
    .filter(page => Number.isInteger(page) && page > 0)
    .length;
  return completed.size >= total && pageCount >= total;
};

const createPdfPageCacheService = ({ rootDir }) => {
  const defaultCacheDir = process.env.PORT === '3004'
    ? path.join('runtime', 'pdf-page-cache-mirror')
    : path.join('runtime', 'pdf-page-cache');
  const cacheRoot = path.resolve(rootDir, process.env.PDF_PAGE_CACHE_DIR || defaultCacheDir);
  const rendererScript = path.resolve(__dirname, 'render_pdf_page_cache.py');
  const jobs = new Map();
  const activeUploads = new Set();
  const queue = [];
  let active = null;

  fs.mkdirSync(cacheRoot, { recursive: true });
  const pythonRenderer = findPythonRenderer();
  const rendererProbe = spawnSync(
    pythonRenderer.command,
    [...pythonRenderer.args, '-c', 'import fitz'],
    { windowsHide: true, encoding: 'utf8', timeout: 10000 }
  );
  const rendererHealth = rendererProbe.status === 0 && !rendererProbe.error
    ? { ok: true, error: '' }
    : {
        ok: false,
        error: rendererProbe.error?.message || rendererProbe.stderr?.trim() ||
          `Python renderer probe exited ${rendererProbe.status}`
      };
  if (!rendererHealth.ok) {
    console.error('[PDF page cache] renderer unavailable:', rendererHealth.error);
  } else {
    console.log('[PDF page cache] renderer ready:', pythonRenderer.command);
  }

  const idForKey = key => crypto.createHash('sha256').update(String(key || '')).digest('hex');
  const pathsFor = id => {
    const dir = path.join(cacheRoot, id);
    return {
      dir,
      pdf: path.join(dir, 'source.pdf'),
      upload: path.join(dir, 'source.uploading'),
      manifest: path.join(dir, 'manifest.json')
    };
  };
  const readManifest = id => {
    try { return JSON.parse(fs.readFileSync(pathsFor(id).manifest, 'utf8')); } catch { return null; }
  };
  const documentSignature = key => {
    let decoded = String(key || '');
    try { decoded = decodeURIComponent(decoded); } catch {}
    const match = decoded.match(/^(.*):(\d+):(\d+)$/);
    return match ? `${match[1]}:${match[2]}` : '';
  };
  const findCompatibleManifest = documentKey => {
    const signature = documentSignature(documentKey);
    if (!signature) return null;
    let newest = null;
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = readManifest(entry.name);
      if (
        !isReusablePageManifest(candidate) ||
        documentSignature(candidate.documentKey) !== signature ||
        !fs.existsSync(pathsFor(entry.name).pdf)
      ) continue;
      if (!newest || Number(candidate.updatedAt || 0) > Number(newest.updatedAt || 0)) newest = candidate;
    }
    return newest;
  };
  const writeManifest = manifest => {
    const target = pathsFor(manifest.id);
    fs.mkdirSync(target.dir, { recursive: true });
    const temp = `${target.manifest}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...manifest, updatedAt: Date.now() }));
    fs.renameSync(temp, target.manifest);
  };
  const publicStatus = manifest => ({
    ok: true,
    found: Boolean(manifest),
    cacheId: manifest?.id || null,
    status: manifest?.status || 'missing',
    total: Number(manifest?.total || 0),
    completed: Array.isArray(manifest?.completed) ? manifest.completed : [],
    previewCompleted: Array.isArray(manifest?.previewCompleted) ? manifest.previewCompleted : [],
    failed: Array.isArray(manifest?.failed) ? manifest.failed : [],
    pages: manifest?.pages || {},
    previews: manifest?.previews || {},
    sourceSize: Number(manifest?.sourceSize || 0),
    uploadedBytes: Number(manifest?.uploadedBytes || 0),
    error: manifest?.error || ''
  });

  const runNext = () => {
    if (active || queue.length === 0) return;
    const id = queue.shift();
    const target = pathsFor(id);
    let manifest = readManifest(id);
    if (!manifest || !fs.existsSync(target.pdf)) return runNext();
    if (!rendererHealth.ok) {
      manifest.status = 'error';
      manifest.error = `页面缓存渲染器不可用: ${rendererHealth.error}`;
      writeManifest(manifest);
      setImmediate(runNext);
      return;
    }
    active = id;
    manifest.status = 'rendering';
    manifest.error = '';
    writeManifest(manifest);
    manifest.renderer = pythonRenderer.command;
    writeManifest(manifest);
    const child = spawn(pythonRenderer.command, [
      ...pythonRenderer.args,
      rendererScript,
      target.pdf,
      target.dir,
      String(manifest.total || 0)
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Page rasterisation is a background acceleration task.  On a production
    // workstation it must not compete at normal priority with HTTP serving,
    // autosave or the users' foreground applications.
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (error) {
      console.warn('[PDF page cache] unable to lower renderer priority:', error.message);
    }
    jobs.set(id, child);
    let stdout = '';
    let pagesSinceManifestWrite = 0;
    const completedPages = new Set(Array.isArray(manifest.completed) ? manifest.completed : []);
    const completedPreviews = new Set(Array.isArray(manifest.previewCompleted) ? manifest.previewCompleted : []);
    manifest.pages = manifest.pages || {};
    manifest.previews = manifest.previews || {};
    const flushRenderProgress = () => {
      if (pagesSinceManifestWrite <= 0) return;
      // A status request may have refreshed lastUsed since this renderer took
      // its in-memory snapshot.  Preserve that timestamp when batching writes.
      const latest = readManifest(id);
      if (Number(latest?.lastUsed || 0) > Number(manifest.lastUsed || 0)) {
        manifest.lastUsed = latest.lastUsed;
      }
      manifest.completed = Array.from(completedPages).sort((a, b) => a - b);
      manifest.previewCompleted = Array.from(completedPreviews).sort((a, b) => a - b);
      writeManifest(manifest);
      pagesSinceManifestWrite = 0;
    };
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      lines.forEach(line => {
        const previewMatch = line.match(/^PREVIEW\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+([0-9.]+))?$/);
        if (previewMatch) {
          const page = Number(previewMatch[1]);
          manifest.previews[page] = {
            width: Number(previewMatch[2]),
            height: Number(previewMatch[3]),
            renderScale: Number(previewMatch[4] || 0)
          };
          completedPreviews.add(page);
          pagesSinceManifestWrite += 1;
          if (
            completedPreviews.size === 1 ||
            pagesSinceManifestWrite >= MANIFEST_PAGE_BATCH ||
            page >= Number(manifest.total || 0)
          ) {
            flushRenderProgress();
          }
          return;
        }
        const match = line.match(/^PAGE\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+([0-9.]+))?$/);
        if (!match) return;
        const page = Number(match[1]);
        manifest.pages[page] = {
          width: Number(match[2]),
          height: Number(match[3]),
          renderScale: Number(match[4] || 0)
        };
        completedPages.add(page);
        pagesSinceManifestWrite += 1;
        if (
          completedPages.size === 1 ||
          pagesSinceManifestWrite >= MANIFEST_PAGE_BATCH ||
          page >= Number(manifest.total || 0)
        ) {
          flushRenderProgress();
        }
      });
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('close', code => {
      flushRenderProgress();
      jobs.delete(id);
      manifest = readManifest(id) || manifest;
      manifest.status = code === 0 ? 'complete' : 'error';
      manifest.error = code === 0 ? '' : (stderr.trim() || `renderer exited ${code}`);
      writeManifest(manifest);
      active = null;
      setImmediate(runNext);
    });
    child.on('error', error => {
      jobs.delete(id);
      manifest.status = 'error';
      manifest.error = error.message;
      writeManifest(manifest);
      active = null;
      setImmediate(runNext);
    });
  };

  const enqueue = id => {
    if (active === id || queue.includes(id)) return;
    const manifest = readManifest(id);
    if (!manifest || manifest.status === 'complete') return;
    queue.push(id);
    setImmediate(runNext);
  };

  // A service restart can leave a manifest saying "uploading" or
  // "rendering" even though no request/child process survived. Resume only
  // disk-complete jobs; discard partial uploads so the next client can retry.
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const target = pathsFor(id);
    const manifest = readManifest(id);
    if (!manifest) continue;
    if (manifest.status === 'uploading') {
      try { fs.rmSync(target.upload, { force: true }); } catch {}
      try { fs.rmSync(target.manifest, { force: true }); } catch {}
    } else if (['queued', 'rendering'].includes(manifest.status) && fs.existsSync(target.pdf)) {
      manifest.status = 'queued';
      manifest.error = '';
      writeManifest(manifest);
      enqueue(id);
    }
  }

  const cleanExpired = () => {
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    for (const name of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!name.isDirectory() || active === name.name || queue.includes(name.name)) continue;
      const target = pathsFor(name.name);
      const manifest = readManifest(name.name);
      const lastUsed = Number(manifest?.lastUsed || manifest?.updatedAt || 0);
      if (lastUsed && lastUsed < cutoff) fs.rmSync(target.dir, { recursive: true, force: true });
    }
  };
  cleanExpired();
  const cleanupTimer = setInterval(cleanExpired, 6 * 60 * 60 * 1000);
  cleanupTimer.unref?.();

  const handle = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/api/pdf-page-cache/')) return false;

    if (req.method === 'GET' && url.pathname === '/api/pdf-page-cache/status') {
      const documentKey = url.searchParams.get('key') || '';
      if (!documentKey) { json(res, 400, { ok: false, error: 'missing key' }); return true; }
      let id = idForKey(documentKey);
      let manifest = readManifest(id);
      if (manifest?.status === 'uploading' && !activeUploads.has(id)) {
        const staleTarget = pathsFor(id);
        try { fs.rmSync(staleTarget.upload, { force: true }); } catch {}
        try { fs.rmSync(staleTarget.manifest, { force: true }); } catch {}
        manifest = null;
      }
      // Copies of the same drawing often acquire a different lastModified on
      // another terminal. Reuse a completed cache when file name and byte size
      // still match, instead of uploading and rasterising the whole PDF again.
      if (!manifest) {
        manifest = findCompatibleManifest(documentKey);
        if (manifest?.id) id = manifest.id;
      }
      if (manifest) {
        const now = Date.now();
        // Polling clients used to synchronously rewrite the manifest once per
        // second.  With several users this created avoidable disk contention.
        if (now - Number(manifest.lastUsed || 0) >= LAST_USED_WRITE_INTERVAL_MS) {
          manifest.lastUsed = now;
          writeManifest(manifest);
        }
        if (manifest.status === 'error' && fs.existsSync(pathsFor(id).pdf)) {
          manifest.status = 'queued';
          manifest.error = '';
          writeManifest(manifest);
        }
        if (
          manifest.status === 'complete' &&
          Object.keys(manifest.previews || {}).length < Number(manifest.total || 0) &&
          fs.existsSync(pathsFor(id).pdf)
        ) {
          manifest.status = 'queued';
          manifest.error = '';
          writeManifest(manifest);
        }
        enqueue(id);
      }
      json(res, 200, publicStatus(manifest));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/pdf-page-cache/register') {
      const documentKey = req.headers['x-pdf-cache-key'] || '';
      const total = Math.max(0, Number(req.headers['x-pdf-page-count'] || 0));
      const expectedSize = Math.max(0, Number(req.headers['content-length'] || 0));
      if (!documentKey || !total) { json(res, 400, { ok: false, error: 'missing cache key or page count' }); return true; }
      if (expectedSize > MAX_UPLOAD_BYTES) { json(res, 413, { ok: false, error: 'PDF too large' }); return true; }
      const id = idForKey(documentKey);
      const target = pathsFor(id);
      fs.mkdirSync(target.dir, { recursive: true });
      let existing = readManifest(id);
      if (existing?.status === 'uploading' && !activeUploads.has(id)) {
        try { fs.rmSync(target.upload, { force: true }); } catch {}
        try { fs.rmSync(target.manifest, { force: true }); } catch {}
        existing = null;
      }
      if (existing && Number(existing.total || 0) === total) {
        if (existing.status === 'error' && fs.existsSync(target.pdf)) {
          existing.status = 'queued';
          existing.error = '';
          writeManifest(existing);
          enqueue(id);
        }
        if (
          existing.status === 'complete' &&
          Object.keys(existing.previews || {}).length < total &&
          fs.existsSync(target.pdf)
        ) {
          existing.status = 'queued';
          existing.error = '';
          writeManifest(existing);
          enqueue(id);
        }
        req.resume();
        json(res, 200, publicStatus(existing));
        return true;
      }
      // Publish the in-progress state before receiving the large body. Other
      // terminals will poll this job instead of starting a duplicate upload.
      writeManifest({
        id, documentKey: String(documentKey), sourceSize: expectedSize, total,
          status: 'uploading', completed: [], previewCompleted: [], failed: [], pages: {}, previews: {}, uploadedBytes: 0,
        createdAt: Date.now(), lastUsed: Date.now()
      });
      // Large drawings can take more than Node's default five-minute request
      // window over the public route. Byte and queue limits still protect the
      // workstation while this upload remains an inactivity-guarded stream.
      req.setTimeout?.(CACHE_UPLOAD_TIMEOUT_MS);
      const output = fs.createWriteStream(target.upload);
      let received = 0;
      let stopped = false;
      let lastProgressBytes = 0;
      let lastProgressAt = Date.now();
      activeUploads.add(id);
      const fail = (status, message) => {
        if (stopped) return;
        stopped = true;
        activeUploads.delete(id);
        output.destroy();
        try { fs.rmSync(target.upload, { force: true }); } catch {}
        try { fs.rmSync(target.manifest, { force: true }); } catch {}
        console.warn('[PDF page cache] upload failed', {
          id, total, expectedSize, received, status, message
        });
        json(res, status, { ok: false, error: message });
      };
      console.log('[PDF page cache] upload started', { id, total, expectedSize });
      req.on('data', chunk => {
        received += chunk.length;
        const now = Date.now();
        if (
          received - lastProgressBytes >= UPLOAD_PROGRESS_WRITE_BYTES ||
          now - lastProgressAt >= UPLOAD_PROGRESS_WRITE_MS
        ) {
          const uploadingManifest = readManifest(id);
          if (uploadingManifest?.status === 'uploading') {
            uploadingManifest.uploadedBytes = received;
            writeManifest(uploadingManifest);
          }
          lastProgressBytes = received;
          lastProgressAt = now;
        }
        if (received > MAX_UPLOAD_BYTES) {
          fail(413, 'PDF too large');
          req.destroy();
        }
      });
      req.on('error', error => fail(400, error.message));
      req.on('aborted', () => fail(499, 'client aborted PDF cache upload'));
      output.on('error', error => fail(500, error.message));
      output.on('finish', () => {
        if (stopped) return;
        stopped = true;
        activeUploads.delete(id);
        fs.renameSync(target.upload, target.pdf);
        const manifest = {
          id, documentKey: String(documentKey), sourceSize: received, total,
          status: 'queued', completed: [], previewCompleted: [], failed: [], pages: {}, previews: {}, uploadedBytes: received,
          createdAt: Date.now(), lastUsed: Date.now()
        };
        writeManifest(manifest);
        enqueue(id);
        console.log('[PDF page cache] upload complete', { id, total, received });
        json(res, 202, publicStatus(manifest));
      });
      req.pipe(output);
      return true;
    }

    const previewMatch = url.pathname.match(/^\/api\/pdf-page-cache\/preview\/([a-f0-9]{64})\/(\d+)$/);
    if (req.method === 'GET' && previewMatch) {
      const id = previewMatch[1];
      const page = Number(previewMatch[2]);
      const file = path.join(pathsFor(id).dir, `preview-page-${page}.png`);
      if (!fs.existsSync(file)) { json(res, 404, { ok: false, error: 'preview not ready' }); return true; }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': 'image/png', 'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=259200, immutable', 'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(file).pipe(res);
      return true;
    }

    const pageMatch = url.pathname.match(/^\/api\/pdf-page-cache\/page\/([a-f0-9]{64})\/(\d+)$/);
    if (req.method === 'GET' && pageMatch) {
      const id = pageMatch[1];
      const page = Number(pageMatch[2]);
      const file = path.join(pathsFor(id).dir, `page-${page}.png`);
      if (!fs.existsSync(file)) { json(res, 404, { ok: false, error: 'page not ready' }); return true; }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': 'image/png', 'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=259200, immutable', 'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(file).pipe(res);
      return true;
    }

    json(res, 404, { ok: false, error: 'not found' });
    return true;
  };

  return { handle };
};

module.exports = { createPdfPageCacheService, findPythonRenderer, isReusablePageManifest };
