const assert = require('node:assert/strict');
const test = require('node:test');
const live = require('../../public/js/model/live-input.js');
const { createServer } = require('../../server/server.cjs');

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

test('normalize only accepts view parameters', () => {
  assert.deepEqual(live.KEYS, ['speed', 'zoom', 'x', 'y']);
  assert.equal(live.normalize({ elbow: 90 }).ok, false, 'unsupported fields alone are rejected');
  assert.deepEqual(live.normalize({ zoom: 2, elbow: 90 }).patch, { zoom: 2 }, 'unsupported fields are ignored');
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

test('normalize accepts a followed position (time), alone or with view parameters', () => {
  assert.deepEqual(live.normalize({ time: 3.5 }), { ok: true, patch: {}, time: 3.5, video: null, source: null, seq: null });
  assert.equal(live.normalize({ speed: 1.5, time: 2 }).time, 2);
  assert.equal(live.normalize({ speed: 1.5 }).time, null);
  assert.equal(live.normalize({ time: -4 }).time, 0, 'clamped to the start');
  assert.equal(live.normalize({ time: '3' }).ok, false);
  assert.equal(live.normalize({ time: NaN }).ok, false);
});

test('channel extrapolates the followed position at the sent speed and drops it when stale', () => {
  const ch = live.createChannel({ staleMs: 1000 });
  assert.equal(ch.positionAt(0), null);
  ch.receive({ time: 10, speed: 2 }, 0);
  assert.equal(ch.positionAt(0), 10);
  assert.equal(ch.positionAt(500), 11, '0.5 s at 2x');
  assert.equal(ch.positionAt(1500), null, 'stale');
  ch.receive({ zoom: 2 }, 1600);
  assert.equal(ch.positionAt(1600), null, 'a message without time does not revive an old position');
  ch.reset();
  ch.receive({ time: 4 }, 0);
  assert.equal(ch.positionAt(1000), 5, 'speed 1 when none was sent');
});

test('follow closes small drift with the rate and jumps when far off', () => {
  const { FOLLOW } = live;
  assert.deepEqual(live.follow(1.5, 0.02), { rate: 1.5, seek: false }, 'dead zone');
  const ahead = live.follow(1, 0.4);
  assert.ok(ahead.rate > 1 && !ahead.seek, 'target ahead: play faster');
  const behind = live.follow(1, -0.4);
  assert.ok(behind.rate < 1 && !behind.seek, 'target behind: play slower');
  assert.equal(live.follow(0.25, -1).rate, FOLLOW.minRate, 'never stops or reverses');
  assert.ok(live.follow(3, 1.2).rate <= FOLLOW.maxRate);
  assert.equal(live.follow(1, 2).seek, true);
  assert.equal(live.follow(1, -2).seek, true);
  const r = live.follow(1, 0.33).rate;
  assert.ok(Math.abs(r / FOLLOW.step - Math.round(r / FOLLOW.step)) < 1e-9, 'rate is quantised');
});

test('server relays the followed position', async t => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.closeAll());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ac = new AbortController();
  t.after(() => ac.abort());
  const reader = (await fetch(base + '/live', { signal: ac.signal })).body.getReader(),
    decoder = new TextDecoder();
  const res = await fetch(base + '/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: 7, time: 4.25, speed: 1.4 }),
  });
  assert.equal(res.status, 202);
  let text = '';
  while (!/"seq":7/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  const event = JSON.parse(text.match(/^data: (.*)$/m)[1]);
  assert.equal(event.time, 4.25);
  assert.equal(event.speed, 1.4);
});

test('normalize accepts the video a message is for', () => {
  assert.equal(live.normalize({ speed: 1, video: 'curls.mp4' }).video, 'curls.mp4');
  assert.equal(live.normalize({ speed: 1 }).video, null);
  assert.equal(live.normalize({ speed: 1, video: 5 }).ok, false);
  assert.equal(live.normalize({ speed: 1, video: '' }).ok, false);
  assert.equal(live.normalize({ speed: 1, video: 'x'.repeat(201) }).ok, false);
  assert.equal(live.normalize({ video: 'curls.mp4' }).ok, false, 'a video name alone carries no values');
});

test('isForVideo matches by file name; messages without video apply to any video', () => {
  assert.equal(live.isForVideo(null, 'videos/clip.mov'), true);
  assert.equal(live.isForVideo('curls.mp4', 'videos/curls.mp4'), true);
  assert.equal(live.isForVideo('videos/curls.mp4', 'curls.mp4'), true);
  assert.equal(live.isForVideo('curls.mp4', 'videos/Exercise.mp4'), false);
  assert.equal(live.isForVideo('curls.mp4', 'videos/other.mov'), false);
  assert.equal(live.isForVideo('curls.mp4', ''), false, 'no open video');
});

test('server relays the video a message is for', async t => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.closeAll());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ac = new AbortController();
  t.after(() => ac.abort());
  const reader = (await fetch(base + '/live', { signal: ac.signal })).body.getReader(),
    decoder = new TextDecoder();
  const post = body =>
    fetch(base + '/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ speed: 1, video: 7 })).status, 400);
  assert.equal((await post({ seq: 3, speed: 1.2, video: 'curls.mp4' })).status, 202);
  let text = '';
  while (!/"seq":3/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  assert.equal(JSON.parse(text.match(/^data: (.*)$/m)[1]).video, 'curls.mp4');
});

test('normalize accepts a source name, which is shown and not applied', () => {
  const r = live.normalize({ speed: 1, source: '  hmm · curls-x1.50 ' });
  assert.equal(r.source, 'hmm · curls-x1.50');
  assert.deepEqual(r.patch, { speed: 1 });
  assert.equal(live.normalize({ speed: 1 }).source, null);
  assert.equal(live.normalize({ speed: 1, source: 3 }).ok, false);
  assert.equal(live.normalize({ speed: 1, source: '  ' }).ok, false);
  assert.equal(live.normalize({ speed: 1, source: 'x'.repeat(81) }).ok, false);
});

test('server relays the source name', async t => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.closeAll());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ac = new AbortController();
  t.after(() => ac.abort());
  const reader = (await fetch(base + '/live', { signal: ac.signal })).body.getReader(),
    decoder = new TextDecoder();
  const res = await fetch(base + '/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: 4, speed: 1, source: 'gvf · curls-x1.00' }),
  });
  assert.equal(res.status, 202);
  let text = '';
  while (!/"seq":4/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  assert.equal(JSON.parse(text.match(/^data: (.*)$/m)[1]).source, 'gvf · curls-x1.00');
});
