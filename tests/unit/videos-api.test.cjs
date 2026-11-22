const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createServer, safeVideoName } = require('../../server/server.cjs');

async function withServer(run) {
  const videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickies-videos-'));
  const server = createServer({ videosDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, videosDir);
  } finally {
    server.closeAll();
    fs.rmSync(videosDir, { recursive: true, force: true });
  }
}
const write = { 'x-stickies-videos': '1', 'Content-Type': 'video/mp4' };
const upload = (base, name, body, headers = write) =>
  fetch(`${base}/api/videos?name=${encodeURIComponent(name)}`, { method: 'POST', headers, body });

test('safeVideoName keeps real names and rejects unsafe ones', () => {
  assert.equal(safeVideoName('Squat front.mp4'), 'Squat front.mp4');
  assert.equal(safeVideoName('深蹲 教学.mov'), '深蹲 教学.mov');
  assert.equal(safeVideoName('../../etc/clip.mp4'), 'clip.mp4');
  assert.equal(safeVideoName('a:b?.webm'), 'a-b-.webm');
  for (const bad of ['', '.hidden.mp4', 'notes.txt', 'clip.mp4.exe', null, 'x'.repeat(200) + '.mp4'])
    assert.equal(safeVideoName(bad), null, String(bad));
});

test('uploads are saved in the videos folder, listed, played and deleted', async () => {
  await withServer(async (base, dir) => {
    const body = Buffer.alloc(5000, 7);
    const created = await upload(base, 'squat.mp4', body);
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { ok: true, name: 'squat.mp4', size: 5000 });
    assert.equal(fs.statSync(path.join(dir, 'squat.mp4')).size, 5000);

    const list = await (await fetch(base + '/api/videos')).json();
    assert.deepEqual(
      list.videos.map(v => [v.name, v.size]),
      [['squat.mp4', 5000]],
    );

    const part = await fetch(base + '/videos/squat.mp4', { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-type'), 'video/mp4');
    assert.equal((await part.arrayBuffer()).byteLength, 100);

    const removed = await fetch(base + '/api/videos/squat.mp4', { method: 'DELETE', headers: write });
    assert.equal(removed.status, 204);
    assert.equal(fs.existsSync(path.join(dir, 'squat.mp4')), false);
    assert.equal((await fetch(base + '/api/videos/squat.mp4', { method: 'DELETE', headers: write })).status, 404);
  });
});

test('the same file is reused; a different file with the same name gets a new name', async () => {
  await withServer(async (base, dir) => {
    await upload(base, 'clip.mov', Buffer.alloc(100, 1));
    const again = await (await upload(base, 'clip.mov', Buffer.alloc(100, 1))).json();
    assert.deepEqual(again, { ok: true, name: 'clip.mov', size: 100, existed: true });
    const other = await (await upload(base, 'clip.mov', Buffer.alloc(200, 2))).json();
    assert.equal(other.name, 'clip (2).mov');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['clip (2).mov', 'clip.mov']);
  });
});

test('writes need the custom header and a video name', async () => {
  await withServer(async (base, dir) => {
    assert.equal((await upload(base, 'a.mp4', 'x', { 'Content-Type': 'video/mp4' })).status, 403);
    assert.equal((await upload(base, 'notes.txt', 'x')).status, 400);
    assert.equal((await fetch(base + '/api/videos/a.mp4', { method: 'DELETE' })).status, 403);
    assert.equal(
      (await fetch(base + '/api/videos/..%2Fserver.cjs', { method: 'DELETE', headers: write })).status,
      400,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('only videos in the folder are served', async () => {
  await withServer(async (base, dir) => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'secret');
    fs.writeFileSync(path.join(dir, '.upload-temp'), 'partial');
    assert.equal((await fetch(base + '/videos/notes.txt')).status, 404);
    assert.equal((await fetch(base + '/videos/.upload-temp')).status, 404);
    assert.equal((await fetch(base + '/videos/..%2Fserver.cjs')).status, 404);
    const list = await (await fetch(base + '/api/videos')).json();
    assert.deepEqual(list.videos, []);
  });
});
