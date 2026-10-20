const {createPdfExportOptimizer} = require('./pdf_export_optimizer');
const pdfExportOptimizer = createPdfExportOptimizer();
﻿const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const { createPdfPageCacheService } = require('./pdf_page_cache_service');
const { buildDocumentAnnotationStats } = require('./audit_document_annotation_stats');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3005);
const ROOT = path.resolve(__dirname, '..', process.env.STATIC_ROOT || 'build_prod');
const AUDIT_DIR = path.resolve(
  __dirname,
  '..',
  process.env.AUDIT_DIR || path.join('runtime', 'audit-logs')
);
const AUDIT_CORRECTIONS_FILE = path.resolve(AUDIT_DIR, 'audit-corrections.json');
const PROCESSING_LOG_DIR = path.resolve(
  __dirname,
  '..',
  process.env.PROCESSING_LOG_DIR || path.join('runtime', 'processing-logs')
);
const pdfPageCacheService = (process.env.ENABLE_PDF_PAGE_CACHE === '1' || PORT === 3005)
  ? createPdfPageCacheService({ rootDir: path.resolve(__dirname, '..') })
  : null;
const OCR_CONNECTION_LOG_FILE = path.resolve(PROCESSING_LOG_DIR, 'latest-ocr-connection.log');
const AUTOSAVE_TARGET_HOST = process.env.AUTOSAVE_TARGET_HOST || '127.0.0.1';
const AUTOSAVE_TARGET_PORT = Number(process.env.AUTOSAVE_TARGET_PORT || 8789);
const SUPPORT_TARGET_HOST = process.env.SUPPORT_TARGET_HOST || '127.0.0.1';
const SUPPORT_TARGET_PORT = Number(process.env.SUPPORT_TARGET_PORT || 8788);
const OCR_TARGET_HOST = process.env.OCR_TARGET_HOST || '127.0.0.1';
const OCR_TARGET_PORT = Number(process.env.OCR_TARGET_PORT || 8766);
const OCR_TASK_QUEUE_LIMIT = Number(process.env.OCR_TASK_QUEUE_LIMIT || 8);
const OCR_TASK_TOTAL_TIMEOUT_MS = Number(process.env.OCR_TASK_TOTAL_TIMEOUT_MS || 15 * 60 * 1000);
const OCR_CIRCUIT_FAILURE_LIMIT = Number(process.env.OCR_CIRCUIT_FAILURE_LIMIT || 3);
const OCR_CIRCUIT_PAUSE_MS = Number(process.env.OCR_CIRCUIT_PAUSE_MS || 60 * 1000);
// PaddleOCR has one engine. Keep one reusable upstream task socket so all
// browser clients share a bounded serial queue instead of creating hundreds
// of simultaneous TCP connections to port 8766.
const OCR_TASK_AGENT = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
const OCR_CONTROL_AGENT = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
const OCR_AUX_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 2 });
let ocrConsecutiveFailures = 0;
let ocrCircuitOpenUntil = 0;
let activeOcrWebSockets = 0;
const ACTIVE_OCR_TASK_IDS = new Set();
const MINERU_TARGET_HOST = process.env.MINERU_TARGET_HOST || '127.0.0.1';
const MINERU_TARGET_PORT = Number(process.env.MINERU_TARGET_PORT || 8081);
const WELD_AI_TARGET_HOST = process.env.WELD_AI_TARGET_HOST || '127.0.0.1';
const WELD_AI_TARGET_PORT = Number(process.env.WELD_AI_TARGET_PORT || 8767);
const ERP_SSO_SECRET = process.env.ERP_SSO_SECRET || '85plTxXe5pQWd5SndFATb6QKXv7Eqeaxkg_lb9DLcTPUPWvOMmoLGMdISOEguPrj';
const ERP_SSO_TOKEN_TTL_MS = Number(process.env.ERP_SSO_TOKEN_TTL_MS || 5 * 60 * 1000);
const ERP_SSO_SESSION_TTL_SECONDS = Number(process.env.ERP_SSO_SESSION_TTL_SECONDS || 30 * 24 * 60 * 60);
const ERP_SSO_COOKIE_NAME = process.env.ERP_SSO_COOKIE_NAME || 'luotu_erp_sso';
const MAX_AUDIT_ROWS = Number(process.env.MAX_AUDIT_ROWS || 1000);
const AUDIT_STATS_DAYS = Number(process.env.AUDIT_STATS_DAYS || 90);

const enforceProcessingLogRetention = () => {
  try {
    fs.mkdirSync(PROCESSING_LOG_DIR, { recursive: true });
    const latestLayoutName = 'latest-automatic-layout.log';
    const latestMaterialName = 'latest-material-recognition.json';
    const latestSpecialBlockName = 'latest-special-block-recognition.json';
    const latestOcrConnectionName = 'latest-ocr-connection.log';
    const files = fs.readdirSync(PROCESSING_LOG_DIR);
    if (!files.includes(latestLayoutName)) {
      const legacyLayouts = files
        .filter(file => /^automatic-layout-.*\.log$/i.test(file))
        .map(file => ({
          file,
          mtimeMs: fs.statSync(path.join(PROCESSING_LOG_DIR, file)).mtimeMs
        }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
      if (legacyLayouts[0]) {
        const content = fs.readFileSync(path.join(PROCESSING_LOG_DIR, legacyLayouts[0].file), 'utf8');
        const marker = '自动落图诊断日志';
        const latestSessionStart = content.lastIndexOf(marker);
        fs.writeFileSync(
          path.join(PROCESSING_LOG_DIR, latestLayoutName),
          latestSessionStart >= 0 ? content.slice(latestSessionStart).trimEnd() + '\n' : content,
          'utf8'
        );
      }
    }
    const retained = new Set([latestLayoutName, latestMaterialName, latestSpecialBlockName, latestOcrConnectionName]);
    fs.readdirSync(PROCESSING_LOG_DIR).forEach(file => {
      if (!retained.has(file)) fs.unlinkSync(path.join(PROCESSING_LOG_DIR, file));
    });
  } catch (error) {
    console.warn('[processing-log] retention cleanup failed:', error.message);
  }
};

enforceProcessingLogRetention();

const writeOcrConnectionLog = event => {
  try {
    fs.mkdirSync(PROCESSING_LOG_DIR, { recursive: true });
    if (fs.existsSync(OCR_CONNECTION_LOG_FILE) && fs.statSync(OCR_CONNECTION_LOG_FILE).size > 5 * 1024 * 1024) {
      const lines = fs.readFileSync(OCR_CONNECTION_LOG_FILE, 'utf8').trim().split(/\r?\n/);
      fs.writeFileSync(OCR_CONNECTION_LOG_FILE, `${lines.slice(-5000).join('\n')}\n`, 'utf8');
    }
    fs.appendFile(OCR_CONNECTION_LOG_FILE, `${JSON.stringify(event)}\n`, error => {
      if (error) console.warn('[ocr-log] append failed:', error.message);
    });
  } catch (error) {
    console.warn('[ocr-log] write failed:', error.message);
  }
};
const LOCAL_AUDIT_IPS = new Set(
  // 192.168.9.1 is a normal user network address (linwei), not a test client.
  // Keep only the service host and loopback addresses out of production statistics.
  String(process.env.LOCAL_AUDIT_IPS || '192.168.32.61,127.0.0.1,::1')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean)
);
const AUDIT_EXCLUDED_ERP_USERS = new Set(
  String(process.env.AUDIT_EXCLUDED_ERP_USERS || '')
    .split(',')
    .map(user => user.trim().toLowerCase())
    .filter(Boolean)
);

const normalizeErpUser = value => String(value || '').trim().toLowerCase();
const isAuditExcludedErpUser = value => AUDIT_EXCLUDED_ERP_USERS.has(normalizeErpUser(value));
const isAuditExcludedEntry = entry => isAuditExcludedErpUser(
  entry?.erpUser || entry?.details?.erpUser || ''
);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const send = (res, statusCode, body, headers = {}) => {
  if (!res || res.destroyed || res.writableEnded) return false;
  try {
    if (!res.headersSent) {
      res.writeHead(statusCode, {
        'Access-Control-Allow-Origin': '*',
        ...headers
      });
    }
    res.end(body);
    return true;
  } catch (error) {
    console.warn('[http] response already closed:', error.message);
    return false;
  }
};

const writeAuditEntry = entry => {
  try {
    ensureAuditDir();
    const time = entry.time ? new Date(entry.time) : new Date();
    const fileName = `access-${time.toISOString().slice(0, 10)}.jsonl`;
    const persistedEntry = { ...entry, time: time.toISOString() };
    fs.appendFile(
      path.join(AUDIT_DIR, fileName),
      `${JSON.stringify(persistedEntry)}\n`,
      error => {
        if (error) {
          console.error('[audit] write failed:', error.message);
          return;
        }
        rememberAuditClientIdentity(persistedEntry);
      }
    );
  } catch (error) {
    console.error('[audit] write failed:', error.message);
  }
};

const ensureAuditDir = () => {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }
};

const getClientIp = req => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    return String(forwardedFor).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
};

const base64UrlEncode = value => Buffer.from(value, 'utf8').toString('base64url');

const signSsoPayload = payloadText => crypto
  .createHmac('sha256', ERP_SSO_SECRET)
  .update(payloadText)
  .digest('hex');

const safeCompare = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyAccessToken = token => {
  const [payloadText, signature, extra] = String(token || '').split('.');
  if (!payloadText || !signature || extra !== undefined) {
    throw new Error('access_token 格式无效');
  }

  const expected = signSsoPayload(payloadText);
  if (!safeCompare(signature, expected)) {
    throw new Error('access_token 签名无效');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
  } catch {
    throw new Error('access_token 内容无法解析');
  }

  const erpUser = String(payload.erpUser || '').trim().toLowerCase();
  const ts = Number(payload.ts);
  if (!erpUser) {
    throw new Error('access_token 缺少 erpUser');
  }
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > ERP_SSO_TOKEN_TTL_MS) {
    throw new Error('access_token 已过期');
  }

  return {
    erpUser,
    ts,
    nonce: String(payload.nonce || ''),
    loginAt: new Date().toISOString()
  };
};

const buildSsoSessionCookie = session => {
  const payloadText = base64UrlEncode(JSON.stringify(session));
  return `${payloadText}.${signSsoPayload(payloadText)}`;
};

const parseCookies = req => {
  const cookies = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  });
  return cookies;
};

const getSsoSessionFromRequest = req => {
  const token = parseCookies(req)[ERP_SSO_COOKIE_NAME];
  if (!token) return null;
  try {
    const [payloadText, signature, extra] = token.split('.');
    if (!payloadText || !signature || extra !== undefined) return null;
    if (!safeCompare(signature, signSsoPayload(payloadText))) return null;
    const session = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
    if (!session.erpUser) return null;
    return session;
  } catch {
    return null;
  }
};

const setSsoCookie = (res, session) => {
  const cookieValue = encodeURIComponent(buildSsoSessionCookie(session));
  res.setHeader(
    'Set-Cookie',
    `${ERP_SSO_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ERP_SSO_SESSION_TTL_SECONDS}`
  );
};

