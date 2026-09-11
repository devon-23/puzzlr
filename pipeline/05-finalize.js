/**
 * Stage 05 — emit catalog.db, the read-only artifact the runtime ships with.
 *
 * catalog.db is built from scratch and full lyric text is never copied into it.
 * What crosses over is word pairs plus a capped, normalized run-up fragment of
 * at most six words — enough to show a player why a link works.
 *
 * That fragment is a deliberate loosening of the derived-only rule: the shipped
 * file now holds short lyric excerpts rather than only word pairs. They are
 * lower-cased, stripped of punctuation, disjoint, and never longer than six
 * words, so no line — let alone a song — can be reassembled from them. If the
 * game ever needs a stricter posture, this column is the one thing to drop.
 *
 * ── Why the lyric index is contentless and positionless ────────────────────
 * FTS5's default stores the indexed text, which would put lyrics straight back
 * into the shipped file. `content=''` drops the stored text, but the inverted
 * index still keeps term positions — enough, in principle, to reconstruct
 * lines. `detail='none'` drops positions too, leaving only "this song contains
 * this term". Lyric search then matches all terms rather than an exact phrase,
 * which is both more forgiving for a player typing from memory and impossible
 * to run backwards into a lyric.
 * ───────────────────────────────────────────────────────────────────────────
 */

