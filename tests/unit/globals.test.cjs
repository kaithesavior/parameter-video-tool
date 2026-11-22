// The browser scripts share one global scope. A function declared with the same name in two
// files silently replaces the first one (this once emptied the video library list), so
// top-level names must be unique across all scripts the page loads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..', 'public');

function pageScripts() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"?]+)/g)].map(match => match[1]);
}

// Top-level declarations: unindented `function`, `async function`, `const`, `let`, `var`.
function topLevelNames(source) {
  const names = [];
  for (const match of source.matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)/gm))
    names.push(match[1] || match[2]);
  return names;
}

test('every script the page loads exists', () => {
  const scripts = pageScripts();
  assert.ok(scripts.length >= 5);
  for (const script of scripts) assert.ok(fs.existsSync(path.join(root, script)), script);
});

test('browser scripts do not declare the same global name twice', () => {
  const seen = new Map();
  const clashes = [];
  for (const script of pageScripts()) {
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    for (const name of topLevelNames(source)) {
      if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} and ${script}`);
      else seen.set(name, script);
    }
  }
  assert.deepEqual(clashes, []);
});