const handleSsoAccessToken = (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return false;
  }

  const accessToken = parsedUrl.searchParams.get('access_token');
  if (!accessToken) {
    return false;
  }

  try {
    const session = verifyAccessToken(accessToken);
    setSsoCookie(res, session);
    parsedUrl.searchParams.delete('access_token');
    const redirectTo = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}` || '/';
    if (!isAuditExcludedErpUser(session.erpUser)) {
      writeAuditEntry({
        time: new Date().toISOString(),
        method: req.method,
        path: parsedUrl.pathname,
        url: req.url,
        category: 'sso-login',
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'] || '',
        referer: req.headers.referer || req.headers.referrer || '',
        statusCode: 302,
        durationMs: 0,
        erpUser: session.erpUser
      });
    }
    res.writeHead(302, {
      Location: redirectTo || '/',
      'Cache-Control': 'no-store'
    });
    res.end();
  } catch (error) {
    send(res, 401, JSON.stringify({ ok: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }
  return true;
};

const handleSsoMe = (req, res) => {
  const session = getSsoSessionFromRequest(req);
  // Sliding session: every successful page refresh renews the signed ERP
  // cookie, so a normal long-running workstation session does not become
  // anonymous after the old eight-hour limit.
  if (session) setSsoCookie(res, session);
  send(res, 200, JSON.stringify({
    ok: true,
    authenticated: !!session,
    user: session ? {
      erpUser: session.erpUser,
      loginAt: session.loginAt || ''
    } : null
  }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
};

const normalizeAuditIp = ip => {
  const value = String(ip || '').trim();
  return value.startsWith('::ffff:') ? value.slice(7) : value;
};

const isLocalAuditIp = ip => LOCAL_AUDIT_IPS.has(normalizeAuditIp(ip));

const getRequestPath = req => {
  try {
    return new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return req.url || '';
  }
};

const getAuditCategory = req => {
  const requestPath = getRequestPath(req);
  if (requestPath === '/ocr-text-detect-upload') return 'ocr-text';
  if (requestPath === '/api/admin/audit/event') return 'user-event';
  if (requestPath.startsWith('/api/autosave/')) return 'autosave';
  if (requestPath === '/health') return 'health';
  if (requestPath.startsWith('/api/admin/audit/')) return 'admin-api';
  if (requestPath === '/admin') return 'admin-page';
  return 'other';
};

const shouldAudit = req => {
  return false;
};

const auditRequest = req => {
  if (!shouldAudit(req)) {
    return () => {};
  }

  const startedAt = Date.now();
  const requestPath = getRequestPath(req);
  const entry = {
    time: new Date(startedAt).toISOString(),
    method: req.method,
    path: requestPath,
    url: req.url,
    category: getAuditCategory(req),
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || '',
    referer: req.headers.referer || req.headers.referrer || ''
  };

  return res => {
    const doneAt = Date.now();
    const finalEntry = {
      ...entry,
      statusCode: res.statusCode,
      durationMs: doneAt - startedAt,
      contentLength: res.getHeader('content-length') || ''
    };

    writeAuditEntry(finalEntry);
  };
};

const readJsonBody = (req, maxBytes = 1024 * 64) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      reject(new Error('Payload too large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!body) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new Error('Invalid JSON'));
    }
  });
  req.on('error', reject);
});

const handleSpecialBlockRecognitionLog = async (req, res) => {
  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }
  try {
    const payload = await readJsonBody(req, 20 * 1024 * 1024);
    fs.mkdirSync(PROCESSING_LOG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PROCESSING_LOG_DIR, 'latest-special-block-recognition.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    );
    send(res, 200, JSON.stringify({ ok: true }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
};

const loadH3yunCredentials = () => {
  const candidates = [
    path.resolve(__dirname, '..', 'ocr_server', 'settings.json'),
    path.resolve(__dirname, '..', 'ocr_server', 'python', 'settings.json')
  ];

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (config.h3yun_engine_code || config.h3yun_engine_secret) {
        return {
          engineCode: config.h3yun_engine_code || '',
          engineSecret: config.h3yun_engine_secret || ''
        };
      }
    } catch (error) {
      console.warn('[h3yun] failed to read config:', filePath, error.message);
    }
  }

  return {
    engineCode: process.env.H3YUN_ENGINE_CODE || '',
    engineSecret: process.env.H3YUN_ENGINE_SECRET || ''
  };
};

const handleH3yunProxy = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      send(res, 405, JSON.stringify({ success: false, error: 'Method not allowed' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
      return;
    }

    const requestData = await readJsonBody(req, 1024 * 1024);
    const targetUrl = requestData.url;
    const body = requestData.body || {};
    if (!targetUrl) {
      send(res, 400, JSON.stringify({ success: false, error: 'Missing url' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
      return;
    }

    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:' || !/(\.|^)h3yun\.com$/i.test(parsedUrl.hostname)) {
      send(res, 400, JSON.stringify({ success: false, error: 'Unsupported h3yun target' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
      return;
    }

    const credentials = loadH3yunCredentials();
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        EngineCode: credentials.engineCode,
        EngineSecret: credentials.engineSecret,
        Accept: 'application/json'
      },
      timeout: 30000
    };

    const proxyReq = https.request(options, proxyRes => {
      let responseBody = '';
      proxyRes.on('data', chunk => {
        responseBody += chunk;
      });
      proxyRes.on('end', () => {
        let result = {};
        try {
          result = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          send(res, 502, JSON.stringify({ success: false, error: 'Invalid h3yun response', raw: responseBody.slice(0, 1000) }), {
            'Content-Type': 'application/json; charset=utf-8'
          });
          return;
        }

        if ((proxyRes.statusCode || 500) === 200) {
          if (result.Successful === true) {
            send(res, 200, JSON.stringify({ success: true, data: result }), {
              'Content-Type': 'application/json; charset=utf-8'
            });
          } else {
            send(res, 200, JSON.stringify({
              success: false,
              error: result.ErrorMessage || result.Message || 'h3yun request failed',
              data: result
            }), {
              'Content-Type': 'application/json; charset=utf-8'
            });
          }
        } else {
          send(res, proxyRes.statusCode || 502, JSON.stringify({
            success: false,
            error: `HTTP ${proxyRes.statusCode || 502}`,
            data: result
          }), {
            'Content-Type': 'application/json; charset=utf-8'
          });
        }
      });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('h3yun request timeout'));
    });
    proxyReq.on('error', error => {
      send(res, 502, JSON.stringify({ success: false, error: error.message }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    });
    proxyReq.write(payload);
    proxyReq.end();
  } catch (error) {
    send(res, 500, JSON.stringify({ success: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
};

const sanitizeAuditPayload = payload => {
  const safe = {};
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (value === undefined || typeof value === 'function') return;
    if (typeof value === 'string') {
      safe[key] = value.slice(0, 500);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      safe[key] = value;
      return;
    }
    try {
      const cloned = JSON.parse(JSON.stringify(value));
      const json = JSON.stringify(cloned);
      safe[key] = json.length > 20000
        ? { truncated: true, preview: json.slice(0, 20000) }
        : cloned;
    } catch {
      safe[key] = String(value).slice(0, 500);
    }
  });
  return safe;
};

const handleAuditEvent = async (req, res) => {
  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }

  try {
    const rawPayload = await readJsonBody(req, 5 * 1024 * 1024);
    const rawEvents = Array.isArray(rawPayload?.events)
      ? rawPayload.events.slice(0, 500)
      : [rawPayload];
    const ssoSession = getSsoSessionFromRequest(req);
    let accepted = 0;
    let excluded = 0;
    rawEvents.forEach(rawEvent => {
      const payload = sanitizeAuditPayload(rawEvent);
      const clientId = String(payload.clientId || '').trim();
      const erpUser = ssoSession?.erpUser || payload.erpUser || getAuditClientIdentityMap().get(clientId) || '';
      if (isAuditExcludedErpUser(erpUser)) {
        excluded += 1;
        return;
      }
      writeAuditEntry({
        time: new Date().toISOString(),
        method: req.method,
        path: '/api/admin/audit/event',
        url: req.url,
        category: 'user-event',
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'] || '',
        referer: req.headers.referer || req.headers.referrer || '',
        statusCode: 200,
        durationMs: 0,
        action: payload.action || 'unknown',
        erpUser,
        projectId: payload.projectId || '',
        projectName: payload.projectName || '',
        pdfFileName: payload.pdfFileName || '',
        page: payload.page || '',
        count: payload.count || '',
        details: payload
      });
      accepted += 1;
      if (payload.action === 'material_table_recognize') {
        fs.mkdirSync(PROCESSING_LOG_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(PROCESSING_LOG_DIR, 'latest-material-recognition.json'),
          JSON.stringify({
            savedAt: new Date().toISOString(),
            action: payload.action,
            erpUser,
            result: rawEvent
          }, null, 2),
          'utf8'
        );
      }
    });
    send(res, 200, JSON.stringify({ ok: true, accepted, excluded }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: error.message }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
};

const parseAuditDateFromFileName = file => {
  const match = /^access-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
  return match ? match[1] : '';
};

const getAuditDateRange = query => {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - Math.max(1, AUDIT_STATS_DAYS) + 1);
  const normalizeDate = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '');
  return {
    from: normalizeDate(query?.get?.('from')) || defaultFrom.toISOString().slice(0, 10),
    to: normalizeDate(query?.get?.('to')) || now.toISOString().slice(0, 10)
  };
};

const readAuditEntries = (limit = Infinity, dateRange = null) => {
  ensureAuditDir();
  const files = fs.readdirSync(AUDIT_DIR)
    .filter(file => /^access-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
    .filter(file => {
      if (!dateRange) return true;
      const date = parseAuditDateFromFileName(file);
      return (!dateRange.from || date >= dateRange.from) && (!dateRange.to || date <= dateRange.to);
    })
    .sort()
    .reverse();

  const entries = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(AUDIT_DIR, file), 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // ignore broken lines
      }
      if (entries.length >= limit) {
        return enrichAuditEntriesWithClientIdentity(applyAuditCorrections(entries));
      }
    }
  }
  return enrichAuditEntriesWithClientIdentity(applyAuditCorrections(entries));
};

let auditCorrectionsCache = { mtimeMs: -1, corrections: new Map() };

const getAuditCorrections = () => {
  if (!fs.existsSync(AUDIT_CORRECTIONS_FILE)) return new Map();
  const stat = fs.statSync(AUDIT_CORRECTIONS_FILE);
  if (auditCorrectionsCache.mtimeMs === stat.mtimeMs) {
    return auditCorrectionsCache.corrections;
  }
  try {
    const source = JSON.parse(fs.readFileSync(AUDIT_CORRECTIONS_FILE, 'utf8'));
    const corrections = new Map(
      (Array.isArray(source) ? source : source.corrections || [])
        .filter(item => item?.time)
        .map(item => [String(item.time), item])
    );
    auditCorrectionsCache = { mtimeMs: stat.mtimeMs, corrections };
    return corrections;
  } catch (error) {
    console.warn('[audit] failed to load corrections:', error.message);
    return new Map();
  }
};

const applyAuditCorrections = entries => {
  const corrections = getAuditCorrections();
  if (corrections.size === 0) return entries;
  return entries.map(entry => {
    const correction = corrections.get(String(entry.time || ''));
    if (!correction) return entry;
    const correctedDetails = {
      ...(entry.details || {}),
      ...(correction.details || {}),
      auditCorrection: {
        reason: correction.reason || '',
        originalAction: entry.action || '',
        originalCount: entry.count || entry.details?.count || ''
      }
    };
    return {
      ...entry,
      ...(correction.action ? { action: correction.action } : {}),
      ...(correction.count !== undefined ? { count: correction.count } : {}),
      ...(correction.page !== undefined ? { page: correction.page } : {}),
      details: correctedDetails
    };
  });
};

let auditClientIdentityCache = {
  initialized: false,
  identities: new Map(),
  candidates: new Map()
};

function rememberAuditClientIdentity(entry) {
  if (!auditClientIdentityCache.initialized) return;
  const clientId = String(entry?.details?.clientId || '').trim();
  const erpUser = String(entry?.erpUser || entry?.details?.erpUser || '').trim().toLowerCase();
  if (!clientId || !erpUser) return;

  let users = auditClientIdentityCache.candidates.get(clientId);
  if (!users) {
    users = new Set();
    auditClientIdentityCache.candidates.set(clientId, users);
  }
  users.add(erpUser);
  if (users.size === 1) {
    auditClientIdentityCache.identities.set(clientId, erpUser);
  } else {
    auditClientIdentityCache.identities.delete(clientId);
  }
}

const getAuditClientIdentityMap = () => {
  if (auditClientIdentityCache.initialized) {
    return auditClientIdentityCache.identities;
  }

  ensureAuditDir();
  const files = fs.readdirSync(AUDIT_DIR)
    .filter(file => /^access-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
    .sort();

  const candidates = new Map();
  files.forEach(file => {
    const content = fs.readFileSync(path.join(AUDIT_DIR, file), 'utf8');
    content.split(/\r?\n/).filter(Boolean).forEach(line => {
      try {
        const entry = JSON.parse(line);
        const clientId = String(entry?.details?.clientId || '').trim();
        const erpUser = String(entry?.erpUser || entry?.details?.erpUser || '').trim().toLowerCase();
        if (!clientId || !erpUser) return;
        if (!candidates.has(clientId)) candidates.set(clientId, new Set());
        candidates.get(clientId).add(erpUser);
      } catch {
        // Ignore malformed historical audit lines.
      }
    });
  });

  const identities = new Map();
  candidates.forEach((users, clientId) => {
    // Historical attribution is applied only when the browser client maps to
    // exactly one ERP account. Ambiguous clients remain anonymous.
    if (users.size === 1) identities.set(clientId, Array.from(users)[0]);
  });
  auditClientIdentityCache = { initialized: true, identities, candidates };
  return identities;
};

function enrichAuditEntriesWithClientIdentity(entries) {
  const identities = getAuditClientIdentityMap();
  return entries.map(entry => {
    if (entry.erpUser || entry.details?.erpUser) return entry;
    const clientId = String(entry?.details?.clientId || '').trim();
    const inferredErpUser = identities.get(clientId);
    if (!inferredErpUser) return entry;
    return {
      ...entry,
      erpUser: inferredErpUser,
      erpUserRecoveredFromClientId: true
    };
  });
}

const filterAuditEntries = (entries, query) => {
  const keyword = (query.get('q') || '').trim().toLowerCase();
  const category = (query.get('category') || '').trim();
  const ip = (query.get('ip') || '').trim();
  const erpUser = (query.get('erpUser') || '').trim().toLowerCase();
  const project = (query.get('project') || '').trim().toLowerCase();
  const action = (query.get('action') || '').trim();

  return entries.filter(entry => {
    if (category && entry.category !== category) return false;
    if (ip && entry.ip !== ip) return false;
    const entryErpUser = String(entry.erpUser || entry.details?.erpUser || '').trim().toLowerCase();
    const entryProject = String(
      entry.projectName || entry.details?.projectName || entry.projectId || entry.details?.projectId || ''
    ).trim().toLowerCase();
    if (erpUser && entryErpUser !== erpUser) return false;
    if (project && entryProject !== project) return false;
    if (action && String(entry.action || '') !== action) return false;
    if (!keyword) return true;

    const haystack = [
      entry.time,
      entry.method,
      entry.path,
      entry.url,
      entry.category,
      entry.ip,
      entry.erpUser,
      entry.projectName,
      entry.projectId,
      entry.details?.erpUser,
      entry.details?.projectName,
      entry.details?.projectId,
      entry.statusCode,
      entry.userAgent,
      entry.referer
    ].join(' ').toLowerCase();
    return haystack.includes(keyword);
  });
};

const handleAuditList = (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const limit = Math.min(Number(parsedUrl.searchParams.get('limit') || 300), MAX_AUDIT_ROWS);
  const dateRange = getAuditDateRange(parsedUrl.searchParams);
  const entries = filterAuditEntries(
    readAuditEntries(Infinity, dateRange).filter(entry => (
      !isAuditExcludedEntry(entry) && !isLocalAuditIp(normalizeAuditIp(entry.ip))
    )),
    parsedUrl.searchParams
  ).slice(0, limit);
  send(res, 200, JSON.stringify({ ok: true, entries }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
};

const handleAuditStats = (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requestedBucketHours = Number(parsedUrl.searchParams.get('bucketHours') || 2);
  const usageBucketHours = [1, 2, 12].includes(requestedBucketHours) ? requestedBucketHours : 2;
  const dateRange = getAuditDateRange(parsedUrl.searchParams);
  const sourceEntries = readAuditEntries(Infinity, dateRange)
    .filter(entry => (
      !isAuditExcludedEntry(entry) && !isLocalAuditIp(normalizeAuditIp(entry.ip))
    ));
  const entries = filterAuditEntries(sourceEntries, parsedUrl.searchParams);
  const filterOptions = {
    erpUsers: Array.from(new Set(sourceEntries
      .map(entry => String(entry.erpUser || entry.details?.erpUser || '').trim().toLowerCase())
      .filter(Boolean))).sort(),
    projects: Array.from(new Set(sourceEntries
      .map(entry => String(entry.projectName || entry.details?.projectName || entry.projectId || entry.details?.projectId || '').trim())
      .filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    actions: Array.from(new Set(sourceEntries
      .map(entry => String(entry.action || '').trim())
      .filter(Boolean))).sort()
  };
  const byCategory = {};
  const localByCategory = {};
  const byIp = {};
  const byErpUser = {};
  const erpUsersByIp = {};
  const byProject = {};
  const projectStats = {};
  const actionStats = {};
  const actionStatsByActor = {};
  const localByIp = {};
  const localByErpUser = {};
  const localErpUsersByIp = {};
  const localActionStats = {};
  const localActionStatsByActor = {};
  const editStats = { total: 0, byCategory: {}, byOrigin: {} };
  const localEditStats = { total: 0, byCategory: {}, byOrigin: {} };
  const pageStats = {
    manualPages: new Set(),
    autoPages: new Set(),
    materialPages: new Set(),
    materialRecognitions: 0,
    documents: new Set(),
    documentPages: new Map(),
    manualDocuments: new Set(),
    manualDocumentPages: new Map(),
    autoDocuments: new Set(),
    autoDocumentPages: new Map()
  };
  const pageStatsByActor = {};
  const localPageStats = {
    manualPages: new Set(),
    autoPages: new Set(),
    materialPages: new Set(),
    materialRecognitions: 0,
    documents: new Set(),
    documentPages: new Map(),
    manualDocuments: new Set(),
    manualDocumentPages: new Map(),
    autoDocuments: new Set(),
    autoDocumentPages: new Map()
  };
  const localPageStatsByActor = {};
  const failures = [];
  const localFailures = [];
  const usageTimeline = {};

  const getActorKey = entry => {
    const erpUser = String(entry.erpUser || entry.details?.erpUser || '').trim().toLowerCase();
    const ip = normalizeAuditIp(entry.ip) || 'unknown';
    return erpUser ? `${erpUser} @ ${ip}` : ip;
  };
  const ensureActorStats = actor => {
    const key = actor || 'unknown';
    if (!actionStatsByActor[key]) {
      actionStatsByActor[key] = {};
    }
    if (!pageStatsByActor[key]) {
      pageStatsByActor[key] = {
        manualPages: new Set(),
        autoPages: new Set(),
        materialPages: new Set(),
        materialRecognitions: 0,
        documents: new Set(),
        documentPages: new Map(),
        manualDocuments: new Set(),
        manualDocumentPages: new Map(),
        autoDocuments: new Set(),
        autoDocumentPages: new Map()
      };
    }
    return key;
  };
  const ensureLocalActorStats = actor => {
    const key = actor || 'unknown';
    if (!localActionStatsByActor[key]) {
      localActionStatsByActor[key] = {};
    }
    if (!localPageStatsByActor[key]) {
      localPageStatsByActor[key] = {
        manualPages: new Set(),
        autoPages: new Set(),
        materialPages: new Set(),
        materialRecognitions: 0,
        documents: new Set(),
        documentPages: new Map(),
        manualDocuments: new Set(),
        manualDocumentPages: new Map(),
        autoDocuments: new Set(),
        autoDocumentPages: new Map()
      };
    }
    return key;
  };
  const normalizePages = value => {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
  };
  const annotationActions = new Set([
    'weld_add_manual',
    'weld_add_auto',
    'weld_edit',
    'weld_edit_clear_text',
    'weld_delete',
    'weld_delete_bulk'
  ]);
  const projectTaskActions = new Set([
    ...annotationActions,
    'material_table_recognize'
  ]);
  const getEntryPages = entry => {
    const pages = [
      ...normalizePages(entry.details?.pages),
      ...normalizePages(entry.details?.affectedPages),
      ...normalizePages(entry.page || entry.details?.page)
    ]
      .map(page => Number(page))
      .filter(page => Number.isFinite(page) && page > 0);
    return Array.from(new Set(pages));
  };
  const addProcessedDocument = (stats, action, entry) => {
    if (!entry.pdfFileName) return;
    if (!annotationActions.has(action)) return;
    const key = `${entry.details?.clientId || ''}:${entry.pdfFileName}`;
    stats.documents.add(key);
    const pages = getEntryPages(entry);
    const isAutoAction = action === 'weld_add_auto';
    const targetDocumentSet = isAutoAction ? stats.autoDocuments : stats.manualDocuments;
    const targetPageMap = isAutoAction ? stats.autoDocumentPages : stats.manualDocumentPages;
    targetDocumentSet.add(key);
    if (pages.length > 0) {
      if (!stats.documentPages.has(key)) {
        stats.documentPages.set(key, new Set());
      }
      pages.forEach(page => stats.documentPages.get(key).add(page));
      if (!targetPageMap.has(key)) {
        targetPageMap.set(key, new Set());
      }
      pages.forEach(page => targetPageMap.get(key).add(page));
    }
  };
  const getRenderedPageCount = value => value instanceof Set ? value.size : Number(value || 0);
  const sumPages = map => Array.from(map.values()).reduce((total, value) => total + getRenderedPageCount(value), 0);
  const toPageStatsObject = stats => ({
    manualPages: stats.manualPages.size,
    autoPages: stats.autoPages.size,
    materialPages: stats.materialPages.size,
    materialRecognitions: stats.materialRecognitions,
    documents: stats.documents.size,
    documentPages: sumPages(stats.documentPages),
    manualDocuments: stats.manualDocuments.size,
    manualDocumentPages: sumPages(stats.manualDocumentPages),
    autoDocuments: stats.autoDocuments.size,
    autoDocumentPages: sumPages(stats.autoDocumentPages)
  });
  const getDocumentKey = entry => entry.pdfFileName
    ? `${entry.details?.clientId || ''}:${entry.pdfFileName}`
    : '';
  const addMaterialRecognition = (stats, entry) => {
    stats.materialRecognitions += 1;
    const pages = getEntryPages(entry);
    if (pages.length > 0) {
      const key = getDocumentKey(entry) || `unknown:${entry.pdfFileName || ''}`;
      pages.forEach(page => stats.materialPages.add(`${key}:${page}`));
      return;
    }
    stats.materialPages.add(`${entry.time || Date.now()}:${entry.pdfFileName || 'unknown'}`);
  };
  const buildWeldAddStats = (sourceEntries, includeEntry) => {
    const totals = { manual: 0, auto: 0, total: 0 };
    const byActorStats = {};

    sourceEntries.forEach(entry => {
      if (!includeEntry(entry) || entry.category !== 'user-event') return;
      if (!['weld_add_manual', 'weld_add_auto'].includes(entry.action)) return;
      const count = Number(entry.count || 1);
      const actor = getActorKey(entry);
      if (!byActorStats[actor]) byActorStats[actor] = { manual: 0, auto: 0, total: 0 };
      const isAuto = entry.action === 'weld_add_auto';

      totals.total += count;
      totals[isAuto ? 'auto' : 'manual'] += count;
      byActorStats[actor].total += count;
      byActorStats[actor][isAuto ? 'auto' : 'manual'] += count;
    });

    return { totals, byActor: byActorStats };
  };
  const buildLayoutQualityStats = (sourceEntries, includeEntry) => {
    const latestBySession = new Map();
    sourceEntries.forEach(entry => {
      if (!includeEntry(entry) || entry.category !== 'user-event' || entry.action !== 'layout_quality_finalize') return;
      const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
      const sessionId = String(details.sessionId || '').trim();
      const key = sessionId
        ? `${details.clientId || ''}:${sessionId}`
        : `${entry.time || ''}:${entry.pdfFileName || ''}`;
      const existing = latestBySession.get(key);
      if (!existing || String(existing.time || '') <= String(entry.time || '')) latestBySession.set(key, entry);
    });

    const empty = () => ({
      sessions: 0,
      initialAutoCount: 0,
      acceptedAutoCount: 0,
      correctedAutoCount: 0,
      deletedAutoCount: 0,
      manualCorrectionCount: 0,
      finalWeldCount: 0,
      manualActiveMs: 0
    });
    const totals = empty();
    const byActor = {};
    const byProjectQuality = {};
    const add = (target, entry) => {
      const details = entry.details || {};
      target.sessions += 1;
      [
        'initialAutoCount', 'acceptedAutoCount', 'correctedAutoCount',
        'deletedAutoCount', 'manualCorrectionCount', 'finalWeldCount', 'manualActiveMs'
      ].forEach(field => {
        const value = Number(details[field] || 0);
        if (Number.isFinite(value) && value > 0) target[field] += value;
      });
    };
    latestBySession.forEach(entry => {
      add(totals, entry);
      const actor = getActorKey(entry);
      if (!byActor[actor]) byActor[actor] = empty();
      add(byActor[actor], entry);
      const project = getProjectKey(entry) || '未关联项目';
      if (!byProjectQuality[project]) byProjectQuality[project] = empty();
      add(byProjectQuality[project], entry);
    });
    const finish = value => ({
      ...value,
      onePassAccuracy: value.finalWeldCount > 0 ? value.acceptedAutoCount / value.finalWeldCount : null,
      correctionRate: value.initialAutoCount > 0 ? value.correctedAutoCount / value.initialAutoCount : null,
      deletionRate: value.initialAutoCount > 0 ? value.deletedAutoCount / value.initialAutoCount : null,
      missedAdditionRate: value.finalWeldCount > 0 ? value.manualCorrectionCount / value.finalWeldCount : null
    });
    return {
      totals: finish(totals),
      byActor: Object.fromEntries(Object.entries(byActor).map(([key, value]) => [key, finish(value)])),
      byProject: Object.fromEntries(Object.entries(byProjectQuality).map(([key, value]) => [key, finish(value)]))
    };
  };
  const getBusinessCount = entry => {
    if (entry.category !== 'user-event') return 1;
    const count = Number(entry.count || 1);
    return Number.isFinite(count) && count > 0 ? count : 1;
  };
  const addCounter = (target, key, count = 1) => {
    const counterKey = key || 'unknown';
    target[counterKey] = (target[counterKey] || 0) + count;
  };
  const addEditEntry = (target, entry) => {
    const count = getBusinessCount(entry);
    const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
    const category = String(entry.editCategory || details.editCategory || 'content');
    target.total += count;
    addCounter(target.byCategory, category, count);
    const rawOriginCounts = entry.originCounts || details.originCounts;
    const originCounts = rawOriginCounts && typeof rawOriginCounts === 'object' ? rawOriginCounts : null;
    if (originCounts) {
      Object.entries(originCounts).forEach(([origin, originCount]) => {
        addCounter(target.byOrigin, origin, Number(originCount || 0));
      });
    } else {
      addCounter(target.byOrigin, entry.origin || details.origin || entry.generatedBy || details.generatedBy || 'unknown', count);
    }
  };
  const getProjectKey = entry => {
    const projectName = String(entry.projectName || entry.details?.projectName || '').trim();
    const projectId = String(entry.projectId || entry.details?.projectId || '').trim();
    if (!projectName && !projectId) return '';
    return projectName || projectId;
  };
  const ensureProjectStats = projectKey => {
    if (!projectKey) return null;
    if (!projectStats[projectKey]) {
      projectStats[projectKey] = {
        actions: {},
        taskCount: 0,
        weldAdds: 0,
        manualWeldAdds: 0,
        autoWeldAdds: 0,
        materialRecognitions: 0,
        documents: new Set(),
        documentPages: new Map()
      };
    }
    return projectStats[projectKey];
  };
  const addProjectEntry = entry => {
    if (entry.category !== 'user-event') return;
    const projectKey = getProjectKey(entry);
    if (!projectKey) return;
    const action = entry.action || 'unknown';
    if (!projectTaskActions.has(action)) return;
    const businessCount = getBusinessCount(entry);
    byProject[projectKey] = (byProject[projectKey] || 0) + businessCount;
    const stats = ensureProjectStats(projectKey);
    stats.taskCount += businessCount;
    addCounter(stats.actions, action, businessCount);
    if (['weld_add_manual', 'weld_add_auto'].includes(action)) {
      stats.weldAdds += businessCount;
      if (action === 'weld_add_auto') {
        stats.autoWeldAdds += businessCount;
      } else {
        stats.manualWeldAdds += businessCount;
      }
    }
    if (action === 'material_table_recognize') {
      stats.materialRecognitions += 1;
    }
    if (entry.pdfFileName && annotationActions.has(action)) {
      const key = `${entry.details?.clientId || ''}:${entry.pdfFileName}`;
      stats.documents.add(key);
      const pages = getEntryPages(entry);
      if (pages.length > 0) {
        if (!stats.documentPages.has(key)) {
          stats.documentPages.set(key, new Set());
        }
        pages.forEach(page => stats.documentPages.get(key).add(page));
      }
    }
  };
  const getUsageBucket = time => {
    const start = new Date(time);
    start.setMinutes(0, 0, 0);
    start.setHours(Math.floor(start.getHours() / usageBucketHours) * usageBucketHours);
    const end = new Date(start.getTime() + usageBucketHours * 60 * 60 * 1000);
    return { key: start.toISOString(), start, end };
  };
  const addUsageTimelineEntry = entry => {
    if (entry.category !== 'user-event') return;
    const time = new Date(entry.time);
    if (Number.isNaN(time.getTime())) return;
    const bucket = getUsageBucket(time);
    if (!usageTimeline[bucket.key]) {
      usageTimeline[bucket.key] = {
        bucketStart: bucket.start.toISOString(),
        bucketEnd: bucket.end.toISOString(),
        firstUsedAt: entry.time,
        lastUsedAt: entry.time,
        ips: new Set(),
        users: {},
        actions: {},
        actorActions: {},
        projects: {},
        events: 0,
        weldAdds: 0,
        activeMs: 0,
        failureCount: 0,
        documents: new Set(),
        documentPages: new Map()
      };
    }
    const item = usageTimeline[bucket.key];
    item.firstUsedAt = item.firstUsedAt < entry.time ? item.firstUsedAt : entry.time;
    item.lastUsedAt = item.lastUsedAt > entry.time ? item.lastUsedAt : entry.time;
    item.ips.add(normalizeAuditIp(entry.ip) || 'unknown');
    const businessCount = getBusinessCount(entry);
    const actor = getActorKey(entry);
    const action = entry.action || 'unknown';
    item.events += businessCount;
    addCounter(item.users, actor, businessCount);
    addCounter(item.actions, action, businessCount);
    const project = getProjectKey(entry);
    if (project) addCounter(item.projects, project, businessCount);
    if (!item.actorActions[actor]) {
      item.actorActions[actor] = {};
    }
    addCounter(item.actorActions[actor], action, businessCount);
    if (action === 'layout_work_active') {
      const activeDeltaMs = Number(entry.details?.activeDeltaMs || 0);
      if (Number.isFinite(activeDeltaMs) && activeDeltaMs > 0) item.activeMs += activeDeltaMs;
    }
    if (entry.pdfFileName) {
      if (!annotationActions.has(entry.action)) return;
      const key = `${entry.details?.clientId || ''}:${entry.pdfFileName}`;
      item.documents.add(key);
      const pages = getEntryPages(entry);
      if (pages.length > 0) {
        if (!item.documentPages.has(key)) {
          item.documentPages.set(key, new Set());
        }
        pages.forEach(page => item.documentPages.get(key).add(page));
      }
    }
    if (['weld_add_manual', 'weld_add_auto'].includes(action)) {
      item.weldAdds += businessCount;
    }
  };

  entries.forEach(entry => {
    const normalizedIp = normalizeAuditIp(entry.ip);
    const local = isLocalAuditIp(normalizedIp);
    const erpUser = String(entry.erpUser || entry.details?.erpUser || '').trim().toLowerCase();
    // Active-time heartbeats feed the timeline only; they must not inflate
    // business action counts, ERP workload counts, or project task counts.
    if (entry.category === 'user-event' && entry.action === 'layout_work_active') {
      if (!local) addUsageTimelineEntry(entry);
      return;
    }
    if (local) {
      localByCategory[entry.category] = (localByCategory[entry.category] || 0) + 1;
      if (erpUser) {
        localByErpUser[erpUser] = (localByErpUser[erpUser] || 0) + getBusinessCount(entry);
        if (!localErpUsersByIp[normalizedIp]) localErpUsersByIp[normalizedIp] = {};
        localErpUsersByIp[normalizedIp][erpUser] = (localErpUsersByIp[normalizedIp][erpUser] || 0) + getBusinessCount(entry);
      }
    } else {
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
      byIp[normalizedIp] = (byIp[normalizedIp] || 0) + 1;
      if (erpUser) {
        byErpUser[erpUser] = (byErpUser[erpUser] || 0) + getBusinessCount(entry);
        if (!erpUsersByIp[normalizedIp]) erpUsersByIp[normalizedIp] = {};
        erpUsersByIp[normalizedIp][erpUser] = (erpUsersByIp[normalizedIp][erpUser] || 0) + getBusinessCount(entry);
      }
      addUsageTimelineEntry(entry);
      addProjectEntry(entry);
    }
    if (entry.category === 'user-event') {
      const action = entry.action || 'unknown';
      const count = Number(entry.count || 1);
      const actorKey = getActorKey(entry);
      if (action === 'weld_edit' || action === 'weld_edit_clear_text') {
        addEditEntry(local ? localEditStats : editStats, entry);
      }
      if (local) {
        const actorStatsKey = ensureLocalActorStats(actorKey);
        localByIp[normalizedIp] = (localByIp[normalizedIp] || 0) + 1;
        localActionStats[action] = (localActionStats[action] || 0) + count;
        localActionStatsByActor[actorStatsKey][action] = (localActionStatsByActor[actorStatsKey][action] || 0) + count;
        addProcessedDocument(localPageStats, action, entry);
        addProcessedDocument(localPageStatsByActor[actorStatsKey], action, entry);
        if (action === 'weld_add_manual' && entry.page) {
          localPageStats.manualPages.add(`${entry.pdfFileName || ''}:${entry.page}`);
          localPageStatsByActor[actorStatsKey].manualPages.add(`${entry.pdfFileName || ''}:${entry.page}`);
        }
        if (action === 'weld_add_auto') {
          normalizePages(entry.details?.pages).forEach(page => localPageStats.autoPages.add(`${entry.pdfFileName || ''}:${page}`));
          normalizePages(entry.details?.pages).forEach(page => localPageStatsByActor[actorStatsKey].autoPages.add(`${entry.pdfFileName || ''}:${page}`));
        }
        if (action === 'material_table_recognize') {
          addMaterialRecognition(localPageStats, entry);
          addMaterialRecognition(localPageStatsByActor[actorStatsKey], entry);
        }
      } else {
        const actorStatsKey = ensureActorStats(actorKey);
        actionStats[action] = (actionStats[action] || 0) + count;
        actionStatsByActor[actorStatsKey][action] = (actionStatsByActor[actorStatsKey][action] || 0) + count;
        addProcessedDocument(pageStats, action, entry);
        addProcessedDocument(pageStatsByActor[actorStatsKey], action, entry);
        if (action === 'weld_add_manual' && entry.page) {
          pageStats.manualPages.add(`${entry.pdfFileName || ''}:${entry.page}`);
          pageStatsByActor[actorStatsKey].manualPages.add(`${entry.pdfFileName || ''}:${entry.page}`);
        }
        if (action === 'weld_add_auto') {
          normalizePages(entry.details?.pages).forEach(page => pageStats.autoPages.add(`${entry.pdfFileName || ''}:${page}`));
          normalizePages(entry.details?.pages).forEach(page => pageStatsByActor[actorStatsKey].autoPages.add(`${entry.pdfFileName || ''}:${page}`));
        }
        if (action === 'material_table_recognize') {
          addMaterialRecognition(pageStats, entry);
          addMaterialRecognition(pageStatsByActor[actorStatsKey], entry);
        }
      }
    }
    if (Number(entry.statusCode) >= 400) {
      if (local) {
        localFailures.push(entry);
      } else {
        failures.push(entry);
      }
    }
  });
  entries.forEach(entry => {
    if (Number(entry.statusCode) < 400) return;
    const time = new Date(entry.time);
    if (Number.isNaN(time.getTime())) return;
    const bucket = getUsageBucket(time);
    if (usageTimeline[bucket.key]) usageTimeline[bucket.key].failureCount += 1;
  });
  const productionWeldAddStats = buildWeldAddStats(entries, entry => !isLocalAuditIp(normalizeAuditIp(entry.ip)));
  const localWeldAddStats = buildWeldAddStats(entries, entry => isLocalAuditIp(normalizeAuditIp(entry.ip)));
  const productionLayoutQualityStats = buildLayoutQualityStats(entries, entry => !isLocalAuditIp(normalizeAuditIp(entry.ip)));
  const localLayoutQualityStats = buildLayoutQualityStats(entries, entry => isLocalAuditIp(normalizeAuditIp(entry.ip)));

  send(res, 200, JSON.stringify({
    ok: true,
    dateRange,
    filterOptions,
    total: entries.filter(entry => !isLocalAuditIp(normalizeAuditIp(entry.ip))).length,
    localTotal: entries.filter(entry => isLocalAuditIp(normalizeAuditIp(entry.ip))).length,
    allTotal: entries.length,
    byCategory,
    localByCategory,
    byIp,
    byErpUser,
    erpUsersByIp,
    byProject,
    projectStats: Object.fromEntries(Object.entries(projectStats).map(([project, stats]) => [project, {
      actions: stats.actions,
      taskCount: stats.taskCount,
      weldAdds: stats.weldAdds,
      manualWeldAdds: stats.manualWeldAdds,
      autoWeldAdds: stats.autoWeldAdds,
      materialRecognitions: stats.materialRecognitions,
      documents: stats.documents.size,
      documentPages: sumPages(stats.documentPages)
    }])),
    documentAnnotationStats: buildDocumentAnnotationStats(entries),
    actionStats,
    actionStatsByActor,
    weldAddStats: productionWeldAddStats.totals,
    weldAddStatsByActor: productionWeldAddStats.byActor,
    pageStats: toPageStatsObject(pageStats),
    localPageStats: toPageStatsObject(localPageStats),
    pageStatsByActor: Object.fromEntries(Object.entries(pageStatsByActor).map(([actor, stats]) => [actor, toPageStatsObject(stats)])),
    localByIp,
    localByErpUser,
    localErpUsersByIp,
    localActionStats,
    localActionStatsByActor,
    editStats,
    localEditStats,
    localWeldAddStats: localWeldAddStats.totals,
    localWeldAddStatsByActor: localWeldAddStats.byActor,
    layoutQualityStats: productionLayoutQualityStats.totals,
    layoutQualityStatsByActor: productionLayoutQualityStats.byActor,
    layoutQualityStatsByProject: productionLayoutQualityStats.byProject,
    localLayoutQualityStats: localLayoutQualityStats.totals,
    localLayoutQualityStatsByActor: localLayoutQualityStats.byActor,
    localPageStatsByActor: Object.fromEntries(Object.entries(localPageStatsByActor).map(([actor, stats]) => [actor, toPageStatsObject(stats)])),
    usageTimeline: Object.values(usageTimeline)
      .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))
      .slice(-60)
      .reverse()
      .map(item => ({
        bucketStart: item.bucketStart,
        bucketEnd: item.bucketEnd,
        firstUsedAt: item.firstUsedAt,
        lastUsedAt: item.lastUsedAt,
        ipCount: item.ips.size,
        users: item.users,
        actions: item.actions,
        actorActions: item.actorActions,
        projects: item.projects,
        events: item.events,
        documents: item.documents.size,
        documentPages: sumPages(item.documentPages),
        weldAdds: item.weldAdds,
        activeMinutes: Math.round(item.activeMs / 60000),
        failureCount: item.failureCount
      })),
    usageBucketHours,
    failures: failures.slice(0, 50),
    localFailures: localFailures.slice(0, 50)
  }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
};

const serveAdmin = (req, res) => {
  send(res, 200, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>落图后台访问日志</title>
  <style>
    body { margin: 0; font-family: Arial, "Microsoft YaHei", sans-serif; background: #f5f7fb; color: #1f2937; }
    header { padding: 16px 20px; background: #111827; color: #fff; display: flex; justify-content: space-between; align-items: center; }
    h1 { margin: 0; font-size: 18px; }
    main { padding: 16px 20px; }
    .stats { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .stat { min-width: 130px; }
    .stat b { display: block; font-size: 20px; margin-top: 4px; }
    .muted { color: #6b7280; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 12px; margin-bottom: 12px; }
    .chart-title { font-size: 14px; font-weight: 700; margin-bottom: 10px; }
    .vertical-chart { height: 260px; display: flex; align-items: stretch; gap: 18px; padding: 12px 8px 0; border-bottom: 1px solid #d1d5db; }
    .column { flex: 1; min-width: 88px; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; }
    .column-value { font-size: 18px; font-weight: 700; }
    .column-bar { width: min(92px, 72%); min-height: 3px; border-radius: 4px 4px 0 0; background: #1677ff; }
    .column-bar.auto { background: #52c41a; }
    .column-bar.manual { background: #fa8c16; }
    .column-label { min-height: 30px; padding-top: 8px; font-size: 13px; text-align: center; color: #4b5563; }
    .timeline { display: flex; gap: 16px; overflow-x: auto; padding: 14px 12px 18px; }
    .timeline-item { position: relative; min-width: 320px; padding: 14px 12px 10px; border-left: 3px solid #1677ff; background: #f8fafc; border-radius: 0 4px 4px 0; }
    .timeline-date { font-weight: 700; margin-bottom: 8px; }
    .timeline-meta { color: #4b5563; line-height: 1.7; font-size: 12px; }
    .timeline-details { margin-top: 8px; border-top: 1px dashed #cbd5e1; padding-top: 7px; }
    .timeline-details summary { color: #1677ff; cursor: pointer; font-weight: 600; }
    .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 12px; }
    .filter-field { display: flex; flex-direction: column; gap: 5px; min-width: 150px; }
    .filter-field label { font-size: 12px; color: #4b5563; }
    .filter-field input, .filter-field select { height: 34px; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 4px; padding: 0 9px; background: #fff; }
    .table-toolbar { padding: 10px 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; border-bottom: 1px solid #e5e7eb; }
    .table-toolbar .chart-title { margin: 0 auto 0 0; }
    .table-toolbar input, .table-toolbar select { height: 32px; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 4px; padding: 0 9px; background: #fff; }
    .table-toolbar input { min-width: 210px; }
    button { height: 34px; padding: 0 14px; border: 1px solid #1677ff; border-radius: 4px; color: #fff; background: #1677ff; cursor: pointer; }
    button.secondary { color: #374151; background: #fff; border-color: #d1d5db; }
    button.success { background: #16a34a; border-color: #16a34a; }
    .failure-status { color: #dc2626; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: #fff; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 9px 10px; text-align: left; }
    th { background: #f9fafb; color: #4b5563; }
  </style>
</head>
<body>
  <header>
    <h1>落图后台访问日志</h1>
    <div class="muted" id="updatedAt">未加载</div>
  </header>
  <main>
    <div class="card filters">
      <div class="filter-field"><label>开始日期</label><input type="date" id="filterFrom" /></div>
      <div class="filter-field"><label>结束日期</label><input type="date" id="filterTo" /></div>
      <div class="filter-field"><label>项目</label><select id="filterProject"><option value="">全部项目</option></select></div>
      <div class="filter-field"><label>ERP 用户</label><select id="filterErpUser"><option value="">全部用户</option></select></div>
      <div class="filter-field"><label>操作类型</label><select id="filterAction"><option value="">全部操作</option></select></div>
      <button id="applyFilters">查询</button>
      <button class="secondary" id="resetFilters">重置</button>
      <button class="success" id="exportStats">导出当前统计</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="charts" id="charts"></div>
    <div class="card" style="padding:0; overflow:auto; margin-bottom:12px;">
      <div class="table-toolbar">
        <div class="chart-title">项目任务完成情况</div>
        <input id="projectTableSearch" placeholder="搜索项目名称" />
        <select id="projectTableSort">
          <option value="pages_desc">按处理页数降序</option>
          <option value="welds_desc">按新增焊口降序</option>
          <option value="auto_ratio_desc">按自动占比降序</option>
          <option value="name_asc">按项目名称排序</option>
        </select>
      </div>
      <table>
        <thead><tr><th>项目</th><th>任务数</th><th>处理页数</th><th>PDF数</th><th>新增焊口</th><th>手动/自动新增</th><th>自动占比</th><th>一次通过率</th><th>人工耗时</th><th>材料识别</th><th>主要操作</th></tr></thead>
        <tbody id="projectSummary"></tbody>
      </table>
    </div>
    <div class="card" style="padding:0; overflow:auto; margin-bottom:12px;">
      <div class="table-toolbar"><div class="chart-title">每份图纸标注统计</div></div>
      <table>
        <thead><tr><th>项目</th><th>图纸</th><th>ERP用户</th><th>标注总数</th><th>自动标注</th><th>自动比例</th><th>手动标注</th><th>手动比例</th><th>统计口径</th><th>快照时间</th></tr></thead>
        <tbody id="documentAnnotationSummary"></tbody>
      </table>
    </div>
    <div class="card" style="padding:0; margin-bottom:12px;">
      <div class="table-toolbar">
        <div class="chart-title">生产环境使用活跃度</div>
        <select id="timelineBucketHours">
          <option value="1">每1小时</option>
          <option value="2" selected>每2小时</option>
          <option value="12">每半天</option>
        </select>
      </div>
      <div class="timeline" id="usageTimeline"></div>
    </div>
    <div class="card" style="padding:0; overflow:auto;">
      <div class="table-toolbar">
        <div class="chart-title">按 ERP 用户 + IP 统计（无用户名时按 IP）</div>
        <input id="userTableSearch" placeholder="搜索ERP用户或IP" />
        <select id="userTableSort">
          <option value="pages_desc">按处理页数降序</option>
          <option value="welds_desc">按新增焊口降序</option>
          <option value="auto_ratio_desc">按自动占比降序</option>
          <option value="name_asc">按用户名称排序</option>
        </select>
      </div>
      <table>
        <thead><tr><th>ERP用户 @ IP</th><th>处理页数</th><th>PDF数</th><th>新增总数</th><th>手动新增</th><th>自动新增</th><th>自动占比</th><th>一次通过率</th><th>人工耗时</th><th>编辑</th><th>删除</th><th>材料识别</th><th>材料页</th></tr></thead>
        <tbody id="ipSummary"></tbody>
      </table>
    </div>
    <div class="card" style="padding:0; overflow:auto; margin-top:12px;">
      <div class="chart-title" style="padding:12px 12px 0;">失败请求（当前筛选范围，最多显示50条）</div>
      <table>
        <thead><tr><th>时间</th><th>ERP用户</th><th>IP</th><th>状态</th><th>操作/路径</th><th>项目</th></tr></thead>
        <tbody id="failureSummary"></tbody>
      </table>
    </div>
  </main>
  <script>
    const el = id => document.getElementById(id);
    const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    let latestStatsData = null;
    const actionLabelMap = {
      weld_add_manual: '手动新增焊口',
      weld_add_auto: '自动新增焊口',
      weld_edit: '编辑焊口',
      weld_edit_clear_text: '清空焊口文字',
      weld_delete: '删除焊口',
      weld_delete_bulk: '批量删除焊口',
      layout_quality_finalize: '落图质量结算',
      layout_work_active: '人工活跃时间',
      material_table_recognize: '材料表识别',
      pdf_open: '打开PDF',
      annotation_snapshot: '标注保存快照',
      editable_pdf_merge: '合并可编辑PDF',
      editable_pdf_split: '拆分可编辑PDF'
    };
    const formatCounter = (counter, labelMap = {}) => Object.entries(counter || {})
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .map(([key, count]) => (labelMap[key] || key) + ': ' + count)
      .join(' / ') || '-';
    const formatBucketTime = item => {
      const start = item.bucketStart || item.firstUsedAt;
      const end = item.bucketEnd || item.lastUsedAt;
      if (!start || !end) return item.date || '';
      const startDate = new Date(start);
      const endDate = new Date(end);
      const day = startDate.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
      const startText = startDate.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const endText = endDate.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      return day + ' ' + startText + '-' + endText;
    };

    const getFilterQuery = () => {
      const query = new URLSearchParams();
      const values = {
        from: el('filterFrom').value,
        to: el('filterTo').value,
        project: el('filterProject').value,
        erpUser: el('filterErpUser').value,
        action: el('filterAction').value,
        bucketHours: el('timelineBucketHours').value || '2'
      };
      Object.entries(values).forEach(([key, value]) => {
        if (value) query.set(key, value);
      });
      return query;
    };

    const syncSelectOptions = (id, values, emptyLabel, labelMap = {}) => {
      const select = el(id);
      const current = select.value;
      select.innerHTML = '<option value="">' + escapeHtml(emptyLabel) + '</option>' + (values || []).map(value =>
        '<option value="' + escapeHtml(value) + '">' + escapeHtml(labelMap[value] || value) + '</option>'
      ).join('');
      if (Array.from(select.options).some(option => option.value === current)) select.value = current;
    };

    const getAutoRatio = (manual, auto) => {
      const manualCount = Number(manual || 0);
      const autoCount = Number(auto || 0);
      const total = manualCount + autoCount;
      return total > 0 ? autoCount * 100 / total : 0;
    };
    const formatAutoRatio = (manual, auto) => getAutoRatio(manual, auto).toFixed(1) + '%';
    const formatRate = value => value !== null && value !== undefined && Number.isFinite(Number(value))
      ? (Number(value) * 100).toFixed(1) + '%'
      : '待结算';
    const formatAnnotationRatio = value => value === null || value === undefined
      ? '-'
      : (Number(value) * 100).toFixed(1) + '%';
    const formatDuration = value => {
      const totalMinutes = Math.round(Number(value || 0) / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return hours > 0 ? hours + '小时' + minutes + '分' : minutes + '分钟';
    };

    const renderProjectTable = data => {
      const keyword = el('projectTableSearch').value.trim().toLowerCase();
      const sortMode = el('projectTableSort').value;
      const rows = Object.entries(data.projectStats || {})
        .filter(([project]) => !keyword || project.toLowerCase().includes(keyword))
        .sort((a, b) => {
          const left = a[1] || {};
          const right = b[1] || {};
          if (sortMode === 'name_asc') return a[0].localeCompare(b[0], 'zh-CN');
          if (sortMode === 'welds_desc') return Number(right.weldAdds || 0) - Number(left.weldAdds || 0);
          if (sortMode === 'auto_ratio_desc') {
            return getAutoRatio(right.manualWeldAdds, right.autoWeldAdds) - getAutoRatio(left.manualWeldAdds, left.autoWeldAdds);
          }
          const pageDiff = Number(right.documentPages || 0) - Number(left.documentPages || 0);
          return pageDiff || Number(data.byProject?.[b[0]] || 0) - Number(data.byProject?.[a[0]] || 0);
        })
        .map(([project, item]) => {
          const actions = item.actions || {};
          const quality = data.layoutQualityStatsByProject?.[project] || {};
          const taskCount = item.taskCount || data.byProject?.[project] || Object.values(actions).reduce((sum, value) => sum + Number(value || 0), 0);
          const topActions = Object.entries(actions)
            .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
            .slice(0, 4)
            .map(([action, count]) => (actionLabelMap[action] || action) + ' ' + count)
            .join(' / ') || '-';
          return '<tr><td>' + escapeHtml(project) + '</td>' +
            '<td>' + escapeHtml(taskCount) + '</td>' +
            '<td>' + escapeHtml(item.documentPages || 0) + '</td>' +
            '<td>' + escapeHtml(item.documents || 0) + '</td>' +
            '<td>' + escapeHtml(item.weldAdds || 0) + '</td>' +
            '<td>' + escapeHtml((item.manualWeldAdds || 0) + ' / ' + (item.autoWeldAdds || 0)) + '</td>' +
            '<td>' + escapeHtml(formatAutoRatio(item.manualWeldAdds, item.autoWeldAdds)) + '</td>' +
            '<td>' + escapeHtml(formatRate(quality.onePassAccuracy)) + '</td>' +
            '<td>' + escapeHtml(formatDuration(quality.manualActiveMs)) + '</td>' +
            '<td>' + escapeHtml(item.materialRecognitions || 0) + '</td>' +
            '<td>' + escapeHtml(topActions) + '</td></tr>';
        });
      el('projectSummary').innerHTML = rows.join('') || '<tr><td colspan="11" class="muted">没有匹配的项目数据</td></tr>';
    };

    const renderDocumentAnnotationTable = data => {
      const rows = (data.documentAnnotationStats || []).map(item =>
        '<tr><td>' + escapeHtml(item.project || '-') + '</td>' +
        '<td>' + escapeHtml(item.fileName) + '</td>' +
        '<td>' + escapeHtml(item.erpUser || '-') + '</td>' +
        '<td>' + escapeHtml(item.total) + '</td>' +
        '<td>' + escapeHtml(item.auto) + '</td>' +
        '<td>' + escapeHtml(formatAnnotationRatio(item.autoRatio)) + '</td>' +
        '<td>' + escapeHtml(item.manual) + '</td>' +
        '<td>' + escapeHtml(formatAnnotationRatio(item.manualRatio)) + '</td>' +
        '<td>' + escapeHtml(item.source) + '</td>' +
        '<td>' + escapeHtml(fmtTime(item.snapshotAt) || '-') + '</td></tr>'
      );
      el('documentAnnotationSummary').innerHTML = rows.join('') || '<tr><td colspan="10" class="muted">当前范围内没有图纸数据</td></tr>';
    };

    const renderUserTable = data => {
      const keyword = el('userTableSearch').value.trim().toLowerCase();
      const sortMode = el('userTableSort').value;
      const actionByActor = data.actionStatsByActor || {};
      const pageByActor = data.pageStatsByActor || {};
      const weldAddByActor = data.weldAddStatsByActor || {};
      const qualityByActor = data.layoutQualityStatsByActor || {};
      const rows = Object.keys({ ...actionByActor, ...pageByActor, ...weldAddByActor, ...qualityByActor })
        .filter(actor => !keyword || actor.toLowerCase().includes(keyword))
        .sort((a, b) => {
          if (sortMode === 'name_asc') return a.localeCompare(b, 'zh-CN');
          const leftPages = pageByActor[a] || {};
          const rightPages = pageByActor[b] || {};
          const leftAdds = weldAddByActor[a] || {};
          const rightAdds = weldAddByActor[b] || {};
          if (sortMode === 'welds_desc') return Number(rightAdds.total || 0) - Number(leftAdds.total || 0);
          if (sortMode === 'auto_ratio_desc') return getAutoRatio(rightAdds.manual, rightAdds.auto) - getAutoRatio(leftAdds.manual, leftAdds.auto);
          return Number(rightPages.documentPages || 0) - Number(leftPages.documentPages || 0);
        })
        .map(actor => {
          const item = actionByActor[actor] || {};
          const pages = pageByActor[actor] || {};
          const weldAdds = weldAddByActor[actor] || {};
          const quality = qualityByActor[actor] || {};
          return '<tr><td>' + escapeHtml(actor) + '</td>' +
            '<td>' + escapeHtml(pages.documentPages || 0) + '</td>' +
            '<td>' + escapeHtml(pages.documents || 0) + '</td>' +
            '<td>' + escapeHtml(weldAdds.total || 0) + '</td>' +
            '<td>' + escapeHtml(weldAdds.manual || 0) + '</td>' +
            '<td>' + escapeHtml(weldAdds.auto || 0) + '</td>' +
            '<td>' + escapeHtml(formatAutoRatio(weldAdds.manual, weldAdds.auto)) + '</td>' +
            '<td>' + escapeHtml(formatRate(quality.onePassAccuracy)) + '</td>' +
            '<td>' + escapeHtml(formatDuration(quality.manualActiveMs)) + '</td>' +
            '<td>' + escapeHtml((item.weld_edit || 0) + (item.weld_edit_clear_text || 0)) + '</td>' +
            '<td>' + escapeHtml((item.weld_delete || 0) + (item.weld_delete_bulk || 0)) + '</td>' +
            '<td>' + escapeHtml(pages.materialRecognitions || 0) + '</td>' +
            '<td>' + escapeHtml(pages.materialPages || 0) + '</td></tr>';
        });
      el('ipSummary').innerHTML = rows.join('') || '<tr><td colspan="13" class="muted">没有匹配的用户数据</td></tr>';
    };

    async function loadStats() {
      const query = getFilterQuery();
      const response = await fetch('/api/admin/audit/stats?' + query.toString(), { cache: 'no-store' });
      const data = await response.json();
      latestStatsData = data;
      if (!el('filterFrom').value && data.dateRange?.from) el('filterFrom').value = data.dateRange.from;
      if (!el('filterTo').value && data.dateRange?.to) el('filterTo').value = data.dateRange.to;
      syncSelectOptions('filterProject', data.filterOptions?.projects, '全部项目');
      syncSelectOptions('filterErpUser', data.filterOptions?.erpUsers, '全部用户');
      syncSelectOptions('filterAction', data.filterOptions?.actions, '全部操作', actionLabelMap);
      const categoryText = Object.entries(data.byCategory || {}).map(([k, v]) => k + ': ' + v).join(' / ') || '-';
      const action = data.actionStats || {};
      const editStats = data.editStats || {};
      const pageStats = data.pageStats || {};
      const actionByActor = data.actionStatsByActor || {};
      const pageByActor = data.pageStatsByActor || {};
      const weldAddStats = data.weldAddStats || {};
      const weldAddByActor = data.weldAddStatsByActor || {};
      const qualityStats = data.layoutQualityStats || {};
      const erpUsersByIp = data.erpUsersByIp || {};
      const erpUserText = Object.entries(data.byErpUser || {})
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
        .map(([user, count]) => user + ': ' + count)
        .join(' / ') || '-';
      const formatErpUsersForIp = users => Object.entries(users || {})
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
        .map(([user, count]) => user + '(' + count + ')')
        .join(' / ') || '-';
      const manualAddTotal = weldAddStats.manual || 0;
      const autoAddTotal = weldAddStats.auto || 0;
      const editTotal = (action.weld_edit || 0) + (action.weld_edit_clear_text || 0);
      const deleteTotal = (action.weld_delete || 0) + (action.weld_delete_bulk || 0);
      const materialRecognitions = pageStats.materialRecognitions || 0;
      const materialPages = pageStats.materialPages || 0;
      const overallAutoRatio = formatAutoRatio(manualAddTotal, autoAddTotal);
      const qualityDetailText = [
        '已结算任务: ' + (qualityStats.sessions || 0),
        '初始自动焊口: ' + (qualityStats.initialAutoCount || 0),
        '一次通过: ' + (qualityStats.acceptedAutoCount || 0),
        '人工修正: ' + (qualityStats.correctedAutoCount || 0),
        '人工删除: ' + (qualityStats.deletedAutoCount || 0),
        '人工补点: ' + (qualityStats.manualCorrectionCount || 0),
        '修正率: ' + formatRate(qualityStats.correctionRate),
        '删除率: ' + formatRate(qualityStats.deletionRate),
        '漏点补充率: ' + formatRate(qualityStats.missedAdditionRate)
      ].join(' / ');
      const editBreakdownText = [
        '内容修改: ' + (editStats.byCategory?.content || 0),
        '样式修改: ' + (editStats.byCategory?.style || 0),
        '位置调整: ' + (editStats.byCategory?.layout || 0),
        '混合修改: ' + (editStats.byCategory?.mixed || 0),
        '原自动标注: ' + (editStats.byOrigin?.auto || 0),
        '原手动标注: ' + (editStats.byOrigin?.manual || 0),
        '历史来源未知: ' + (editStats.byOrigin?.unknown || 0)
      ].join(' / ');
      const operationText = [
        '添加焊口总数: ' + (manualAddTotal + autoAddTotal),
        '手动添加焊口: ' + manualAddTotal,
        '自动添加焊口: ' + autoAddTotal,
        '处理PDF总页数: ' + (pageStats.documentPages || 0),
        'PDF文件数: ' + (pageStats.documents || 0),
        '手动处理PDF页数: ' + (pageStats.manualDocumentPages || 0),
        '自动处理PDF页数: ' + (pageStats.autoDocumentPages || 0),
        '删除焊口: ' + ((action.weld_delete || 0) + (action.weld_delete_bulk || 0)),
        '编辑焊口: ' + ((action.weld_edit || 0) + (action.weld_edit_clear_text || 0)),
        '手动页: ' + (pageStats.manualPages || 0),
        '自动页: ' + (pageStats.autoPages || 0),
        '材料表识别次数: ' + materialRecognitions,
        '材料表识别页: ' + materialPages
      ].join(' / ');
      const actorOperationText = Object.keys({ ...actionByActor, ...pageByActor }).map(actor => {
        const item = actionByActor[actor] || {};
        const pages = pageByActor[actor] || {};
        const manualAdd = item.weld_add_manual || 0;
        const autoAdd = item.weld_add_auto || 0;
        return actor + '：' + [
          '删除 ' + ((item.weld_delete || 0) + (item.weld_delete_bulk || 0)),
          '编辑 ' + ((item.weld_edit || 0) + (item.weld_edit_clear_text || 0)),
          '手动页 ' + (pages.manualPages || 0),
          '自动页 ' + (pages.autoPages || 0),
          '材料页 ' + (pages.materialPages || 0)
        ].join(' / ');
      }).join('<br>') || '-';
      const actorAddBreakdownText = Object.keys(weldAddByActor).map(actor => {
        const item = weldAddByActor[actor] || {};
        const manualAdd = item.manual || 0;
        const autoAdd = item.auto || 0;
        return actor + ': 添加总数 ' + (manualAdd + autoAdd) + ' / 手动 ' + manualAdd + ' / 自动 ' + autoAdd;
      }).join('<br>') || '-';
      const topIps = Object.entries(data.byIp || {}).slice(0, 5).map(([k, v]) => k + ': ' + v).join(' / ') || '-';
      el('stats').innerHTML =
        '<div class="card stat">处理页数<b>' + (pageStats.documentPages || 0) + '</b></div>' +
        '<div class="card stat">新增焊口<b>' + (manualAddTotal + autoAddTotal) + '</b></div>' +
        '<div class="card stat">自动落图占比<b>' + escapeHtml(overallAutoRatio) + '</b></div>' +
        '<div class="card stat">自动一次通过率<b>' + escapeHtml(formatRate(qualityStats.onePassAccuracy)) + '</b></div>' +
        '<div class="card stat">人工活跃耗时<b>' + escapeHtml(formatDuration(qualityStats.manualActiveMs)) + '</b></div>' +
        '<div class="card stat">质量结算任务<b>' + (qualityStats.sessions || 0) + '</b></div>' +
        '<div class="card stat">编辑焊口<b>' + editTotal + '</b></div>' +
        '<div class="card stat">删除焊口<b>' + deleteTotal + '</b></div>' +
        '<div class="card stat">材料识别<b>' + materialRecognitions + '</b></div>' +
        '<div class="card stat">材料页<b>' + materialPages + '</b></div>' +
        '<div class="card" style="flex:1 1 100%">ERP登录用户统计<br><b style="font-size:14px">' + escapeHtml(erpUserText) + '</b></div>' +
        '<div class="card" style="flex:1 1 100%">生产环境操作统计<br><b style="font-size:14px">' + escapeHtml(operationText) + '</b></div>' +
        '<div class="card" style="flex:1 1 100%">生产环境修改分类<br><b style="font-size:14px">' + escapeHtml(editBreakdownText) + '</b></div>' +
        '<div class="card" style="flex:1 1 100%">自动落图质量明细<br><b style="font-size:14px">' + escapeHtml(qualityDetailText) + '</b></div>';

      renderProjectTable(data);
      renderDocumentAnnotationTable(data);

      const verticalChart = (title, rows) => {
        const max = Math.max(1, ...rows.map(row => Number(row.value || 0)));
        return '<div class="card"><div class="chart-title">' + escapeHtml(title) + '</div>' +
          '<div class="vertical-chart">' + rows.map(row => {
            const height = Number(row.value || 0) > 0 ? Math.max(4, Math.round(Number(row.value || 0) * 190 / max)) : 3;
            return '<div class="column"><div class="column-value">' + escapeHtml(row.value || 0) + '</div>' +
              '<div class="column-bar ' + escapeHtml(row.kind || '') + '" style="height:' + height + 'px"></div>' +
              '<div class="column-label">' + escapeHtml(row.label) + '</div></div>';
          }).join('') + '</div></div>';
      };
      el('charts').innerHTML =
        verticalChart('生产环境焊口新增', [
          { label: '手动新增', value: manualAddTotal, kind: 'manual' },
          { label: '自动新增', value: autoAddTotal, kind: 'auto' }
        ]) +
        verticalChart('生产环境PDF页数', [
          { label: '处理页数', value: pageStats.documentPages || 0 },
          { label: '手动处理页数', value: pageStats.manualDocumentPages || 0, kind: 'manual' },
          { label: '自动处理页数', value: pageStats.autoDocumentPages || 0, kind: 'auto' }
        ]) +
        verticalChart('生产环境操作总览', [
          { label: '新增焊口', value: manualAddTotal + autoAddTotal },
          { label: '编辑焊口', value: editTotal, kind: 'manual' },
          { label: '删除焊口', value: deleteTotal, kind: 'auto' },
          { label: '材料识别', value: materialRecognitions }
        ]);
      const timelineRows = (data.usageTimeline || []).map(item => {
        const first = new Date(item.firstUsedAt).toLocaleTimeString('zh-CN', { hour12: false });
        const last = new Date(item.lastUsedAt).toLocaleTimeString('zh-CN', { hour12: false });
        return '<div class="timeline-item"><div class="timeline-date">' + escapeHtml(formatBucketTime(item)) + '</div>' +
          '<div class="timeline-meta">实际活跃：<strong>' + escapeHtml(item.activeMinutes || 0) + ' 分钟</strong><br>' +
          '使用时段：' + escapeHtml(first) + ' - ' + escapeHtml(last) + '<br>' +
          '处理页数：' + escapeHtml(item.documentPages || 0) + '<br>' +
          'PDF数：' + escapeHtml(item.documents || 0) + '<br>' +
          '新增焊口：' + escapeHtml(item.weldAdds || 0) + '<br>' +
          '失败请求：' + escapeHtml(item.failureCount || 0) +
          '<details class="timeline-details"><summary>查看人员、项目与操作详情</summary>' +
          '<div>使用者：' + escapeHtml(formatCounter(item.users)) + '<br>' +
          '项目：' + escapeHtml(formatCounter(item.projects)) + '<br>' +
          '操作：' + escapeHtml(formatCounter(item.actions, actionLabelMap)) + '<br>' +
          '活跃 IP：' + escapeHtml(item.ipCount || 0) + '<br>' +
          '业务数量：' + escapeHtml(item.events || 0) + '</div></details></div></div>';
      });
      el('usageTimeline').innerHTML = timelineRows.join('') || '<div class="muted">暂无生产环境数据</div>';
      renderUserTable(data);

      const failureRows = (data.failures || [])
        .sort((a, b) => String(b.time || '').localeCompare(String(a.time || ''))).map(entry => {
        const user = entry.erpUser || entry.details?.erpUser || '-';
        const project = entry.projectName || entry.details?.projectName || entry.projectId || entry.details?.projectId || '-';
        const operation = actionLabelMap[entry.action] || entry.action || entry.path || entry.url || '-';
        return '<tr><td>' + escapeHtml(fmtTime(entry.time)) + '</td>' +
          '<td>' + escapeHtml(user) + '</td>' +
          '<td>' + escapeHtml(entry.ip || '-') + '</td>' +
          '<td class="failure-status">' + escapeHtml(entry.statusCode || '-') + '</td>' +
          '<td>' + escapeHtml(operation) + '</td>' +
          '<td>' + escapeHtml(project) + '</td></tr>';
      });
      el('failureSummary').innerHTML = failureRows.join('') || '<tr><td colspan="6" class="muted">当前范围内没有失败请求</td></tr>';
    }

    async function refreshAll() {
      try {
        await loadStats();
        el('updatedAt').textContent = '更新时间：' + new Date().toLocaleString('zh-CN', { hour12: false });
      } catch (error) {
        el('updatedAt').textContent = '加载失败：' + error.message;
      }
    }

    const exportCurrentStats = () => {
      const data = latestStatsData;
      if (!data) return;
      const rows = [['类型', '名称', '处理页数', 'PDF数', '新增焊口', '手动新增', '自动新增', '自动占比', '一次通过率', '人工活跃耗时', '人工修正', '人工删除', '人工补点', '编辑', '删除', '材料识别', '图纸项目', '图纸总标注', '图纸自动标注', '图纸自动比例', '图纸手动标注', '图纸手动比例', '图纸统计口径', '图纸快照时间']];
      Object.entries(data.projectStats || {}).forEach(([project, item]) => {
        const quality = data.layoutQualityStatsByProject?.[project] || {};
        rows.push(['项目', project, item.documentPages || 0, item.documents || 0, item.weldAdds || 0, item.manualWeldAdds || 0, item.autoWeldAdds || 0, formatAutoRatio(item.manualWeldAdds, item.autoWeldAdds), formatRate(quality.onePassAccuracy), formatDuration(quality.manualActiveMs), quality.correctedAutoCount || 0, quality.deletedAutoCount || 0, quality.manualCorrectionCount || 0, item.actions?.weld_edit || 0, (item.actions?.weld_delete || 0) + (item.actions?.weld_delete_bulk || 0), item.materialRecognitions || 0, '', '', '', '', '', '', '', '']);
      });
      const actors = new Set([
        ...Object.keys(data.actionStatsByActor || {}),
        ...Object.keys(data.pageStatsByActor || {}),
        ...Object.keys(data.weldAddStatsByActor || {}),
        ...Object.keys(data.layoutQualityStatsByActor || {})
      ]);
      actors.forEach(actor => {
        const action = data.actionStatsByActor?.[actor] || {};
        const pages = data.pageStatsByActor?.[actor] || {};
        const adds = data.weldAddStatsByActor?.[actor] || {};
        const quality = data.layoutQualityStatsByActor?.[actor] || {};
        rows.push(['用户', actor, pages.documentPages || 0, pages.documents || 0, adds.total || 0, adds.manual || 0, adds.auto || 0, formatAutoRatio(adds.manual, adds.auto), formatRate(quality.onePassAccuracy), formatDuration(quality.manualActiveMs), quality.correctedAutoCount || 0, quality.deletedAutoCount || 0, quality.manualCorrectionCount || 0, (action.weld_edit || 0) + (action.weld_edit_clear_text || 0), (action.weld_delete || 0) + (action.weld_delete_bulk || 0), pages.materialRecognitions || 0, '', '', '', '', '', '', '', '']);
      });
      (data.documentAnnotationStats || []).forEach(item => {
        rows.push([
          '图纸', item.fileName, item.pages || 0, 1,
          '', '', '', '', '', '', '', '', '', '', '', '',
          item.project, item.total, item.auto, formatAnnotationRatio(item.autoRatio),
          item.manual, formatAnnotationRatio(item.manualRatio), item.source, fmtTime(item.snapshotAt)
        ]);
      });
      const csvCell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
      const csv = rows.map(row => row.map(csvCell).join(',')).join('\\r\\n');
      const blob = new Blob([String.fromCharCode(0xfeff) + csv], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = '落图管理统计-' + new Date().toISOString().slice(0, 10) + '.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };

    el('applyFilters').addEventListener('click', refreshAll);
    el('resetFilters').addEventListener('click', () => {
      ['filterFrom', 'filterTo', 'filterProject', 'filterErpUser', 'filterAction'].forEach(id => { el(id).value = ''; });
      refreshAll();
    });
    el('exportStats').addEventListener('click', exportCurrentStats);
    el('timelineBucketHours').addEventListener('change', refreshAll);
    el('projectTableSearch').addEventListener('input', () => latestStatsData && renderProjectTable(latestStatsData));
    el('projectTableSort').addEventListener('change', () => latestStatsData && renderProjectTable(latestStatsData));
    el('userTableSearch').addEventListener('input', () => latestStatsData && renderUserTable(latestStatsData));
    el('userTableSort').addEventListener('change', () => latestStatsData && renderUserTable(latestStatsData));

    refreshAll();
    setInterval(refreshAll, 30000);
  </script>
</body>
</html>`, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
};

