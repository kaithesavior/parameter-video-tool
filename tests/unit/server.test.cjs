const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createServer, parseRange } = require('../../server/server.cjs');

async function withServer(run, options) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAll();
  }
}

test('parseRange handles explicit, open and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), [0, 99]);
  assert.deepEqual(parseRange('bytes=900-', 1000), [900, 999]);
  assert.deepEqual(parseRange('bytes=0-5000', 1000), [0, 999]);
  assert.deepEqual(parseRange('bytes=-100', 1000), [900, 999]);
  assert.deepEqual(parseRange('bytes=-5000', 1000), [0, 999]);
  for (const bad of ['bytes=-', 'bytes=-0', 'bytes=1000-', 'bytes=5-2', 'items=0-1', 'bytes=0-1,4-5'])
    assert.equal(parseRange(bad, 1000), null, bad);
});

test('serves the page, scripts and videos with range support', async t => {
  // A temporary videos folder holding the test clip.
  const videosDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'server-test-'));
  t.after(() => fs.rmSync(videosDir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'sample.mov'), path.join(videosDir, 'sample.mov'));
  const size = fs.statSync(path.join(videosDir, 'sample.mov')).size;
  await withServer(async base => {
    assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 302);
    const page = await fetch(base + '/index.html');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(base + '/js/ui/app.js')).status, 200);
    const head = await fetch(base + '/videos/sample.mov', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), size);
    const part = await fetch(base + '/videos/sample.mov', { headers: { Range: 'bytes=-100' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes ${size - 100}-${size - 1}/${size}`);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const bad = await fetch(base + '/videos/sample.mov', { headers: { Range: `bytes=${size}-` } });
    assert.equal(bad.status, 416);
  }, { videosDir });
});

test('keeps server code, the bridge, tests and source control private', async () => {
  await withServer(async base => {
    const privateFiles = [
      '/server.cjs',
      '/server/server.cjs',
      '/public/index.html',
      '/package.json',
      '/.git/config',
      '/stickies_bridge/cli.py',
      '/tests/fixtures/sample.mov',
      '/assets/biceps-source.mov',
      '/vendor/Video-Sticky-Algorithms/README.md',
      '/tests/unit/server.test.cjs',
      '/js/ui/../../../server/server.cjs',
      '/assets/../server.cjs',
      '/%2e%2e/etc/passwd',
    ];
    for (const name of privateFiles) assert.equal((await fetch(base + name)).status, 404, name);
  });
});

test('a null byte in the path is rejected without crashing the server', async () => {
  await withServer(async base => {
    assert.equal((await fetch(base + '/%00')).status, 400);
    assert.equal((await fetch(base + '/index.html%00.js')).status, 400);
    assert.equal((await fetch(base + '/index.html')).status, 200);
  });
});

test('opening /input in a browser shows a link to the editor; programs still get JSON', async () => {
  await withServer(async base => {
    const page = await fetch(base + '/input', { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 405);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<a href="\/">Open the editor<\/a>/);
    const api = await fetch(base + '/input');
    assert.equal(api.status, 405);
    assert.deepEqual(await api.json(), { ok: false, error: 'Use POST.' });
  });
});
