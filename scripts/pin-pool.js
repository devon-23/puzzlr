/**
 * Carry the live daily pool into a freshly built catalog, before it is swapped in.
 *
 * catalog.db is built wherever build.db lives — a laptop — so finalize can only
 * pin the pool against *that* machine's previous catalog. The server's copy is
 * the one that actually handed puzzles out, so shipping a new catalog without
 * this step reassigns every played puzzle to a different opening song.
 *
 * Usage:  node scripts/pin-pool.js <live-catalog.db> <incoming-catalog.db>
 *
 * Rewrites the incoming file's daily_pool in place. Reads the live one only.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

import { assignDailyPool } from '../pipeline/lib/pool.js';

const MIN_ANSWERS = 3;

const [livePath, incomingPath] = process.argv.slice(2);
if (!livePath || !incomingPath) {
  console.error('usage: node scripts/pin-pool.js <live-catalog.db> <incoming-catalog.db>');
  process.exit(2);
}
for (const p of [livePath, incomingPath]) {
  if (!existsSync(p)) { console.error(`not found: ${p}`); process.exit(2); }
}

const live = new Database(livePath, { readonly: true });
const incoming = new Database(incomingPath);

const previous = new Map(
  live.prepare('SELECT seq, song_id FROM daily_pool').all().map((r) => [r.seq, r.song_id]),
);
const size = previous.size;
if (!size) { console.error('the live catalog has no daily pool to carry over'); process.exit(1); }

// A seat can only be kept if its song can still open a puzzle in the new catalog.
const openers = new Set(incoming.prepare(`
  SELECT DISTINCT o.song_id FROM occurrences o JOIN words w ON w.word = o.end_word
  WHERE w.song_count >= ?`).pluck().all(MIN_ANSWERS * 3));

const eligible = incoming.prepare('SELECT id FROM songs ORDER BY rank DESC, id ASC')
  .pluck().all()
  .filter((id) => openers.has(id))
  .slice(0, size);

const before = new Map(
  incoming.prepare('SELECT seq, song_id FROM daily_pool').all().map((r) => [r.seq, r.song_id]),
);
const pool = assignDailyPool({ previous, eligible, openers, size });

const rows = [...pool].sort((a, b) => a[0] - b[0]);
incoming.transaction(() => {
  incoming.prepare('DELETE FROM daily_pool').run();
  const stmt = incoming.prepare('INSERT INTO daily_pool (seq, song_id) VALUES (?,?)');
  for (const [seq, id] of rows) stmt.run(seq, id);
})();

const held = rows.filter(([seq, id]) => previous.get(seq) === id).length;
const moved = rows.filter(([seq, id]) => before.get(seq) !== id).length;
console.log(`live pool      ${size.toLocaleString()} seats`);
console.log(`carried over   ${held.toLocaleString()}`);
console.log(`reassigned     ${(size - held).toLocaleString()} (song can no longer open a puzzle)`);
console.log(`rewritten      ${moved.toLocaleString()} seats in ${incomingPath}`);

// Spot-check the way the server resolves it: puzzle N opens on seat N % size.
const title = incoming.prepare('SELECT title, artist FROM songs WHERE id=?');
for (const puzzle of [1, 2, 3]) {
  const s = title.get(pool.get(puzzle % size));
  console.log(`  puzzle #${puzzle} opens on  ${s ? `${s.title} — ${s.artist}` : '(missing)'}`);
}
