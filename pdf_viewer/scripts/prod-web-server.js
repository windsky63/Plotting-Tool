const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { URL } = require('url');

const rootDir = path.resolve(__dirname, '..');
const staticDir = path.join(rootDir, 'build_prod');
const port = Number(process.env.PORT || 3005);
const host = process.env.HOST || '0.0.0.0';

const proxyTargets = [
  {
    prefix: '/api/mineru',
    target: new URL(process.env.MINERU_TARGET || 'http://192.168.32.61:8081')
  },
  {
    prefix: '/api/ocr',
    target: new URL(process.env.OCR_TARGET || 'http://192.168.32.61:8766')
  }
];

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function getProxyMatch(urlPath) {
  return proxyTargets.find(({ prefix }) => urlPath === prefix || urlPath.startsWith(`${prefix}/`));
}

function getProxyPath(urlPath, prefix, search) {
  const strippedPath = urlPath.slice(prefix.length) || '/';
  return `${strippedPath.startsWith('/') ? strippedPath : `/${strippedPath}`}${search || ''}`;
}

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function serveStatic(req, res, urlPath) {
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(urlPath);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  const normalizedPath = path.normalize(requestedPath).replace(/^([/\\])+/, '');
  let filePath = path.join(staticDir, normalizedPath);

  if (!filePath.startsWith(staticDir)) {
    sendNotFound(res);
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    filePath = path.join(staticDir, 'index.html');
  }

  if (!filePath.startsWith(staticDir) || !fs.existsSync(filePath)) {
    sendNotFound(res);
    return;
  }

  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
}

function proxyHttp(req, res, match, parsedUrl) {
  const targetPath = getProxyPath(parsedUrl.pathname, match.prefix, parsedUrl.search);
  const targetPort = Number(match.target.port || 80);
  const headers = {
    ...req.headers,
    host: match.target.host,
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-proto': 'http'
  };

  const proxyReq = http.request({
    hostname: match.target.hostname,
    port: targetPort,
    method: req.method,
    path: targetPath,
    headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'proxy_failed', message: error.message }));
  });

  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, match, parsedUrl) {
  const targetPath = getProxyPath(parsedUrl.pathname, match.prefix, parsedUrl.search);
  const targetPort = Number(match.target.port || 80);
  const targetSocket = net.connect(targetPort, match.target.hostname, () => {
    const headers = {
      ...req.headers,
      host: match.target.host
    };
    const headerLines = Object.entries(headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(',') : value}`)
      .join('\r\n');

    targetSocket.write(`${req.method} ${targetPath} HTTP/${req.httpVersion}\r\n${headerLines}\r\n\r\n`);
    if (head && head.length) {
      targetSocket.write(head);
    }
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  targetSocket.on('error', () => socket.destroy());
  socket.on('error', () => targetSocket.destroy());
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const match = getProxyMatch(parsedUrl.pathname);

  if (match) {
    proxyHttp(req, res, match, parsedUrl);
    return;
  }

  serveStatic(req, res, parsedUrl.pathname);
});

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const match = getProxyMatch(parsedUrl.pathname);

  if (!match) {
    socket.destroy();
    return;
  }

  proxyUpgrade(req, socket, head, match, parsedUrl);
});

server.listen(port, host, () => {
  console.log(`Production web server listening on http://${host}:${port}`);
  console.log(`Serving ${staticDir}`);
  proxyTargets.forEach(({ prefix, target }) => {
    console.log(`Proxy ${prefix} -> ${target.origin}`);
  });
});
