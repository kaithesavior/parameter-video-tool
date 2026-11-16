// Sends synthetic Stickies data to the live input relay.
// Usage: npm run simulate [-- --rate 30 --fields elbow --url http://127.0.0.1:4173/input]
'use strict';

// One generator per field; t is seconds since start.
const REP_SECONDS = 3; // one biceps curl: up and down
const SIGNALS = {
  speed: t => 1 + 0.6 * Math.sin(t * 0.7),
  zoom: t => 1.6 + 0.6 * Math.sin(t * 0.4),
  x: t => 55 + 12 * Math.sin(t * 0.5),
  y: t => 52 + 8 * Math.cos(t * 0.5),
  // Elbow flexion: 10° (arm straight) → 140° (curled) → back, like a real rep.
  elbow: t => 75 - 65 * Math.cos((2 * Math.PI * t) / REP_SECONDS),
};

function option(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = option('url', `http://127.0.0.1:${process.env.PORT || 4173}/input`);
const rate = Math.min(120, Math.max(1, Number(option('rate', 30))));
const fields = option('fields', Object.keys(SIGNALS).join(',')).split(',');
const unknown = fields.filter(field => !(field in SIGNALS));
if (unknown.length) {
  console.error(`Unknown field(s): ${unknown.join(', ')}. Choose from: ${Object.keys(SIGNALS).join(', ')}`);
  process.exit(1);
}

function buildMessage(seq, t) {
  const message = { seq };
  for (const field of fields) message[field] = Number(SIGNALS[field](t).toFixed(3));
  return message;
}

async function send(message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(1000),
  });
  if (response.ok) return;
  if (response.status === 404)
    throw new Error('HTTP 404: this server has no /input route (restart npm start)');
  const body = await response.json().catch(() => ({}));
  throw new Error(body.error || 'HTTP ' + response.status);
}

let seq = 0,
  failures = 0,
  inFlight = false;
const started = Date.now();
console.log(`Sending ${fields.join(', ')} at ${rate} Hz to ${url}.`);
console.log('Turn on "Follow live parameters" in the inspector. Ctrl+C to stop.');

setInterval(async () => {
  if (inFlight) return;
  inFlight = true;
  try {
    await send(buildMessage(seq++, (Date.now() - started) / 1000));
    if (failures) console.log('Reconnected.');
    failures = 0;
  } catch (error) {
    if (failures++ % rate === 0) {
      console.warn(
        `Send failed (${error.cause?.code || error.message}). Is \`npm start\` running? Retrying…`,
      );
    }
  } finally {
    inFlight = false;
  }
}, 1000 / rate);
