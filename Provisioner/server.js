#!/usr/bin/env node
// Provisioner server — static files + Provisioner API + LM Studio proxy

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const regDocService = require('./services/regDocService');
const crossReferenceService = require('./services/crossReferenceService');
const plateOcrService = require('./services/plateOcrService');

const PORT = 8765;
const LM_STUDIO = 'http://127.0.0.1:1234';
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
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// In-memory queue
const provisioningQueue = [];
let nextId = 100000;

function saveImageToDisk(base64, id, type) {
  const ext = base64.startsWith('iVBOR') ? 'png' : base64.startsWith('UklGR') ? 'webp' : 'jpg';
  const filename = `${id}-${type}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(base64, 'base64'));
  return `/uploads/${filename}`;
}

http.createServer((req, res) => {
  const urlNoQs = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // ── VIN Lookup Proxy ──────────────────────────────────────────────
  if (req.method === 'GET' && urlNoQs.match(/\/api\/v1\/vin-lookup\/[^/]+\/[^/]+$/)) {
    const parts = urlNoQs.split('/');
    const state = parts[parts.length - 2];
    const lpn = parts[parts.length - 1];
    const targetUrl = `https://licenseplatedata.com/consumer-api/ROBERT-LPDHQTHCI/${state}/${lpn}`;
    https.get(targetUrl, (apiRes) => {
      let body = '';
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', ...CORS });
        res.end(body);
      });
    }).on('error', (e) => {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── POST /api/v1/queue — customer submission ──────────────────────
  if (req.method === 'POST' && urlNoQs === '/api/v1/queue') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(Buffer.concat(body).toString());
        const { customerInput, plateImageBase64, regDocImageBase64 } = payload;

        if (!customerInput || !plateImageBase64 || !regDocImageBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
          return res.end(JSON.stringify({ error: 'Missing required fields' }));
        }

        const id = nextId++;
        const plateFilename = saveImageToDisk(plateImageBase64, id, 'plate').split('/').pop();
        const regFilename = saveImageToDisk(regDocImageBase64, id, 'reg').split('/').pop();
        const plateImageUrl = `/api/v1/image/${plateFilename}`;
        const regDocImageUrl = `/api/v1/image/${regFilename}`;

        const record = {
          id,
          requestedDate: new Date().toISOString(),
          status: 'PROCESSING',
          source: 'DIRECT',
          customerInput,
          plateImageUrl,
          regDocImageUrl,
          plateOcr: null,
          regDocOcr: null,
          crossReference: null,
          plateSerialNumber: 'B8AB' + Math.floor(Math.random() * 100000000)
        };

        provisioningQueue.unshift(record);

        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ success: true, id: record.id }));

        // Background VLM processing (Option B)
        try {
          const regB64 = fs.readFileSync(path.join(UPLOADS_DIR, regFilename)).toString('base64');
          
          // Use pre-processed plate OCR from frontend Platez pipeline, or fallback
          const plateOcr = payload.plateOcrPreProcessed || await plateOcrService.processPlateImage(fs.readFileSync(path.join(UPLOADS_DIR, plateFilename)).toString('base64'));
          
          const regDocResult = await regDocService.processRegistrationDocument(regB64);
          
          // Map Platez payload format to Provisioner format
          record.plateOcr = {
            plate_string: plateOcr.plate_number || plateOcr.plate_string,
            formatted_lpn: plateOcr.plate_number_formatted || plateOcr.formatted_lpn,
            state: plateOcr.state,
            design_type: plateOcr.design_type,
            vertical_text: plateOcr.vertical_text,
            vertical_text_position: plateOcr.vertical_text_position,
            is_disabled: plateOcr.is_disabled,
            disabled_type: plateOcr.disabled_type
          };
          record.regDocOcr = regDocResult.data || {};
          const validation = crossReferenceService.validateProvisioningData(
            customerInput, record.plateOcr, record.regDocOcr
          );
          record.crossReference = validation;
          record.status = validation.routingStatus === 'AUTO_POPULATE' ? 'AUTOPOPULATE' : 'REQUIRESATTENTION';
        } catch (e) {
          console.error('Background VLM error:', e);
          record.status = 'SYSTEMERROR';
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/v1/queue — admin list ────────────────────────────────
  if (req.method === 'GET' && urlNoQs === '/api/v1/queue') {
    const summaries = provisioningQueue.map(r => ({
      id: r.id,
      plateSerialNumber: r.plateSerialNumber,
      vin: r.customerInput?.VIN || 'Pending',
      plateNumber: r.customerInput?.LPN || 'Pending',
      state: r.customerInput?.State || 'Pending',
      status: r.status,
      requestedDate: r.requestedDate,
      source: r.source
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(summaries));
    return;
  }

  // ── GET /api/v1/queue/:id — single record ─────────────────────────
  if (req.method === 'GET' && urlNoQs.match(/\/api\/v1\/queue\/\d+$/)) {
    const id = parseInt(urlNoQs.split('/').pop(), 10);
    const record = provisioningQueue.find(r => r.id === id);
    if (record) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(record));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  // ── POST /log ─────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/log') {
    let body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const entry = JSON.parse(Buffer.concat(body).toString());
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        if (entry._image_base64) {
          const imgData = entry._image_base64.replace(/^data:image\/\w+;base64,/, '');
          const ext = entry._image_mime === 'image/jpeg' ? '.jpg' : '.png';
          fs.writeFileSync(path.join(LOG_DIR, `img-${ts}${ext}`), Buffer.from(imgData, 'base64'));
          delete entry._image_base64; delete entry._image_mime;
        }
        fs.writeFileSync(path.join(LOG_DIR, `run-${ts}.json`), JSON.stringify(entry, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, CORS); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /lm-models ────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/lm-models') {
    const parsed = new URL(LM_STUDIO + '/v1/models');
    const proxy = http.request({ hostname: parsed.hostname, port: parsed.port || 1234, path: parsed.pathname, method: 'GET', headers: { 'Accept': 'application/json' } }, (pr) => {
      let body = []; pr.on('data', c => body.push(c));
      pr.on('end', () => { res.writeHead(pr.statusCode, { 'Content-Type': 'application/json', ...CORS }); res.end(Buffer.concat(body)); });
    });
    proxy.on('error', e => { res.writeHead(502, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify({ error: `LM Studio unreachable: ${e.message}`, data: [] })); });
    proxy.end();
    return;
  }

  // ── Image serving via API path ────────────────────────────────────
  if (req.method === 'GET' && urlNoQs.match(/\/api\/v1\/image\/[^/]+$/)) {
    const filename = path.basename(urlNoQs);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filename);
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime, ...CORS });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, CORS); res.end('Not found');
    }
    return;
  }

  // ── Proxy /api/* → LM Studio (legacy Platez pass-through) ─────────
  if (req.url.startsWith('/api/')) {
    const target = LM_STUDIO + req.url.slice(4);
    const parsed = new URL(target);
    let body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      body = Buffer.concat(body);
      const opts = { hostname: parsed.hostname, port: parsed.port || 1234, path: parsed.pathname + parsed.search, method: req.method, headers: { ...req.headers, host: parsed.host } };
      const proxy = http.request(opts, (pr) => { res.writeHead(pr.statusCode, { ...pr.headers, ...CORS }); pr.pipe(res); });
      proxy.on('error', e => { res.writeHead(502, CORS); res.end(JSON.stringify({ error: `Proxy error: ${e.message}` })); });
      proxy.write(body); proxy.end();
    });
    return;
  }

  // ── PUT /data/*.json ──────────────────────────────────────────────
  if (req.method === 'PUT' && req.url.startsWith('/data/') && req.url.endsWith('.json')) {
    const savePath = path.join(DATA_DIR, path.basename(req.url));
    let body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(body).toString();
        JSON.parse(text);
        fs.writeFileSync(savePath, JSON.stringify(JSON.parse(text), null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, CORS); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── Image serving via API path (proxied through remote) ──────────
  if (req.method === 'GET' && urlNoQs.match(/\/api\/v1\/image\/[^/]+$/)) {
    const filename = path.basename(urlNoQs);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filename);
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime, ...CORS });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Static file serving ───────────────────────────────────────────
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...CORS });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`Provisioner running at http://localhost:${PORT}`);
});
