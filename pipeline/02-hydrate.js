/**
 * Stage 02 — hydrate lyrics from LRCLIB.
 *
 * LRCLIB's /api/search matches title and artist tokens only, never lyric text
 * (verified against a known line from a song it definitely has). So this stage
 * does exact per-track lookups; all lyric *searching* is served later by our own
 * index.
 *
 * ── Handling rule ──────────────────────────────────────────────────────────
 * Lyric text is never logged, never printed, never written anywhere except the
 * transient raw_lyrics table, which stage 05 drops (§02). Progress output is
 * counts only. Do not add a debug line that prints a lyric.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { openBuildDb, setMeta } from './lib/db.js';
import { createLimiter, fetchJson, pool } from './lib/http.js';
import { songKey, contentLines, tokenize } from './lib/normalize.js';

const API = 'https://lrclib.net/api';
const RPS = Number(process.env.LRCLIB_RPS ?? 10);
const CONCURRENCY = Number(process.env.LRCLIB_CONCURRENCY ?? RPS);
const LIMIT = Number(process.env.HYDRATE_LIMIT ?? Infinity);

/** A transcription this thin is a stub, not a song. */
const MIN_TOKENS = 20;
const MIN_CONTENT_LINES = 2;

const db = openBuildDb();
const limiter = createLimiter(RPS);

// ── dedup ────────────────────────────────────────────────────────────────────

function assignDedupKeys() {
  const rows = db.prepare('SELECT id, artist, title FROM songs WHERE dedup_key IS NULL').all();
  if (!rows.length) return 0;
  const upd = db.prepare('UPDATE songs SET dedup_key=? WHERE id=?');
  db.transaction(() => {
    for (const r of rows) upd.run(songKey(r.artist, r.title), r.id);
  })();
  return rows.length;
}

/**
 * Keep the highest-ranked release of each recording; park the rest.
 *
 * Runs are resumable and the seed crawl keeps adding releases, so a recording
 * that is already hydrated must stay the winner — otherwise a later sibling
 * gets fetched too and the same lyrics enter the index twice.
 */
function markDuplicates() {
  const res = db.prepare(`
    UPDATE songs SET lyric_state='duplicate'
    WHERE lyric_state='pending' AND (
      dedup_key IN (SELECT dedup_key FROM songs WHERE lyric_state IN ('ok','instrumental'))
      OR id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY dedup_key ORDER BY rank DESC, id ASC
          ) rn FROM songs WHERE lyric_state='pending'
        ) WHERE rn = 1
      )
    )`).run();
  return res.changes;
}

// ── fetching ─────────────────────────────────────────────────────────────────

const q = (o) => new URLSearchParams(o).toString();

/**
 * Look a track up by artist and title.
 *
 * Deliberately *not* sending duration. LRCLIB matches it strictly and Deezer's
 * figure differs by a second or two across releases, so passing it missed most
 * of the time and cost a second request per song — roughly halving throughput
 * across a 95k-song build. Every release of a recording carries the same
 * lyrics, so picking the "wrong" one costs us nothing.
 */
async function lookup(song) {
  return fetchJson(`${API}/get?${q({ artist_name: song.artist, track_name: song.title })}`, { limiter });
}

/** Decide what a lookup result means for this song. */
function classify(rec) {
  if (!rec) return { state: 'missing', lyrics: null };
  if (rec.instrumental) return { state: 'instrumental', lyrics: null };

  const lyrics = rec.plainLyrics;
  if (!lyrics) return { state: 'missing', lyrics: null };

  const lines = contentLines(lyrics);
  if (lines.length < MIN_CONTENT_LINES) return { state: 'missing', lyrics: null };
  if (tokenize(lyrics).length < MIN_TOKENS) return { state: 'missing', lyrics: null };

  return { state: 'ok', lyrics };
}

// ── main ─────────────────────────────────────────────────────────────────────

const setState = db.prepare('UPDATE songs SET lyric_state=? WHERE id=?');
const putLyrics = db.prepare('INSERT INTO raw_lyrics (song_id, lyrics) VALUES (?,?) ON CONFLICT(song_id) DO UPDATE SET lyrics=excluded.lyrics');

const commit = db.transaction((song, result) => {
  if (result.state === 'ok') putLyrics.run(song.id, result.lyrics);
  setState.run(result.state, song.id);
});

async function main() {
  const keyed = assignDedupKeys();
  if (keyed) console.log(`assigned ${keyed.toLocaleString()} dedup keys`);
  const dupes = markDuplicates();
  if (dupes) console.log(`parked ${dupes.toLocaleString()} duplicate releases`);

  const pending = db
    .prepare(`SELECT id, title, artist, duration FROM songs
              WHERE lyric_state='pending' ORDER BY rank DESC, id ASC
              ${Number.isFinite(LIMIT) ? 'LIMIT ' + LIMIT : ''}`)
    .all();

  console.log(`hydrating ${pending.length.toLocaleString()} songs at ${RPS}/s`);

  const tally = { ok: 0, missing: 0, instrumental: 0 };
  let done = 0;
  const started = Date.now();

  await pool(pending, CONCURRENCY, async (song) => {
    let result;
    try {
      result = classify(await lookup(song));
    } catch {
      result = { state: 'pending', lyrics: null }; // leave for a later run
    }
    if (result.state !== 'pending') {
      commit(song, result);
      tally[result.state]++;
    }
    if (++done % 500 === 0) {
      const mins = (Date.now() - started) / 60000;
      const rate = done / mins;
      const eta = ((pending.length - done) / rate).toFixed(0);
      console.log(
        `  ${done.toLocaleString()}/${pending.length.toLocaleString()}` +
        `  ok ${tally.ok.toLocaleString()}  missing ${tally.missing.toLocaleString()}` +
        `  instr ${tally.instrumental.toLocaleString()}  ~${eta}m left`,
      );
    }
  });

  setMeta(db, 'hydrate_completed_at', new Date().toISOString());
  const hitRate = pending.length ? ((tally.ok / pending.length) * 100).toFixed(1) : '0';
  console.log(`\ndone — ${tally.ok.toLocaleString()} with lyrics (${hitRate}% hit rate)`);
  console.log(`       ${tally.missing.toLocaleString()} missing, ${tally.instrumental.toLocaleString()} instrumental`);
}

main().catch((err) => {
  console.error('hydrate failed:', err.message);
  process.exit(1);
});
