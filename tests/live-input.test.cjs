const assert = require('node:assert/strict');
const test = require('node:test');
const live = require('../live-input.js');
const { createServer } = require('../server.cjs');

test('normalize clamps values and rejects malformed messages', () => {
  assert.deepEqual(live.normalize({ speed: 9, zoom: 0.2, x: 50 }).patch, { speed: 3, zoom: 1, x: 50 });
  assert.equal(live.normalize({ speed: '2' }).ok, false);
  assert.equal(live.normalize({ speed: NaN }).ok, false);
  assert.equal(live.normalize({ speed: Infinity }).ok, false);
  assert.equal(live.normalize({ foo: 1 }).ok, false);
  assert.equal(live.normalize(null).ok, false);
  assert.equal(live.normalize([1]).ok, false);
  assert.equal(live.normalize({ x: 1, seq: -1 }).seq, null);
});

test('normalize accepts elbow angle in degrees and clamps it', () => {
  assert.deepEqual(live.normalize({ elbow: 200 }).patch, { elbow: 150 });
  assert.deepEqual(live.normalize({ elbow: -10 }).patch, { elbow: 0 });
  assert.equal(live.normalize({ elbow: 'bent' }).ok, false);
});

test('channel drops late packets but accepts a restarted sender', () => {
  const ch = live.createChannel({ staleMs: 1000 });
  assert.ok(ch.receive({ seq: 5, zoom: 2 }, 0).ok);
  assert.equal(ch.receive({ seq: 4, zoom: 3 }, 10).ok, false);
  assert.equal(ch.stats(10).target.zoom, 2);
  assert.ok(ch.receive({ seq: 0, zoom: 4 }, 2000).ok, 'restart after silence');
  assert.equal(ch.stats(2000).dropped, 1);
});

test('channel smooths toward the target without overshoot and reports staleness', () => {
  const ch = live.createChannel({ staleMs: 500, smoothingMs: 80 });
  assert.equal(ch.state(0), 'waiting');
  assert.equal(ch.step({ zoom: 1 }, 16), null);
  ch.receive({ zoom: 3 }, 0);
  let z = ch.step({ zoom: 1 }, 16).zoom;
  assert.ok(z > 1 && z < 3);
  for (let i = 0; i < 200; i++) {
    const next = ch.step(null, 16).zoom;
    assert.ok(next >= z && next <= 3);
    z = next;
  }
  assert.equal(z, 3);
  assert.equal(ch.state(100), 'live');
  assert.equal(ch.state(600), 'stale');
  assert.equal(ch.step(null, 1e9).zoom, 3, 'huge frame gaps are capped');
});

test('server relays validated input to live listeners', async t => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.closeAll());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ac = new AbortController();
  t.after(() => ac.abort());
  const stream = await fetch(base + '/live', { signal: ac.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.getReader(),
    decoder = new TextDecoder();
  const post = body =>
    fetch(base + '/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await post('{"speed":"fast"}')).status, 400);
  assert.equal((await post('not json')).status, 400);
  assert.equal(
    (
      await fetch(base + '/input', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"speed":1}',
      })
    ).status,
    415,
  );
  assert.equal((await post('x'.repeat(20000))).status, 413);
  const ok = await post(
    JSON.stringify([
      { seq: 1, speed: 0.5 },
      { seq: 2, zoom: 7 },
    ]),
  );
  assert.equal(ok.status, 202);
  assert.equal((await ok.json()).listeners, 1);
  let text = '';
  while (!/"seq":2/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  const events = [...text.matchAll(/^data: (.*)$/gm)].map(m => JSON.parse(m[1]));
  assert.deepEqual(
    events.map(e => [e.seq, e.speed, e.zoom]),
    [
      [1, 0.5, undefined],
      [2, undefined, 5],
    ],
  );
});
