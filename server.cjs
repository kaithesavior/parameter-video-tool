// Local-only server: static files with byte-range support for video seeking,
// plus a real-time parameter relay.
//   POST /input  JSON {speed?, zoom?, x?, y?, seq?} or an array of them  -> 202
//   GET  /live   Server-Sent Events stream of validated patches (auto-reconnects in the browser)
'use strict';
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');
const LiveInput = require('./live-input.js');

const root = path.resolve(__dirname);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
};
const MAX_BODY = 16 * 1024,
  MAX_BATCH = 64,
  HEARTBEAT_MS = 10000;

function json(res, status, body) {
  res
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(body));
}

function createServer() {
  const clients = new Set();
  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  }

  function live(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n: connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function input(req, res) {
    // Requiring application/json makes browsers preflight cross-origin requests, which this
    // server never approves, so other websites cannot drive the player.
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      json(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        json(res, 413, { ok: false, error: 'Body exceeds 16 KB.' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(res, 400, { ok: false, error: 'Body is not valid JSON.' });
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      if (!messages.length || messages.length > MAX_BATCH) {
        json(res, 400, { ok: false, error: `Send 1–${MAX_BATCH} messages.` });
        return;
      }
      const results = messages.map(LiveInput.normalize),
        bad = results.findIndex(r => !r.ok);
      if (bad !== -1) {
        json(res, 400, { ok: false, index: bad, error: results[bad].error });
        return;
      }
      const t = Date.now();
      for (const r of results) broadcast({ ...r.patch, ...(r.seq !== null && { seq: r.seq }), t });
      json(res, 202, { ok: true, accepted: results.length, listeners: clients.size });
    });
    req.on('error', () => res.destroy());
  }

  function serveFile(req, res, name) {
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404).end();
        return;
      }
      let start = 0,
        end = stat.size - 1;
      const headers = {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!match) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
          return;
        }
        start = +match[1];
        end = match[2] ? Math.min(+match[2], end) : end;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
          return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(req.headers.range ? 206 : 200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(file, { start, end })
        .on('error', () => res.destroy())
        .pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    let name;
    try {
      name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (name === '/live' && req.method === 'GET') {
      live(req, res);
      return;
    }
    if (name === '/input') {
      if (req.method === 'POST') input(req, res);
      else json(res, 405, { ok: false, error: 'Use POST.' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (name === '/') {
      res.writeHead(302, { Location: '/index.html' }).end();
      return;
    }
    serveFile(req, res, name);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
  });
  server.closeAll = () => {
    for (const client of clients) client.end();
    clients.clear();
    server.close();
  };
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173,
    server = createServer();
  server.on('error', err => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Stop the other server or run PORT=4174 npm start.`
        : err.message,
    );
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`Stickies: http://127.0.0.1:${port}\nLive input: POST http://127.0.0.1:${port}/input`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.closeAll();
      process.exit(0);
    });
}
module.exports = { createServer };
