import test from 'node:test';
import assert from 'node:assert/strict';
import { isRecentlyActive } from './presence.js';

test('isRecentlyActive is false when nothing has been seen yet', () => {
  assert.equal(isRecentlyActive(null, 1000), false);
  assert.equal(isRecentlyActive(undefined, 1000), false);
});

test('isRecentlyActive is true just under the staleness window', () => {
  assert.equal(isRecentlyActive(1000, 1000 + 2199, 2200), true);
});

test('isRecentlyActive is false once the staleness window has elapsed', () => {
  assert.equal(isRecentlyActive(1000, 1000 + 2200, 2200), false);
  assert.equal(isRecentlyActive(1000, 1000 + 5000, 2200), false);
});

test('isRecentlyActive respects a custom staleMs override', () => {
  assert.equal(isRecentlyActive(1000, 1500, 1000), true);
  assert.equal(isRecentlyActive(1000, 2500, 1000), false);
});

test('isRecentlyActive treats "just seen" (0ms elapsed) as active', () => {
  assert.equal(isRecentlyActive(5000, 5000), true);
});
