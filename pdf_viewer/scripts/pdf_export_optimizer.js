const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {pipeline} = require('stream/promises');
const {Transform} = require('stream');

function createPdfExportOptimizer() {
  const python = process.env.PDF_OPTIMIZE_PYTHON || process.env.PDF_PAGE_CACHE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  let health;
  let busy = false;
  const available = () => {
    if (health === undefined) {
      health = new Promise(resolve => {
        const probe = spawn(python, ['-c', 'import fitz'], {windowsHide: true, stdio: 'ignore'});
        const timer = setTimeout(() => {probe.kill(); resolve(false);}, 5000);
        probe.on('error', () => {clearTimeout(timer); resolve(false);});
        probe.on('close', code => {clearTimeout(timer); resolve(code === 0);});
      });
    }
    return health;
  };
  const reply = (res, status, value) => {
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(value));
    }
  };
  async function run(req, res) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luotu-pdf-optimize-'));
    const input = path.join(dir, 'input.pdf'), output = path.join(dir, 'output.pdf');
    let child, expired = false;
    const abort = () => {expired = true; child?.kill(); req.destroy();};
    const timer = setTimeout(abort, 120000);
    const closed = () => {if (!res.writableFinished) abort();};
    res.on('close', closed);
    try {
      let bytes = 0;
      const limit = new Transform({transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 512 * 1024 * 1024 ? Error('PDF exceeds optimization limit') : null, chunk);
      }});
      await pipeline(req, limit, fs.createWriteStream(input));
      if (expired) throw Error('Optimization cancelled');
      await new Promise((resolve, reject) => {
        child = spawn(python, [path.join(__dirname, 'optimize_pdf_export.py'), input, output], {windowsHide: true, stdio: 'ignore'});
        child.on('error', reject);
        child.on('close', code => code === 0 && !expired ? resolve() : reject(Error('PDF optimization or validation failed')));
      });
      const size = fs.statSync(output).size;
      if (size >= bytes) {res.writeHead(204, {'Cache-Control': 'no-store'}); res.end(); return;}
      res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Length': size,
        'Cache-Control': 'no-store', 'X-Pdf-Original-Bytes': String(bytes)});
      await pipeline(fs.createReadStream(output), res);
    } catch (error) {
      reply(res, 422, {error: 'PDF optimization unavailable; use original export'});
    } finally {
      clearTimeout(timer); res.removeListener('close', closed);
      // The child has exited before deleting its task-owned temporary directory.
      const resolved = path.resolve(dir);
      if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('luotu-pdf-optimize-')) {
        fs.rmSync(resolved, {recursive: true, force: true});
      }
      busy = false;
    }
  }
  return {handle(req, res) {
    const route = req.url?.split('?')[0];
    if (route === '/api/pdf-export/optimize/status' && req.method === 'GET') {
      available().then(ok => reply(res, 200, {available: ok, busy, maxBytes: 512 * 1024 * 1024})); return true;
    }
    if (route !== '/api/pdf-export/optimize' || req.method !== 'POST') return false;
    if (busy) {reply(res, 503, {error: 'Optimizer busy'}); return true;}
    if (Number(req.headers['content-length']) > 512 * 1024 * 1024) {reply(res, 413, {error: 'PDF too large'}); return true;}
    busy = true;
    available().then(ok => {
      if (!ok || req.destroyed || res.destroyed) {busy = false; reply(res, 503, {error: 'Optimizer unavailable'}); return;}
      return run(req, res);
    }).catch(() => {busy = false; reply(res, 500, {error: 'Optimizer failed'});});
    return true;
  }};
}
module.exports = {createPdfExportOptimizer};