const proxyAutosave = (req, res) => {
  const targetPath = req.url;
  proxyRequest(req, res, AUTOSAVE_TARGET_HOST, AUTOSAVE_TARGET_PORT, targetPath);
};

const proxyDetectTextUpload = (req, res) => {
  proxyManagedOcrRequest(req, res, '/api/recognize/detect-text-upload');
};

const proxySupportRequest = (req, res) => {
  const targetPath = req.url.replace(/^\/support-proxy(?=\/|$)/, '') || '/';
  proxyRequest(req, res, SUPPORT_TARGET_HOST, SUPPORT_TARGET_PORT, targetPath, {
    service: 'support-chat',
    idleTimeoutMs: 65 * 1000,
    totalTimeoutMs: 70 * 1000
  });
};

const proxyOcrRequest = (req, res) => {
  if (req.url.startsWith('/api/recognize/')) {
    proxyManagedOcrRequest(req, res, req.url);
    return;
  }
  // Vector/PDF/log/draft APIs share the host but do not consume the single
  // PaddleOCR engine. Preserve their original independent proxy behavior.
  if (countAgentPendingRequests(OCR_AUX_AGENT) >= 32) {
    req.resume();
    send(res, 429, JSON.stringify({ ok: false, error: 'OCR 辅助接口队列已满' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '5'
    });
    return;
  }
  proxyRequest(req, res, OCR_TARGET_HOST, OCR_TARGET_PORT, req.url, {
    service: 'ocr-aux',
    agent: OCR_AUX_AGENT,
    idleTimeoutMs: 3 * 60 * 1000,
    totalTimeoutMs: OCR_TASK_TOTAL_TIMEOUT_MS
  });
};

const proxyOcrHealth = (req, res) => {
  proxyManagedOcrRequest(req, res, '/health');
};

const countAgentPendingRequests = agent => Object.values(agent.requests || {})
  .reduce((total, queue) => total + (Array.isArray(queue) ? queue.length : 0), 0);
const countAgentActiveSockets = agent => Object.values(agent.sockets || {})
  .reduce((total, sockets) => total + (Array.isArray(sockets) ? sockets.length : 0), 0);

const isOcrTaskRequest = (req, targetPath) => (
  req.method !== 'GET' &&
  /^\/api\/recognize\//.test(targetPath) &&
  !/^\/api\/recognize\/(?:stop|status)(?:\/|$)/.test(targetPath)
);

const proxyManagedOcrRequest = (req, res, targetPath) => {
  const taskRequest = isOcrTaskRequest(req, targetPath);
  const requestId = String(req.headers['x-ocr-task-id'] || req.headers['x-request-id'] || crypto.randomUUID());
  const now = Date.now();
  const logRejected = (statusCode, closeReason) => writeOcrConnectionLog({
    service: taskRequest ? 'ocr-task' : 'ocr-control',
    requestId,
    startedAt: new Date(now).toISOString(),
    endedAt: new Date().toISOString(),
    method: req.method,
    path: targetPath,
    statusCode,
    durationMs: Date.now() - now,
    closeReason,
    ok: false
  });
  if (taskRequest && ocrCircuitOpenUntil > now) {
    req.resume();
    send(res, 503, JSON.stringify({
      ok: false,
      error: 'OCR服务连续连接失败，提交已暂停',
      retryAfterMs: ocrCircuitOpenUntil - now
    }), { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
    logRejected(503, 'circuit-open');
    return;
  }

  if (taskRequest && countAgentPendingRequests(OCR_TASK_AGENT) >= OCR_TASK_QUEUE_LIMIT) {
    req.resume();
    send(res, 429, JSON.stringify({
      ok: false,
      error: `OCR待处理队列已满（上限${OCR_TASK_QUEUE_LIMIT}）`
    }), { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '5' });
    logRejected(429, 'queue-full');
    return;
  }

  if (taskRequest && activeOcrWebSockets > 0) {
    req.resume();
    send(res, 429, JSON.stringify({ ok: false, error: 'OCR WebSocket 任务正在处理中，请稍后重试' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '5'
    });
    logRejected(429, 'websocket-busy');
    return;
  }

  if (taskRequest && ACTIVE_OCR_TASK_IDS.has(requestId)) {
    req.resume();
    send(res, 409, JSON.stringify({ ok: false, error: '相同 OCR 任务正在处理中', taskId: requestId }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    logRejected(409, 'duplicate-task');
    return;
  }
  if (taskRequest) ACTIVE_OCR_TASK_IDS.add(requestId);

  proxyRequest(req, res, OCR_TARGET_HOST, OCR_TARGET_PORT, targetPath, {
    requestId,
    service: taskRequest ? 'ocr-task' : 'ocr-control',
    agent: taskRequest ? OCR_TASK_AGENT : OCR_CONTROL_AGENT,
    idleTimeoutMs: taskRequest ? 3 * 60 * 1000 : 10 * 1000,
    totalTimeoutMs: taskRequest ? OCR_TASK_TOTAL_TIMEOUT_MS : 15 * 1000,
    onComplete: ({ ok, statusCode, reason }) => {
      if (taskRequest) ACTIVE_OCR_TASK_IDS.delete(requestId);
      const failed = !ok || Number(statusCode) >= 500;
      if (!failed) {
        ocrConsecutiveFailures = 0;
        ocrCircuitOpenUntil = 0;
        return;
      }
      if (!['upstream-error', 'idle-timeout', 'total-timeout', 'upstream-aborted'].includes(reason)) return;
      ocrConsecutiveFailures += 1;
      if (ocrConsecutiveFailures >= OCR_CIRCUIT_FAILURE_LIMIT) {
        ocrCircuitOpenUntil = Date.now() + OCR_CIRCUIT_PAUSE_MS;
        console.warn(`[ocr-proxy] circuit opened for ${OCR_CIRCUIT_PAUSE_MS}ms after ${ocrConsecutiveFailures} failures`);
      }
    }
  });
};

const mirrorProcessingLogRequest = req => {
  const chunks = [];
  let totalBytes = 0;
  req.on('data', chunk => {
    totalBytes += chunk.length;
    if (totalBytes <= 5 * 1024 * 1024) chunks.push(chunk);
  });
  req.on('end', () => {
    if (totalBytes > 5 * 1024 * 1024 || chunks.length === 0) return;
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (payload.operation_type !== 'automatic_layout' || !payload.log_content) return;
      fs.mkdirSync(PROCESSING_LOG_DIR, { recursive: true });
      const target = path.join(PROCESSING_LOG_DIR, 'latest-automatic-layout.log');
      fs.writeFileSync(target, `${payload.log_content}\n`, 'utf8');
    } catch (error) {
      console.warn('[processing-log] local mirror failed:', error.message);
    }
  });
};

const proxyMineruRequest = (req, res) => {
  const targetPath = req.url.replace(/^\/mineru(?=\/|$)/, '') || '/';
  proxyRequest(req, res, MINERU_TARGET_HOST, MINERU_TARGET_PORT, targetPath);
};

const proxyWeldAiRequest = (req, res) => {
  proxyRequest(req, res, WELD_AI_TARGET_HOST, WELD_AI_TARGET_PORT, req.url);
};

const proxyRequest = (req, res, targetHost, targetPort, targetPath, proxyOptions = {}) => {
  const requestId = String(proxyOptions.requestId || req.headers['x-ocr-task-id'] || req.headers['x-request-id'] || crypto.randomUUID());
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let proxyResRef = null;
  let settled = false;
  let totalTimer = null;
  const settle = (reason, ok = false, statusCode = 0) => {
    if (settled) return;
    settled = true;
    if (totalTimer) clearTimeout(totalTimer);
    const durationMs = Date.now() - startedAt;
    if (proxyOptions.service) {
      const endedAtIso = new Date().toISOString();
      console.log(`[${proxyOptions.service}] id=${requestId} start=${startedAtIso} end=${endedAtIso} method=${req.method} path=${targetPath} status=${statusCode || '-'} durationMs=${durationMs} close=${reason}`);
      writeOcrConnectionLog({
        service: proxyOptions.service,
        requestId,
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        method: req.method,
        path: targetPath,
        statusCode: statusCode || 0,
        durationMs,
        closeReason: reason,
        ok
      });
    }
    proxyOptions.onComplete?.({ requestId, reason, ok, statusCode, durationMs });
  };
  const options = {
    hostname: targetHost,
    port: targetPort,
    path: targetPath,
    method: req.method,
    agent: proxyOptions.agent,
    headers: {
      ...req.headers,
      'x-ocr-task-id': requestId,
      host: `${targetHost}:${targetPort}`
    }
  };

  const proxyReq = http.request(options, proxyRes => {
    proxyResRef = proxyRes;
    if (res.destroyed || res.writableEnded) {
      proxyRes.destroy();
      settle('client-closed-before-response', false, proxyRes.statusCode || 0);
      return;
    }
    if (!res.headersSent) {
      res.writeHead(proxyRes.statusCode || 502, {
        ...proxyRes.headers,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true'
      });
    }
    proxyRes.on('error', error => {
      console.warn(`[proxy] response error from ${targetHost}:${targetPort}:`, error.message);
      if (!res.headersSent) {
        send(res, 502, JSON.stringify({ ok: false, error: error.message }), {
          'Content-Type': 'application/json; charset=utf-8'
        });
      } else if (!res.destroyed) {
        res.destroy(error);
      }
      settle('upstream-error', false, proxyRes.statusCode || 0);
    });
    proxyRes.once('end', () => settle('response-end', true, proxyRes.statusCode || 0));
    proxyRes.once('aborted', () => settle('upstream-aborted', false, proxyRes.statusCode || 0));
    proxyRes.pipe(res);
  });

  if (proxyOptions.idleTimeoutMs) {
    proxyReq.setTimeout(proxyOptions.idleTimeoutMs, () => {
      const error = new Error('upstream idle timeout');
      error.code = 'OCR_PROXY_IDLE_TIMEOUT';
      if (!res.headersSent) {
        send(res, 504, JSON.stringify({ ok: false, error: error.message }), {
          'Content-Type': 'application/json; charset=utf-8'
        });
      } else if (!res.destroyed) {
        res.destroy(error);
      }
      proxyReq.destroy(error);
      if (proxyResRef && !proxyResRef.destroyed) proxyResRef.destroy(error);
      settle('idle-timeout', false, 504);
    });
  }
  if (proxyOptions.totalTimeoutMs) {
    totalTimer = setTimeout(() => {
      const error = new Error('upstream total timeout');
      error.code = 'OCR_PROXY_TOTAL_TIMEOUT';
      proxyReq.destroy(error);
      if (proxyResRef && !proxyResRef.destroyed) proxyResRef.destroy(error);
      if (!res.headersSent) {
        send(res, 504, JSON.stringify({ ok: false, error: error.message }), {
          'Content-Type': 'application/json; charset=utf-8'
        });
      } else if (!res.destroyed) {
        res.destroy(error);
      }
      settle('total-timeout', false, 504);
    }, proxyOptions.totalTimeoutMs);
    totalTimer.unref?.();
  }

  proxyReq.on('error', error => {
    console.warn(`[proxy] request error to ${targetHost}:${targetPort}:`, error.message);
    if (error.code !== 'OCR_PROXY_IDLE_TIMEOUT') {
      send(res, 502, JSON.stringify({ ok: false, error: error.message }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }
    settle(error.code === 'OCR_PROXY_IDLE_TIMEOUT' ? 'idle-timeout' : 'upstream-error', false, 502);
  });

  req.on('aborted', () => {
    if (!proxyReq.destroyed) proxyReq.destroy();
    if (proxyResRef && !proxyResRef.destroyed) proxyResRef.destroy();
    settle('client-request-aborted', false, 499);
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      if (!proxyReq.destroyed) proxyReq.destroy();
      if (proxyResRef && !proxyResRef.destroyed) proxyResRef.destroy();
      settle('client-response-closed', false, 499);
    }
  });

  req.pipe(proxyReq);
};

const proxyWebSocket = (req, socket, head, targetHost, targetPort) => {
  const isOcrSocket = targetHost === OCR_TARGET_HOST && Number(targetPort) === Number(OCR_TARGET_PORT);
  if (isOcrSocket && (
    activeOcrWebSockets >= 1 ||
    ACTIVE_OCR_TASK_IDS.size > 0 ||
    countAgentActiveSockets(OCR_TASK_AGENT) > 0 ||
    countAgentPendingRequests(OCR_TASK_AGENT) > 0
  )) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 5\r\n\r\n');
    return;
  }
  if (isOcrSocket) activeOcrWebSockets += 1;
  const requestId = String(req.headers['x-ocr-task-id'] || crypto.randomUUID());
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let closed = false;
  let totalTimer = null;
  const targetSocket = net.connect(targetPort, targetHost, () => {
    targetSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    Object.entries(req.headers).forEach(([key, value]) => {
      if (key.toLowerCase() === 'host') {
        targetSocket.write(`Host: ${targetHost}:${targetPort}\r\n`);
        return;
      }
      targetSocket.write(`${key}: ${value}\r\n`);
    });
    targetSocket.write('\r\n');
    if (head && head.length) {
      targetSocket.write(head);
    }
    socket.pipe(targetSocket).pipe(socket);
  });

  const closeBoth = reason => {
    if (closed) return;
    closed = true;
    clearTimeout(totalTimer);
    if (isOcrSocket) activeOcrWebSockets = Math.max(0, activeOcrWebSockets - 1);
    const endedAtIso = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    console.log(`[ocr-websocket] id=${requestId} start=${startedAtIso} end=${endedAtIso} durationMs=${durationMs} close=${reason || 'closed'}`);
    writeOcrConnectionLog({
      service: 'ocr-websocket',
      requestId,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      durationMs,
      closeReason: reason || 'closed'
    });
    socket.destroy();
    targetSocket.destroy();
  };

  totalTimer = setTimeout(() => closeBoth('total-timeout'), OCR_TASK_TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();
  targetSocket.on('error', () => closeBoth('upstream-error'));
  targetSocket.on('end', () => closeBoth('upstream-end'));
  targetSocket.on('close', () => closeBoth('upstream-close'));
  socket.on('error', () => closeBoth('client-error'));
  socket.on('end', () => closeBoth('client-end'));
  socket.on('close', () => closeBoth('client-close'));
};

const serveStatic = (req, res) => {
  let requestPath;
  try {
    requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }

  let filePath = path.resolve(ROOT, requestPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  if (requestPath === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT, 'index.html');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    send(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const relativePath = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const isHashedAsset = /^static\/(?:js|css)\/[^/]+\.[a-f0-9]{8}(?:\.chunk)?\.(?:js|css)$/i.test(relativePath);
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isHashedAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-store'
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  const closeStream = () => stream.destroy();
  res.once('close', closeStream);
  stream.once('close', () => res.removeListener('close', closeStream));
  stream.on('error', error => {
    console.warn('[static] stream failed:', error.message);
    if (!res.headersSent) send(res, 500, 'Static file read failed');
    else if (!res.destroyed) res.destroy(error);
  });
  stream.pipe(res);
};

const server = http.createServer((req, res) => {
  const finishAudit = auditRequest(req);
  res.on('finish', () => finishAudit(res));

  if (req.method === 'OPTIONS') {
    send(res, 200, '', {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Private-Network': 'true'
    });
    return;
  }

  if (pdfExportOptimizer.handle(req, res)) return;

  if (pdfPageCacheService?.handle(req, res)) {
    return;
  }

  if (handleSsoAccessToken(req, res)) {
    return;
  }

  if (req.url === '/api/sso/me') {
    handleSsoMe(req, res);
    return;
  }

  if (req.url === '/admin') {
    serveAdmin(req, res);
    return;
  }

  if (req.url.startsWith('/api/admin/audit/list')) {
    handleAuditList(req, res);
    return;
  }

  if (req.url.startsWith('/api/admin/audit/stats')) {
    handleAuditStats(req, res);
    return;
  }

  if (req.url === '/api/admin/audit/event') {
    handleAuditEvent(req, res);
    return;
  }

  if (req.url === '/api/processing-logs/special-block') {
    handleSpecialBlockRecognitionLog(req, res);
    return;
  }

  if (req.url === '/ocr-text-detect-upload') {
    proxyDetectTextUpload(req, res);
    return;
  }

  if (req.url.startsWith('/api/proxy/h3yun')) {
    handleH3yunProxy(req, res);
    return;
  }

  if (req.url === '/api/logs/save') {
    mirrorProcessingLogRequest(req);
    proxyOcrRequest(req, res);
    return;
  }

  if (
    req.url.startsWith('/api/recognize/')
    || req.url.startsWith('/api/vectors/')
    || req.url.startsWith('/api/pdf/')
    || req.url.startsWith('/api/logs/')
    || req.url === '/api/client-ip'
    || req.url.startsWith('/api/annotation-drafts/')
  ) {
    proxyOcrRequest(req, res);
    return;
  }

  if (req.url.startsWith('/mineru/')) {
    proxyMineruRequest(req, res);
    return;
  }

  if (req.url.startsWith('/api/weld-ai/')) {
    proxyWeldAiRequest(req, res);
    return;
  }

  if (req.url === '/health') {
    proxyOcrHealth(req, res);
    return;
  }

  if (req.url.startsWith('/api/autosave/')) {
    proxyAutosave(req, res);
    return;
  }

  if (req.url.startsWith('/support-proxy/')) {
    proxySupportRequest(req, res);
    return;
  }

  serveStatic(req, res);
});

// Streaming a large source PDF to the shared page cache can legitimately take
// longer than Node's default request window on the public route. Proxy/OCR
// routes retain their own tighter total and idle timeouts.
server.requestTimeout = 30 * 60 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`Luotu prod server listening on http://${HOST}:${PORT}`);
  console.log(`Serving ${ROOT}`);
  console.log(`Autosave proxy -> http://${AUTOSAVE_TARGET_HOST}:${AUTOSAVE_TARGET_PORT}`);
  console.log(`Support chat proxy -> http://${SUPPORT_TARGET_HOST}:${SUPPORT_TARGET_PORT}`);
  console.log(`OCR proxy -> http://${OCR_TARGET_HOST}:${OCR_TARGET_PORT}/api/recognize/*`);
  console.log(`MinerU proxy -> http://${MINERU_TARGET_HOST}:${MINERU_TARGET_PORT}`);
  console.log(`Weld AI proxy -> http://${WELD_AI_TARGET_HOST}:${WELD_AI_TARGET_PORT}`);
  console.log(`Detect text upload proxy -> http://${OCR_TARGET_HOST}:${OCR_TARGET_PORT}/api/recognize/detect-text-upload`);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/api/recognize/websocket/')) {
    proxyWebSocket(req, socket, head, OCR_TARGET_HOST, OCR_TARGET_PORT);
    return;
  }
  socket.destroy();
});

server.on('clientError', (error, socket) => {
  console.warn('[http] client connection error:', error.message);
  if (socket && socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } else if (socket) {
    socket.destroy();
  }
});
