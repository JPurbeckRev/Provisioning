#!/usr/bin/env node
// Platez dev server — serves static files + proxies /api/* → LM Studio

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 8765;
const LM_STUDIO = 'http://192.168.0.65:1234';
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DATA_DIR = path.join(__dirname, 'data');

http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // POST /log — persist analysis run logs
  if (req.method === 'POST' && req.url === '/log') {
    let body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const entry = JSON.parse(Buffer.concat(body).toString());
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(LOG_DIR, `run-${ts}.json`);
        fs.writeFileSync(logFile, JSON.stringify(entry, null, 2));
        // Also append a summary line to the rolling log
        const summary = `${new Date().toISOString()} | plate=${entry.plate_number || '?'} | state=${entry.state || '?'} | truncated=${entry.potentially_truncated || false} | rejected_vt=${entry._rejected_vertical_text || 'none'}\n`;
        fs.appendFileSync(path.join(LOG_DIR, 'runs.log'), summary);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /lm-models → fetch available models from LM Studio
  if (req.method === 'GET' && req.url === '/lm-models') {
    const parsed = new URL(LM_STUDIO + '/v1/models');
    const proxy = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 1234,
      path: parsed.pathname,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, (pr) => {
      let body = [];
      pr.on('data', c => body.push(c));
      pr.on('end', () => {
        res.writeHead(pr.statusCode, { 'Content-Type': 'application/json', ...CORS });
        res.end(Buffer.concat(body));
      });
    });
    proxy.on('error', e => {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: `LM Studio unreachable: ${e.message}`, data: [] }));
    });
    proxy.end();
    return;
  }

  // GET /logs — list all run/feedback JSON files (newest first)
  if (req.method === 'GET' && req.url === '/logs') {
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a)); // newest first (ISO timestamp in filename)
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(files));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /logs/<filename> — return a specific log file
  if (req.method === 'GET' && req.url.startsWith('/logs/')) {
    const filename = path.basename(req.url.slice(6));
    if (!filename.endsWith('.json') || filename.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return;
    }
    const filePath = path.join(LOG_DIR, filename);
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(data);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  // Proxy /api/* → LM Studio
  if (req.url.startsWith('/api/')) {
    const target = LM_STUDIO + req.url.slice(4); // strip /api prefix
    const parsed = new URL(target);
    let body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      body = Buffer.concat(body);
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || 1234,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: { ...req.headers, host: parsed.host },
      };
      const proxy = http.request(opts, (pr) => {
        res.writeHead(pr.statusCode, { ...pr.headers, ...CORS });
        pr.pipe(res);
      });
      proxy.on('error', e => {
        res.writeHead(502, CORS);
        res.end(JSON.stringify({ error: `Proxy error: ${e.message}` }));
      });
      proxy.write(body);
      proxy.end();
    });
    return;
  }

  // PUT /data/*.json — save taxonomy files
  if (req.method === 'PUT' && req.url.startsWith('/data/') && req.url.endsWith('.json')) {
    const filename = path.basename(req.url);
    const savePath = path.join(DATA_DIR, filename);
    // Safety: only allow writes inside the data directory
    if (!savePath.startsWith(DATA_DIR)) {
      res.writeHead(403, CORS); return res.end('Forbidden');
    }
    let body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(body).toString();
        JSON.parse(text); // validate JSON before writing
        fs.writeFileSync(savePath, JSON.stringify(JSON.parse(text), null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static file serving
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...CORS });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`Platez running at http://localhost:${PORT}`);
});
