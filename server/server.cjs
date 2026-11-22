// Local-only server: static files with byte-range support for video seeking, the videos
// folder, and a real-time parameter relay.
//   POST   /input              JSON {speed?, zoom?, x?, y?, time?, video?, source?, seq?} or an array of them -> 202
//   GET    /live               Server-Sent Events stream of validated patches
//   GET    /api/videos         videos in the videos folder: [{name, size, modified}]
//   POST   /api/videos?name=…  upload a video (raw body) into the videos folder        -> 201
//   DELETE /api/videos/<name>  delete a video from the videos folder                   -> 204
//   GET    /videos/<name>      play a video from the videos folder (byte ranges supported)
'use strict';
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const LiveInput = require('../public/js/model/live-input.js');

// The project folder (videos/ lives here) and the folder the browser may load from.
const root = path.resolve(__dirname, '..'),
  publicDir = path.join(root, 'public');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.json': 'application/json',
};
// Only public/ is served: the page, its stylesheet and its scripts (js/model, js/ui). Videos come
// from the videos folder (/videos/…).
// Source control, server code, the bridge and tests stay private.
const PUBLIC_PATH = /^\/(?:index\.html|style\.css|js\/(?:model|ui)\/[\w-]+\.js)$/;
const MAX_BODY = 16 * 1024,
  MAX_BATCH = 64,
  HEARTBEAT_MS = 10000,
  MAX_VIDEO_BYTES = 8 * 1024 ** 3;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;
// Uploads and deletes must carry this header. Browsers only send custom headers cross-origin
// after a preflight this server never approves, so other websites cannot write the folder.
const WRITE_HEADER = 'x-stickies-videos';

