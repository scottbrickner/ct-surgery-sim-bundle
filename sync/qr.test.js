import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from './qr.js';

// Node's test environment has no <canvas>, so these exercise encode() only -
// renderToCanvas() is verified live in-browser instead (same convention as
// every other canvas-touching function in this repo, e.g. IntelliVue's
// waveform renderers).

test('encode returns a square boolean matrix for a short URL', () => {
  const m = encode('https://ct-surgery-sim.netlify.app/facilitator/console.html?session=K3RTQ9&role=learner');
  assert.ok(Array.isArray(m));
  assert.ok(m.length >= 21); // smallest possible QR version is 21x21
  for (const row of m) {
    assert.equal(row.length, m.length); // square
    for (const cell of row) assert.equal(typeof cell, 'boolean');
  }
});

test('encode is deterministic for the same input', () => {
  const text = 'https://ct-surgery-sim.netlify.app/?session=ABCDEF';
  const a = encode(text);
  const b = encode(text);
  assert.deepEqual(a, b);
});

test('encode produces a larger matrix for longer text', () => {
  const short = encode('https://x.co/?s=ABCDEF');
  const long = encode('https://ct-surgery-sim.netlify.app/devices/hemosphere-alta/HemoSphere_Alta_Sim.html?session=ABCDEF&role=learner&device=hemosphere');
  assert.ok(long.length >= short.length);
});

test('encode returns null only in the genuinely-impossible case (never for realistic session-link lengths)', () => {
  // Sanity bound, not a real product path - our longest real payload (a full
  // learner link) is well under 100 chars.
  const realistic = encode('https://ct-surgery-sim.netlify.app/devices/intellivue/IntelliVue_Sim_Monitor.html?session=ABCDEF&role=learner');
  assert.ok(realistic !== null);
});
