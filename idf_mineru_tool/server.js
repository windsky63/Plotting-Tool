const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.IDF_TOOL_HOST || '0.0.0.0';
const PORT = Number(process.env.IDF_TOOL_PORT || 3006);
const MINERU_HOST = process.env.MINERU_HOST || '127.0.0.1';
const MINERU_PORT = Number(process.env.MINERU_PORT || 8081);
const OCR_HOST = process.env.OCR_HOST || '192.168.32.61';
const OCR_PORT = Number(process.env.OCR_PORT || 8766);

const ROOT = __dirname;
const APP_ROOT = path.resolve(ROOT, '..', 'pdf_viewer');
const LOG_ROOT = path.join(ROOT, 'logs');
const RECOGNITION_JOBS = new Map();
const MINERU_COMPAT_JOBS = new Map();
const RECOGNITION_JOB_TTL = 6 * 60 * 60 * 1000;
const MINERU_CONCURRENCY = Math.max(1, Number(process.env.MINERU_CONCURRENCY || 4));
const VENDOR_FILES = {
  '/vendor/pdf.min.js': path.join(APP_ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.js'),
  '/vendor/pdf.worker.min.js': path.join(APP_ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js'),
  '/vendor/pdf-lib.min.js': path.join(APP_ROOT, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js'),
  '/vendor/xlsx.full.min.js': path.join(APP_ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    ...headers
  });
  res.end(body);
}

function readJsonBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limit = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function makeJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanMarkdownLine(line) {
  return String(line || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/^#+\s*/g, '')
    .replace(/^[>*\-\s`]+|[*`\s]+$/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function findPipelineToken(text) {
  const lines = String(text || '').split(/\r?\n/).map(cleanMarkdownLine).filter(Boolean);
  const joined = lines.join(' ').toUpperCase();
  const patterns = [
    /\b\d{2,4}-[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9_\/\\-]+\b/g,
    /\b[A-Z0-9]{1,8}(?:[-\/\\][A-Z0-9_]+){2,}\b/g
  ];
  for (const pattern of patterns) {
    const matches = joined.match(pattern) || [];
    const best = matches
      .map(item => item.replace(/\s+/g, ''))
      .filter(item => item.includes('-') && /[A-Z]/.test(item) && /\d/.test(item))
      .sort((a, b) => b.length - a.length)[0];
    if (best) return best;
  }
  return '';
}

function getMineruText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  const direct = payload.markdown ||
    payload.md ||
    payload.text ||
    payload.content ||
    payload.result_text ||
    (payload.data && getMineruText(payload.data)) ||
    (payload.result && getMineruText(payload.result)) ||
    (Array.isArray(payload.results) && payload.results.map(getMineruText).filter(Boolean).join('\n\n')) ||
    (Array.isArray(payload.files) && payload.files.map(getMineruText).filter(Boolean).join('\n\n')) ||
    (Array.isArray(payload.content_list) && payload.content_list.map(item => item.text || item.content || '').filter(Boolean).join('\n')) ||
    (payload.mineru_task && payload.mineru_task.markdown) ||
    '';
  return direct;
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[—–]/g, '-')
    .replace(/[：:|;,，]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCoordinateNumber(value) {
  const text = String(value || '').trim();
  const number = Number(text);
  if (!Number.isFinite(number)) return text.replace(/^\+/, '');
  return String(number);
}

function normalizeCoordinateLines(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[：:]/g, ' ')
    .split(/\n+/)
    .map(cleanMarkdownLine)
    .flatMap(line => line.split(/\s{2,}|\t+/))
    .map(line => normalizeText(line).toUpperCase())
    .filter(Boolean);
}

function extractCoordinateBlocks(text, options = {}) {
  const allowInferred = !!options.allowInferred;
  const markdown = String(text || '')
    .normalize('NFKC')
    .replace(/\r/g, '\n')
    .replace(/[：:]/g, ' ');
  const tokens = [];
  const pattern = /(?:^|[^A-Z0-9])(EL|E|S)(?:\b|(?=[+-]?\d))\s*([+-]?\d+(?:\.\d+)?)/gim;
  let match;
  while ((match = pattern.exec(markdown))) {
    tokens.push({
      index: match.index,
      label: match[1].toUpperCase(),
      value: match[2]
    });
  }

  const blocks = [];
  const seen = new Set();
  const addBlock = (e, s, el, blockOptions = {}) => {
    const key = `${e}|${s}|${el}`;
    if (seen.has(key)) return;
    blocks.push({
      e,
      s,
      el,
      key,
      numericKey: `${normalizeCoordinateNumber(e)}|${normalizeCoordinateNumber(s)}|${normalizeCoordinateNumber(el)}`,
      inferred: !!blockOptions.inferred,
      text: `E ${e}\nS ${s}\nEL ${el}`
    });
    seen.add(key);
  };

  for (let i = 0; i < tokens.length - 2; i += 1) {
    const a = tokens[i], b = tokens[i + 1], c = tokens[i + 2];
    if (a.label === 'E' && b.label === 'S' && c.label === 'EL') {
      addBlock(a.value, b.value, c.value);
      i += 2;
    }
  }

  if (allowInferred) {
    const lineTokens = normalizeCoordinateLines(markdown)
      .map(line => {
        const labelMatch = line.match(/^(EL|E|S)\s*[:：-]?\s*([+-]?\d+(?:\.\d+)?)$/i);
        if (labelMatch) return { label: labelMatch[1].toUpperCase(), value: labelMatch[2] };
        const numberMatch = line.match(/^([+-]?\d{4,}(?:\.\d+)?)$/);
        return numberMatch ? { label: '', value: numberMatch[1] } : null;
      })
      .filter(Boolean);

    for (let i = 0; i < lineTokens.length - 2; i += 1) {
      const group = [lineTokens[i], lineTokens[i + 1], lineTokens[i + 2]];
      const expected = ['E', 'S', 'EL'];
      const compatible = group.every((item, index) => !item.label || item.label === expected[index]);
      const hasMissingLabel = group.some(item => !item.label);
      const elHasPlusSign = /^\+/.test(String(group[2].value || '').trim());
      if (!compatible || !hasMissingLabel || !elHasPlusSign) continue;
      addBlock(group[0].value, group[1].value, group[2].value, { inferred: true });
      i += 2;
    }
  }

  return blocks;
}

function normalizeMarkerLine(line) {
  return normalizeText(cleanMarkdownLine(line))
    .toUpperCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isConnToLine(line) {
  return /\bCONN\.?\s*TO\b/.test(line);
}

function isContFromLine(line) {
  return /\bCONT\.?\s*FROM\b/.test(line);
}

function extractTrailingPageNumber(line) {
  const match = String(line || '').match(/\b(\d{1,4})\b\s*$/);
  return match ? Number(match[1]) : null;
}

function findNextStandalonePageNumber(lines, startIndex) {
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 5); index += 1) {
    const line = lines[index];
    if (!line) continue;
    const exact = line.match(/^(\d{1,4})$/);
    if (exact) return Number(exact[1]);
    if (/[A-Z]/.test(line) && line.includes('-')) return null;
  }
  return null;
}

function extractConnectionMarkers(text, page) {
  const lines = String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(normalizeMarkerLine)
    .filter(Boolean);
  const markers = [];
  lines.forEach((line, index) => {
    let type = '';
    if (isConnToLine(line)) type = 'connTo';
    if (isContFromLine(line)) type = 'contFrom';
    if (!type) return;
    const linkedPage = extractTrailingPageNumber(line) || findNextStandalonePageNumber(lines, index);
    if (!Number.isInteger(linkedPage) || linkedPage <= 0) return;
    markers.push({ type, page, linkedPage, sourceLine: line });
  });
  return markers;
}

function requestJson(options, bodyBuffer = null, timeoutMs = 4 * 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`${res.statusCode}: ${raw}`));
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${raw.slice(0, 300)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function buildMultipartPdfBody(pdfBuffer, filename, template, fields = {}) {
  const boundary = `----idfMineru${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const addText = (name, value) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  };
  Object.entries(fields).forEach(([key, value]) => addText(key, value));
  addText('template', JSON.stringify(template));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdf_file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'));
  chunks.push(pdfBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

function buildMineruFileParseBody(pdfBuffer, filename, fields = {}) {
  const boundary = `----idfMineru${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const addText = (name, value) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  };
  Object.entries(fields).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach(item => addText(key, item));
    else addText(key, value);
  });
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'));
  chunks.push(pdfBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

function buildLegacyMineruUploadBody(fileBuffer, filename, fields = {}) {
  const boundary = `----idfMineru${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const addText = (name, value) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  };
  Object.entries(fields).forEach(([key, value]) => addText(key, value));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdf_file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'));
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

function ensureMultipartTextField(body, contentType, name, value) {
  const bodyText = body.toString('binary');
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`name="${escapedName}"`).test(bodyText)) {
    return body;
  }
  const match = String(contentType || '').match(/boundary=([^;]+)/i);
  if (!match) return body;
  const boundary = match[1].trim().replace(/^"|"$/g, '');
  const closing = `--${boundary}--`;
  const index = bodyText.lastIndexOf(closing);
  if (index < 0) return body;
  const field = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  return Buffer.from(`${bodyText.slice(0, index)}${field}${bodyText.slice(index)}`, 'binary');
}

function buildMineruFileParseBodyFromLegacyMultipart(body, contentType) {
  const match = String(contentType || '').match(/boundary=([^;]+)/i);
  if (!match) throw new Error('Missing multipart boundary');
  const boundary = match[1].trim().replace(/^"|"$/g, '');
  const boundaryText = `--${boundary}`;
  let multipart = body.toString('binary')
    .replace(/name="pdf_file"/g, 'name="file"')
    .replace(/filename="([^"]+)\.pdf"/g, 'filename="$1.png"')
    .replace(/Content-Type: application\/pdf/gi, 'Content-Type: image/png');
  const fields = [
    ['backend', 'vlm-auto-engine'],
    ['method', 'vlm'],
    ['lang', 'ch']
  ];
  const extra = fields
    .map(([name, value]) => `${boundaryText}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('');
  multipart = multipart.replace(`${boundaryText}--`, `${extra}${boundaryText}--`);
  return {
    boundary,
    body: Buffer.from(multipart, 'binary')
  };
}

async function hydrateMineruMarkdown(result) {
  const taskId = result && (result.excel_task_id || result.task_id || result.export_task_id);
  if (!taskId || result.markdown) return result;
  try {
    const task = await requestJson({
      hostname: MINERU_HOST,
      port: MINERU_PORT,
      path: `/task/${encodeURIComponent(taskId)}`,
      method: 'GET'
    });
    if (task && task.markdown) return { ...result, markdown: task.markdown, mineru_task: task };
  } catch (error) {
    // Keep the original result when MinerU does not expose raw markdown.
  }
  return result;
}

async function pollMineruJob(jobId) {
  const started = Date.now();
  while (Date.now() - started < 4 * 60 * 60 * 1000) {
    const data = await requestJson({
      hostname: MINERU_HOST,
      port: MINERU_PORT,
      path: `/task/${encodeURIComponent(jobId)}`,
      method: 'GET'
    });
    if (data.status === 'done') return hydrateMineruMarkdown(data.result || data);
    if (data.status === 'error' || data.error) throw new Error(data.error || 'MinerU recognition failed');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('MinerU recognition timeout');
}

async function pollMineruPdfJob(jobId) {
  const started = Date.now();
  while (Date.now() - started < 4 * 60 * 60 * 1000) {
    const data = await requestJson({
      hostname: MINERU_HOST,
      port: MINERU_PORT,
      path: `/pdf/job/${encodeURIComponent(jobId)}`,
      method: 'GET'
    });
    if (data.status === 'done') return hydrateMineruMarkdown(data.result || data);
    if (data.status === 'error' || data.error) throw new Error(data.error || 'MinerU recognition failed');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('MinerU recognition timeout');
}

async function submitPdfToMineru(pdfBuffer, filename, pageNum, regionType, pageCount = 1) {
  const uploadName = filename.replace(/\.[^.]+$/, '') + '.pdf';
  const { boundary, body } = buildLegacyMineruUploadBody(pdfBuffer, uploadName, {
    backend: 'vlm-auto-engine',
    method: 'vlm',
    lang: 'ch',
    template: JSON.stringify({
      materialArea: { x: 0, y: 0, width: 1, height: 1, page: 1 },
      start_page: 1,
      end_page: pageCount,
      page_range: Array.from({ length: pageCount }, (_, index) => index + 1),
      idfSplitPointMode: true,
      idfRegionType: regionType,
      originalPage: pageNum
    }),
    region_type: regionType,
    original_page: String(pageNum),
    page_count: String(pageCount)
  });
  let submit;
  try {
    submit = await requestJson({
      hostname: MINERU_HOST,
      port: MINERU_PORT,
      path: '/pdf/recognize',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, body);
    if (!submit.success || !(submit.job_id || submit.excel_task_id || submit.task_id)) {
      throw new Error(submit.error || 'MinerU did not return job_id');
    }
    const jobId = submit.job_id || submit.excel_task_id || submit.task_id;
    const result = await pollMineruPdfJob(jobId);
    const markdown = getMineruText(result);
    return markdown ? { ...result, success: true, markdown } : result;
  } catch (error) {
    if (!/404|Not Found|Cannot POST|Cannot GET/i.test(error.message || '')) {
      throw error;
    }
  }

  submit = await requestJson({
    hostname: MINERU_HOST,
    port: MINERU_PORT,
    path: '/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  }, body);
  if (!submit.success || !submit.task_id) {
    throw new Error(submit.error || 'MinerU did not return task_id');
  }
  const result = await pollMineruJob(submit.task_id);
  const markdown = getMineruText(result);
  return markdown ? { ...result, success: true, markdown } : result;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

function getBase64TileList(item, baseField, listField) {
  const list = Array.isArray(item[listField]) ? item[listField].filter(Boolean) : [];
  if (list.length) return list;
  return item[baseField] ? [item[baseField]] : [];
}

function isEmptyMarkdownMineruError(error) {
  const message = String(error && error.message || error || '');
  return /未生成\s*Markdown|未返回\s*Markdown|图片可能太小|格式不支持|too small|unsupported|no markdown/i.test(message);
}

async function submitMineruTileSet(base64Tiles, filenamePrefix, pageNum, regionType) {
  if (!base64Tiles.length) return { success: true, markdown: '' };
  const tileErrors = [];
  const results = await mapWithConcurrency(base64Tiles, MINERU_CONCURRENCY, async (base64, index) => {
    const buffer = Buffer.from(base64, 'base64');
    const suffix = base64Tiles.length > 1 ? `_tile_${index + 1}` : '';
    try {
      return await submitPdfToMineru(buffer, `${filenamePrefix}${suffix}.png`, pageNum, `${regionType}${suffix}`, 1);
    } catch (error) {
      if (!isEmptyMarkdownMineruError(error)) throw error;
      const message = String(error && error.message || error || '');
      tileErrors.push({ index: index + 1, message });
      return { success: false, markdown: '', emptyTile: true, error: message };
    }
  });
  return {
    success: true,
    markdown: results.map(getMineruText).filter(Boolean).join('\n\n'),
    parallelResults: results,
    tileCount: base64Tiles.length,
    tileErrors
  };
}

async function processRecognitionJob(job) {
  try {
    job.status = 'running';
    job.stage = 'pipeline';
    job.updatedAt = Date.now();
    job.results = [];
    const total = job.uploads.length;
    let pipelineCompleted = 0;
    const pipelineResults = await mapWithConcurrency(job.uploads, MINERU_CONCURRENCY, async item => {
      if (job.cancelled) throw new Error('Recognition cancelled');
      job.updatedAt = Date.now();
      const pipelineTiles = getBase64TileList(item, 'pipelinePdfBase64', 'pipelineTileBase64List');
      const pipelineResult = await submitMineruTileSet(
        pipelineTiles,
        `idf_pipeline_page_${item.page}`,
        item.page,
        'pipeline-number'
      );
      const pipelineText = getMineruText(pipelineResult);
      pipelineCompleted += 1;
      job.progress = Math.round(pipelineCompleted / Math.max(1, total) * 45);
      job.message = `pipeline ${pipelineCompleted}/${total}`;
      job.updatedAt = Date.now();
      const result = {
        page: item.page,
        sourcePdf: job.sourcePdf || '',
        pipelineNumber: findPipelineToken(pipelineText),
        coordinateBlocks: [],
        connectionMarkers: [],
        pipelineText,
        splitPointText: '',
        splitPointAttempts: [],
        splitPointTileCount: 0,
        splitPointCropMode: '',
        raw: { pipeline: pipelineResult, splitPoint: null }
      };
      saveRecognitionLogEntry({
        reason: 'server-backend-pipeline',
        page: result.page,
        sourcePdf: result.sourcePdf,
        pipelineNumber: result.pipelineNumber || '',
        pipelineText,
        pipelinePayload: pipelineResult,
        coordinateBlocks: [],
        connectionMarkers: [],
        splitPointText: '',
        splitPointSkipped: true
      });
      return result;
    });
    job.results = pipelineResults.filter(Boolean);

    job.results.sort((a, b) => a.page - b.page);
    const counts = new Map();
    job.results.forEach(result => {
      if (!result.pipelineNumber) return;
      counts.set(result.pipelineNumber, (counts.get(result.pipelineNumber) || 0) + 1);
    });
    const byPage = new Map(job.uploads.map(item => [item.page, item]));
    let splitJobs = job.results.filter(result =>
      result.pipelineNumber && (counts.get(result.pipelineNumber) || 0) > 1
    );
    if (!splitJobs.length) {
      splitJobs = job.results.filter(result => result.pipelineNumber);
    }

    job.stage = 'split-point';
    let splitCompleted = 0;
    await mapWithConcurrency(splitJobs, MINERU_CONCURRENCY, async result => {
      if (job.cancelled) throw new Error('Recognition cancelled');
      const item = byPage.get(result.page);
      if (!item || (!item.splitPointPdfBase64 && !Array.isArray(item.splitPointTileBase64List))) return;
      job.updatedAt = Date.now();
      const splitTiles = getBase64TileList(item, 'splitPointPdfBase64', 'splitPointTileBase64List');
      const splitPointResult = await submitMineruTileSet(
        splitTiles,
        `idf_split_point_page_${result.page}`,
        result.page,
        'split-point'
      );
      result.splitPointText = getMineruText(splitPointResult);
      result.coordinateBlocks = extractCoordinateBlocks(result.splitPointText);
      result.connectionMarkers = extractConnectionMarkers(result.splitPointText, result.page);
      result.splitPointAttempts = [result.splitPointText];
      result.splitPointTileCount = item.splitPointPageCount || 1;
      result.splitPointCropMode = item.splitPointCropMode || '';
      result.raw = { ...result.raw, splitPoint: splitPointResult };
      saveRecognitionLogEntry({
        reason: 'server-backend-split-point',
        page: result.page,
        sourcePdf: result.sourcePdf || job.sourcePdf || '',
        pipelineNumber: result.pipelineNumber || '',
        coordinateBlockCount: result.coordinateBlocks.length,
        coordinateBlocks: result.coordinateBlocks,
        connectionMarkers: result.connectionMarkers,
        pipelineText: result.pipelineText || '',
        splitPointText: result.splitPointText || '',
        splitPointAttempts: result.splitPointAttempts,
        splitPointTileCount: result.splitPointTileCount,
        splitPointCropMode: result.splitPointCropMode,
        raw: result.raw
      });
      splitCompleted += 1;
      job.progress = 45 + Math.round(splitCompleted / Math.max(1, splitJobs.length) * 50);
      job.message = `split-point ${splitCompleted}/${splitJobs.length}`;
      job.updatedAt = Date.now();
    });

    job.status = 'done';
    job.progress = 100;
    job.message = 'done';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = job.cancelled ? 'cancelled' : 'error';
    job.error = error.message;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  } finally {
    job.uploads = [];
  }
}

async function startRecognitionJob(req, res) {
  try {
    const body = await readJsonBody(req, 300 * 1024 * 1024);
    if (!Array.isArray(body.uploads) || !body.uploads.length) {
      send(res, 400, JSON.stringify({ ok: false, error: 'No uploads' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
      return;
    }
    const id = makeJobId();
    const job = {
      id,
      status: 'queued',
      progress: 0,
      message: 'queued',
      sourcePdf: body.sourcePdf || '',
      pages: body.pages || [],
      uploads: body.uploads,
      results: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    RECOGNITION_JOBS.set(id, job);
    processRecognitionJob(job);
    send(res, 200, JSON.stringify({ ok: true, jobId: id }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
}

function readRecognitionJob(req, res) {
  const match = new URL(req.url, `http://${req.headers.host}`).pathname.match(/^\/idf-recognition\/job\/([^/]+)$/);
  const job = match ? RECOGNITION_JOBS.get(decodeURIComponent(match[1])) : null;
  if (!job) {
    send(res, 404, JSON.stringify({ ok: false, error: 'Job not found' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }
  send(res, 200, JSON.stringify({
    ok: true,
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    error: job.error,
    results: job.results,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt
  }), { 'Content-Type': 'application/json; charset=utf-8' });
}

function cancelRecognitionJob(req, res) {
  const match = new URL(req.url, `http://${req.headers.host}`).pathname.match(/^\/idf-recognition\/job\/([^/]+)\/cancel$/);
  const job = match ? RECOGNITION_JOBS.get(decodeURIComponent(match[1])) : null;
  if (!job) {
    send(res, 404, JSON.stringify({ ok: false, error: 'Job not found' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }
  job.cancelled = true;
  send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json; charset=utf-8' });
}

setInterval(() => {
  const now = Date.now();
  RECOGNITION_JOBS.forEach((job, id) => {
    if (job.status !== 'running' && job.status !== 'queued' && now - (job.finishedAt || job.updatedAt || job.createdAt) > RECOGNITION_JOB_TTL) {
      RECOGNITION_JOBS.delete(id);
    }
  });
}, 30 * 60 * 1000).unref();

function safeName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'unknown';
}

function saveRecognitionLogEntry(body) {
  fs.mkdirSync(LOG_ROOT, { recursive: true });
  const imageRoot = path.join(LOG_ROOT, 'images');
  fs.mkdirSync(imageRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const page = safeName(body.page);
  const pipeline = safeName(body.pipelineNumber);
  const fileName = `${stamp}_page-${page}_${pipeline}.json`;
  const filePath = path.join(LOG_ROOT, fileName);
  const savedImages = {};
  if (body.images && typeof body.images === 'object') {
    Object.entries(body.images).forEach(([key, dataUrl]) => {
      const match = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
      if (!match) return;
      const imageName = `${stamp}_page-${page}_${pipeline}_${safeName(key)}.png`;
      fs.writeFileSync(path.join(imageRoot, imageName), Buffer.from(match[1], 'base64'));
      savedImages[key] = path.join('images', imageName);
    });
    delete body.images;
  }
  fs.writeFileSync(filePath, JSON.stringify({
    ...body,
    savedImages,
    savedAt: new Date().toISOString()
  }, null, 2), 'utf8');
  return fileName;
}

async function writeRecognitionLog(req, res) {
  try {
    const body = await readJsonBody(req);
    const fileName = saveRecognitionLogEntry(body);
    send(res, 200, JSON.stringify({ ok: true, file: fileName }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
}

async function processMineruCompatJob(job, legacyBody, legacyContentType) {
  try {
    job.status = 'running';
    job.stage = 'MinerU 正在识别';
    job.progress = 15;
    job.updatedAt = Date.now();
    const contentType = legacyContentType || 'multipart/form-data';
    const defaultTemplate = JSON.stringify({
      materialArea: { x: 0, y: 0, width: 1, height: 1, page: 1 },
      start_page: 1,
      end_page: 1,
      page_range: [1],
      idfSplitPointMode: true,
      idfRegionType: 'idf-region'
    });
    let compatBody = ensureMultipartTextField(legacyBody, contentType, 'template', defaultTemplate);
    compatBody = ensureMultipartTextField(compatBody, contentType, 'lang', 'ch');
    let result;
    try {
      result = await requestJson({
        hostname: MINERU_HOST,
        port: MINERU_PORT,
        path: '/pdf/recognize',
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': compatBody.length
        }
      }, compatBody);
      if (!result.success || !(result.job_id || result.excel_task_id || result.task_id)) {
        throw new Error(result.error || 'MinerU did not return job_id');
      }
      const jobId = result.job_id || result.excel_task_id || result.task_id;
      result = await pollMineruPdfJob(jobId);
    } catch (error) {
      if (!/404|Not Found|Cannot POST|Cannot GET/i.test(error.message || '')) {
        throw error;
      }
      const upload = await requestJson({
        hostname: MINERU_HOST,
        port: MINERU_PORT,
        path: '/upload',
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': compatBody.length
        }
      }, compatBody);
      if (!upload.success || !upload.task_id) {
        throw new Error(upload.error || 'MinerU did not return task_id');
      }
      result = await pollMineruJob(upload.task_id);
    }
    const markdown = getMineruText(result);
    job.status = 'done';
    job.stage = 'done';
    job.progress = 100;
    job.result = markdown ? { ...result, success: true, markdown } : result;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  }
}
async function startMineruCompatJob(req, res) {
  try {
    const body = await readRawBody(req);
    const id = makeJobId();
    const job = {
      id,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    MINERU_COMPAT_JOBS.set(id, job);
    processMineruCompatJob(job, body, req.headers['content-type'] || '');
    send(res, 200, JSON.stringify({ success: true, job_id: id, jobId: id }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ success: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
}

function readMineruCompatJob(req, res) {
  const match = new URL(req.url, `http://${req.headers.host}`).pathname.match(/^\/mineru\/pdf\/job\/([^/]+)$/);
  const job = match ? MINERU_COMPAT_JOBS.get(decodeURIComponent(match[1])) : null;
  if (!job) {
    send(res, 404, JSON.stringify({ status: 'error', error: 'Job not found' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }
  send(res, 200, JSON.stringify({
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    result: job.result
  }), { 'Content-Type': 'application/json; charset=utf-8' });
}

setInterval(() => {
  const now = Date.now();
  MINERU_COMPAT_JOBS.forEach((job, id) => {
    if (job.status !== 'running' && job.status !== 'queued' && now - (job.finishedAt || job.updatedAt || job.createdAt) > RECOGNITION_JOB_TTL) {
      MINERU_COMPAT_JOBS.delete(id);
    }
  });
}, 30 * 60 * 1000).unref();

function proxyMineru(req, res) {
  const targetPath = req.url.replace(/^\/mineru(?=\/|$)/, '') || '/';
  const proxyReq = http.request({
    hostname: MINERU_HOST,
    port: MINERU_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${MINERU_HOST}:${MINERU_PORT}`
    }
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', error => {
    send(res, 502, JSON.stringify({ ok: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  });

  req.pipe(proxyReq);
}

function proxyOcr(req, res) {
  const targetPath = req.url.replace(/^\/ocr(?=\/|$)/, '') || '/';
  const proxyReq = http.request({
    hostname: OCR_HOST,
    port: OCR_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${OCR_HOST}:${OCR_PORT}`
    }
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', error => {
    send(res, 502, JSON.stringify({ ok: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  });

  req.pipe(proxyReq);
}

function serveFile(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (requestPath === '/health') {
    send(res, 200, JSON.stringify({
      ok: true,
      tool: 'idf-mineru-region-tool',
      mineru: `http://${MINERU_HOST}:${MINERU_PORT}`,
      ocr: `http://${OCR_HOST}:${OCR_PORT}`
    }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  const filePath = VENDOR_FILES[requestPath] || path.join(ROOT, requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, ''));
  const resolved = path.resolve(filePath);
  const allowedVendor = Object.values(VENDOR_FILES).some(vendor => path.resolve(vendor) === resolved);
  if (!allowedVendor && !resolved.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      send(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    send(res, 200, data, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 200, '');
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/log-recognition')) {
    writeRecognitionLog(req, res);
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/idf-recognition/start')) {
    startRecognitionJob(req, res);
    return;
  }

  if (req.method === 'POST' && req.url.match(/^\/idf-recognition\/job\/[^/]+\/cancel$/)) {
    cancelRecognitionJob(req, res);
    return;
  }

  if (req.method === 'GET' && req.url.match(/^\/idf-recognition\/job\/[^/]+$/)) {
    readRecognitionJob(req, res);
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/mineru/pdf/recognize')) {
    startMineruCompatJob(req, res);
    return;
  }

  if (req.method === 'GET' && req.url.match(/^\/mineru\/pdf\/job\/[^/]+$/)) {
    readMineruCompatJob(req, res);
    return;
  }

  if (req.url.startsWith('/mineru/')) {
    proxyMineru(req, res);
    return;
  }

  if (req.url.startsWith('/ocr/')) {
    proxyOcr(req, res);
    return;
  }

  serveFile(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`IDF MinerU region tool listening on http://${HOST}:${PORT}`);
  console.log(`MinerU proxy -> http://${MINERU_HOST}:${MINERU_PORT}`);
  console.log(`OCR proxy -> http://${OCR_HOST}:${OCR_PORT}`);
});