import Database from 'better-sqlite3';
import { existsSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { openBuildDb } from './lib/db.js';
import { contentLines, OPENING_LINE_COUNT } from './lib/normalize.js';
import { assignDailyPool } from './lib/pool.js';

const OUT = resolve('data/catalog.db');
const PURGE = process.env.PURGE === '1';
const MIN_ANSWERS = 3;

const build = openBuildDb();

// Read the seats the last build handed out before the file is replaced —
// they have to survive into the new catalog or every played puzzle silently
// becomes a different game. See assignDailyPool.
const previousPool = new Map();
if (existsSync(OUT)) {
  const old = new Database(OUT, { readonly: true });
  try {
    for (const r of old.prepare('SELECT seq, song_id FROM daily_pool').all()) {
      previousPool.set(r.seq, r.song_id);
    }
  } catch { /* a catalog from before the pool existed */ }
  old.close();
  unlinkSync(OUT);
}

const cat = new Database(OUT);

cat.exec(`
PRAGMA journal_mode = DELETE;

CREATE TABLE songs (
  id        INTEGER PRIMARY KEY,
  deezer_id INTEGER,
  title     TEXT NOT NULL,
  artist    TEXT NOT NULL,
  album     TEXT,
  artwork   TEXT,
  duration  INTEGER,
  rank      INTEGER
);
CREATE INDEX idx_songs_rank ON songs(rank DESC);

CREATE TABLE occurrences (
  word     TEXT NOT NULL,
  song_id  INTEGER NOT NULL,
  end_word TEXT NOT NULL,
  snippet  TEXT NOT NULL,
  clipped  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_occ_word ON occurrences(word);
CREATE INDEX idx_occ_pair ON occurrences(word, song_id);

CREATE TABLE words (word TEXT PRIMARY KEY, song_count INTEGER NOT NULL);

-- Titles and artists are metadata; storing and displaying them is fine.
CREATE VIRTUAL TABLE song_fts USING fts5(title, artist, tokenize='unicode61');

-- Lyrics are not. Contentless and positionless: matchable, never readable.
CREATE VIRTUAL TABLE lyric_fts USING fts5(body, content='', detail='none', tokenize='unicode61');

-- The daily start pool, frozen at build time so a rebuild can't reshuffle
-- every past puzzle.
CREATE TABLE daily_pool (seq INTEGER PRIMARY KEY, song_id INTEGER NOT NULL);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Streamed rather than `.all()`'d: the occurrences table runs into the
// millions of rows, and materializing all of them into one JS array at once
// blows the heap. `.iterate()` pulls rows from SQLite lazily; batching the
// inserts keeps the transactions fast without holding more than one batch
// in memory at a time.
const COPY_BATCH = 5000;
const copy = (label, selectSql, insertSql) => {
  const stmt = cat.prepare(insertSql);
  const insertBatch = cat.transaction((rows) => { for (const r of rows) stmt.run(r); });
  let n = 0;
  let batch = [];
  for (const r of build.prepare(selectSql).iterate()) {
    batch.push(r);
    if (batch.length >= COPY_BATCH) { insertBatch(batch); n += batch.length; batch = []; }
  }
  if (batch.length) { insertBatch(batch); n += batch.length; }
  console.log(`  ${label.padEnd(11)} ${n.toLocaleString()}`);
  return n;
};

console.log('building catalog.db');

copy('songs',
  `SELECT id, deezer_id, title, artist, album, artwork, duration, rank
   FROM songs WHERE lyric_state='ok'`,
  `INSERT INTO songs (id,deezer_id,title,artist,album,artwork,duration,rank)
   VALUES (@id,@deezer_id,@title,@artist,@album,@artwork,@duration,@rank)`);

copy('occurrences',
  `SELECT o.word, o.song_id, o.end_word, o.snippet, o.clipped
   FROM occurrences o JOIN songs s ON s.id=o.song_id WHERE s.lyric_state='ok'`,
  `INSERT INTO occurrences (word,song_id,end_word,snippet,clipped)
   VALUES (@word,@song_id,@end_word,@snippet,@clipped)`);

// Recount against the songs that actually shipped.
cat.exec(`INSERT INTO words (word, song_count)
          SELECT word, COUNT(DISTINCT song_id) FROM occurrences GROUP BY word`);
console.log(`  words       ${cat.prepare('SELECT COUNT(*) c FROM words').get().c.toLocaleString()}`);

{
  const rows = cat.prepare('SELECT id, title, artist FROM songs').all();
  const stmt = cat.prepare('INSERT INTO song_fts (rowid,title,artist) VALUES (?,?,?)');
  cat.transaction(() => { for (const r of rows) stmt.run(r.id, r.title, r.artist); })();
  console.log(`  song_fts    ${rows.length.toLocaleString()}`);
}

// Lyric search index — everything EXCEPT the opening region, so search can
// never simply hand over a song the player was asked to recall.
{
  const stmt = cat.prepare('INSERT INTO lyric_fts (rowid, body) VALUES (?,?)');
  const page = build.prepare(`SELECT s.id, r.lyrics FROM songs s JOIN raw_lyrics r ON r.song_id=s.id
                              WHERE s.lyric_state='ok' AND s.id > ? ORDER BY s.id LIMIT ?`);
  const insertMany = cat.transaction((batch) => { for (const b of batch) stmt.run(b.id, b.body); });

  let lastId = 0, n = 0, skipped = 0;
  for (;;) {
    const rows = page.all(lastId, 5000);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    const batch = [];
    for (const row of rows) {
      const body = contentLines(row.lyrics).slice(OPENING_LINE_COUNT).join(' ');
      if (!body) { skipped++; continue; }
      batch.push({ id: row.id, body });
      n++;
    }
    if (batch.length) insertMany(batch);
  }
  console.log(`  lyric_fts   ${n.toLocaleString()} (${skipped.toLocaleString()} too short)`);
}

// Daily starts: well-known songs that hand over a word with room to move.
{
  const POOL_SIZE = 5000;

  // Every song that can open a puzzle, gathered in one pass. The per-song
  // EXISTS this replaces had no index to use for song_id, so it rescanned the
  // whole occurrences table for each candidate.
  const openers = new Set(cat.prepare(`
    SELECT DISTINCT o.song_id FROM occurrences o JOIN words w ON w.word = o.end_word
    WHERE w.song_count >= ?`).pluck().all(MIN_ANSWERS * 3));

  const eligible = cat.prepare('SELECT id FROM songs ORDER BY rank DESC, id ASC')
    .pluck().all()
    .filter((id) => openers.has(id))
    .slice(0, POOL_SIZE);

  let seed = 0x9e3779b9;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  const pool = assignDailyPool({ previous: previousPool, eligible, openers, size: POOL_SIZE });
  const rows = [...pool].sort((a, b) => a[0] - b[0]);
  const held = rows.filter(([seq, id]) => previousPool.get(seq) === id).length;

  const stmt = cat.prepare('INSERT INTO daily_pool (seq, song_id) VALUES (?,?)');
  cat.transaction(() => { for (const [seq, id] of rows) stmt.run(seq, id); })();
  console.log(`  daily_pool  ${rows.length.toLocaleString()} (${held.toLocaleString()} held from the previous build)`);
}

const setMeta = cat.prepare('INSERT INTO meta(key,value) VALUES(?,?)');
cat.transaction(() => {
  setMeta.run('built_at', new Date().toISOString());
  setMeta.run('song_count', String(cat.prepare('SELECT COUNT(*) c FROM songs').get().c));
  setMeta.run('min_answers', String(MIN_ANSWERS));
})();

cat.exec('VACUUM');
cat.close();

console.log(`\ncatalog.db written — ${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);
console.log('lyric exposure: word pairs plus normalized fragments of <= 6 words.');

if (PURGE) {
  build.exec('DELETE FROM raw_lyrics');
  build.exec('VACUUM');
  console.log('raw_lyrics purged from build.db');
} else {
  console.log('build.db still holds raw lyrics for rebuilds — run with PURGE=1 to destroy them.');
}
