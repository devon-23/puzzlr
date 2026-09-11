/**
 * Which song opens which puzzle.
 *
 * Puzzle N opens on daily_pool[N % size], so a seat that changes hands
 * rewrites a puzzle people have already played: their leaderboard row then
 * describes a different game than the one that number now names, and an
 * archive replay of that date is no longer the puzzle anyone competed on.
 *
 * The pool is therefore append-only across rebuilds. A seat that is already
 * taken keeps its song; a rebuild may only fill seats that are empty, or
 * whose song can no longer open a puzzle at all (dropped from the catalog,
 * or left with no handoff worth playing).
 */
export function assignDailyPool({ previous = new Map(), eligible = [], openers, size }) {
  const pool = new Map();
  const taken = new Set();

  for (const [seq, songId] of previous) {
    if (!Number.isInteger(seq) || seq < 0 || seq >= size) continue;
    if (taken.has(songId) || !openers.has(songId)) continue;
    pool.set(seq, songId);
    taken.add(songId);
  }

  const fill = eligible.filter((id) => !taken.has(id));
  let next = 0;
  for (let seq = 0; seq < size && next < fill.length; seq++) {
    if (!pool.has(seq)) pool.set(seq, fill[next++]);
  }

  return pool;
}