// A video file name that is safe to use in the videos folder, or null.
function safeVideoName(raw) {
  if (typeof raw !== 'string') return null;
  const name = path
    .basename(raw.normalize('NFC'))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
    .trim();
  if (!name || name.startsWith('.') || name.length > 150 || !VIDEO_EXT.test(name)) return null;
  return name;
}
// "clip.mp4" -> "clip (2).mp4", the first name not taken in the folder.
function uniqueName(dir, name) {
  const ext = path.extname(name),
    stem = name.slice(0, -ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

// Shown when /input is opened in a browser: it is an endpoint for programs, not a page.
function inputHelp(res) {
  res
    .writeHead(405, { 'Content-Type': 'text/html; charset=utf-8', Allow: 'POST', 'Cache-Control': 'no-store' })
    .end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live input endpoint</title>
<style>body{margin:0;padding:48px 16px;background:#141414;color:#e8e8e8;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
main{max-width:560px;margin:auto}a{color:#7aa7ff}code{background:#262626;padding:2px 5px;border-radius:4px}</style>
<main><h1>This is the live input endpoint</h1>
<p>Programs send speed, zoom and focus here with <code>POST /input</code>. It is not a page.</p>
<p><a href="/">Open the editor</a></p></main>`);
}

function json(res, status, body) {
  res
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(body));
}

// Parses a single byte range ("bytes=a-b", "bytes=a-" or the suffix form "bytes=-n").
// Returns [start, end], or null when the range cannot be satisfied.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = +match[2];
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = +match[1];
    end = match[2] ? Math.min(+match[2], size - 1) : size - 1;
  }
  return start > end || start >= size ? null : [start, end];
}

function servePublic(req, res, name) {
  const file = path.resolve(publicDir, '.' + name);
  if (!PUBLIC_PATH.test(name) || name.includes('..') || !file.startsWith(publicDir + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  serveFile(req, res, file);
}

function serveFile(req, res, file) {
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
      const range = parseRange(req.headers.range, stat.size);
      if (!range) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      [start, end] = range;
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

function createServer({ videosDir = process.env.VIDEOS_DIR || path.join(root, 'videos') } = {}) {
  const clients = new Set();
  fs.mkdirSync(videosDir, { recursive: true });

  // ----- Videos folder -----
  function listVideos(res) {
    let names;
    try {
      names = fs.readdirSync(videosDir).filter(name => safeVideoName(name) === name);
    } catch (error) {
      json(res, 500, { ok: false, error: error.message });
      return;
    }
    const videos = [];
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(videosDir, name));
        if (stat.isFile()) videos.push({ name, size: stat.size, modified: stat.mtimeMs });
      } catch {
        // Removed while listing.
      }
    }
    videos.sort((a, b) => b.modified - a.modified);
    json(res, 200, { ok: true, videos });
  }

  function uploadVideo(req, res, rawName) {
    const name = safeVideoName(rawName);
    if (!name) {
      json(res, 400, { ok: false, error: 'Give a video file name ending in .mp4, .m4v, .webm, .mov or .ogv.' });
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_VIDEO_BYTES) {
      json(res, 413, { ok: false, error: 'Videos must be under 8 GB.' });
      req.resume();
      return;
    }
    // Written to a hidden temporary file first, so a broken upload never looks like a video.
    const temp = path.join(videosDir, `.upload-${crypto.randomUUID()}`);
    const out = fs.createWriteStream(temp);
    let size = 0,
      failed = false;
    const fail = (status, error) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(temp, { force: true }, () => {});
      if (!res.headersSent) json(res, status, { ok: false, error });
    };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_VIDEO_BYTES) {
        fail(413, 'Videos must be under 8 GB.');
        req.destroy();
      }
    });
    req.on('aborted', () => fail(400, 'Upload interrupted.'));
    req.on('error', () => fail(400, 'Upload interrupted.'));
    out.on('error', error => fail(500, error.message));
    out.on('finish', () => {
      if (failed) return;
      let finalName = name;
      const target = path.join(videosDir, name);
      try {
        if (fs.existsSync(target)) {
          // The same file imported again is reused; a different file gets a new name.
          if (fs.statSync(target).size === size) {
            fs.rmSync(temp, { force: true });
            json(res, 200, { ok: true, name, size, existed: true });
            return;
          }
          finalName = uniqueName(videosDir, name);
        }
        fs.renameSync(temp, path.join(videosDir, finalName));
      } catch (error) {
        fail(500, error.message);
        return;
      }
      json(res, 201, { ok: true, name: finalName, size });
    });
    req.pipe(out);
  }

  function deleteVideo(res, rawName) {
    const name = safeVideoName(rawName);
    if (!name || name !== rawName) {
      json(res, 400, { ok: false, error: 'Not a video in the videos folder.' });
      return;
    }
    fs.rm(path.join(videosDir, name), error => {
      if (error) json(res, error.code === 'ENOENT' ? 404 : 500, { ok: false, error: error.message });
      else res.writeHead(204).end();
    });
  }

  function videosApi(req, res, name, url) {
    const writing = req.method === 'POST' || req.method === 'DELETE';
    if (writing && req.headers[WRITE_HEADER] !== '1') {
      json(res, 403, { ok: false, error: `Missing the ${WRITE_HEADER} header.` });
      return;
    }
    if (name === '/api/videos' && req.method === 'GET') listVideos(res);
    else if (name === '/api/videos' && req.method === 'POST') uploadVideo(req, res, url.searchParams.get('name'));
    else if (name.startsWith('/api/videos/') && req.method === 'DELETE')
      deleteVideo(res, name.slice('/api/videos/'.length));
    else json(res, 405, { ok: false, error: 'Unsupported method.' });
  }

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
      for (const r of results)
        broadcast({
          ...r.patch,
          ...(r.time !== null && { time: r.time }),
          ...(r.video !== null && { video: r.video }),
          ...(r.source !== null && { source: r.source }),
          ...(r.seq !== null && { seq: r.seq }),
          t,
        });
      json(res, 202, { ok: true, accepted: results.length, listeners: clients.size });
    });
    req.on('error', () => res.destroy());
  }

  const server = http.createServer((req, res) => {
    let name, url;
    try {
      url = new URL(req.url, 'http://localhost');
      name = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // fs throws synchronously on a null byte, which would crash the server.
    if (name.includes('\0')) {
      res.writeHead(400).end();
      return;
    }
    if (name === '/live' && req.method === 'GET') {
      live(req, res);
      return;
    }
    if (name === '/input') {
      if (req.method === 'POST') input(req, res);
      // Someone opened the endpoint in a browser: point them to the editor instead of raw JSON.
      else if (/text\/html/.test(req.headers.accept || '')) inputHelp(res);
      else json(res, 405, { ok: false, error: 'Use POST.' });
      return;
    }
    if (name === '/api/videos' || name.startsWith('/api/videos/')) {
      videosApi(req, res, name, url);
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
    if (name.startsWith('/videos/')) {
      const file = safeVideoName(name.slice('/videos/'.length));
      if (!file || file !== name.slice('/videos/'.length)) res.writeHead(404).end();
      else serveFile(req, res, path.join(videosDir, file));
      return;
    }
    servePublic(req, res, name);
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
    console.log(
      `\n  Open the editor:  http://127.0.0.1:${port}\n\n` +
        `  Videos folder:    ${process.env.VIDEOS_DIR || path.join(root, 'videos')}\n` +
        `  Live input (for programs, not a page): POST http://127.0.0.1:${port}/input\n`,
    ),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.closeAll();
      process.exit(0);
    });
}
module.exports = { createServer, parseRange, safeVideoName };
