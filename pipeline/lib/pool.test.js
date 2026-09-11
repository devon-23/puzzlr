import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignDailyPool } from './pool.js';

const openersOf = (...ids) => new Set(ids);

test('a fresh pool is filled from the eligible order', () => {
  const pool = assignDailyPool({
    eligible: [10, 20, 30], openers: openersOf(10, 20, 30), size: 5,
  });
  assert.deepEqual([...pool], [[0, 10], [1, 20], [2, 30]]);
});

test('seats already handed out survive a rebuild untouched', () => {
  // The whole point: puzzle 1 opened on song 10 once, so it opens on song 10
  // forever, even though the rebuild would rank song 99 into that seat.
  const pool = assignDailyPool({
    previous: new Map([[0, 10], [1, 20]]),
    eligible: [99, 98, 97],
    openers: openersOf(10, 20, 99, 98, 97),
    size: 5,
  });
  assert.equal(pool.get(0), 10);
  assert.equal(pool.get(1), 20);
});

test('new songs fill only the seats nobody has played', () => {
  const pool = assignDailyPool({
    previous: new Map([[0, 10]]),
    eligible: [99, 98],
    openers: openersOf(10, 99, 98),
    size: 3,
  });
  assert.deepEqual([...pool].sort((a, b) => a[0] - b[0]), [[0, 10], [1, 99], [2, 98]]);
});

test('a seat is refilled when its song can no longer open a puzzle', () => {
  // Song 20 lost its last playable handoff, so that seat has to be reassigned
  // — leaving it empty would strand the puzzle with no start song at all.
  const pool = assignDailyPool({
    previous: new Map([[0, 10], [1, 20]]),
    eligible: [99],
    openers: openersOf(10, 99),
    size: 3,
  });
  assert.equal(pool.get(0), 10);
  assert.equal(pool.get(1), 99, 'the dropped song is replaced');
});

test('a song never takes two seats', () => {
  const pool = assignDailyPool({
    previous: new Map([[0, 10]]),
    eligible: [10, 20],
    openers: openersOf(10, 20),
    size: 4,
  });
  assert.deepEqual([...pool].sort((a, b) => a[0] - b[0]), [[0, 10], [1, 20]]);
});

test('seats outside the pool are dropped rather than carried over', () => {
  const pool = assignDailyPool({
    previous: new Map([[0, 10], [9, 20]]),
    eligible: [30],
    openers: openersOf(10, 20, 30),
    size: 2,
  });
  assert.deepEqual([...pool].sort((a, b) => a[0] - b[0]), [[0, 10], [1, 30]]);
});
