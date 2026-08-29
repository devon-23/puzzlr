/**
 * Stage 03 — the chain graph.
 *
 * The game is a word chain: you are handed a word, you name a song whose lyrics
 * (or title) contain it, and the word that line finishes on is what you carry
 * forward.
 *
 * So every content word of every line is one edge: word → song → end_word.
 *
 * A word is only ever handed off if it can be answered, which is what makes a
 * dead end impossible: `words.song_count` is checked before a word is served.
 *
 * ── Handling rule ──────────────────────────────────────────────────────────
 * Reads raw lyrics; writes word pairs plus a capped run-up fragment so the
 * player can see WHY a link works. See 05-finalize for what that costs.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';

import { openBuildDb, setMeta } from './lib/db.js';
import { wordOccurrences, openingLines, contentLines, WEAK_WORDS } from './lib/normalize.js';

const BATCH = 2000;

/** A word needs this many songs behind it before it is fair to hand over. */
const MIN_ANSWERS = 3;

const db = openBuildDb();

/**
 * Drop releases that aren't really a song for chaining purposes: a megamix
 * splices several songs together, so its lines belong to different works.
 */
const JUNK_TITLE =
  /\b(megamix|medley|continuous mix|karaoke|backing track|tribute|originally performed|made famous by|in the style of)\b/i;

function excludeJunk() {
  const rows = db.prepare("SELECT id, title FROM songs WHERE lyric_state='ok'").all();
  const upd = db.prepare("UPDATE songs SET lyric_state='junk' WHERE id=?");
  let n = 0;
  db.transaction(() => {
    for (const r of rows) if (JUNK_TITLE.test(r.title)) { upd.run(r.id); n++; }
  })();
  return n;
}

/**
 * Drop songs whose lyrics aren't (mostly) English.
 *
 * The chain hands over a single word with no context, so once it lands on a
 * word another language owns, every candidate that can answer it belongs to
 * that language too — the player is silently locked out with no legal move
 * that reads as a bug rather than a language barrier. Cheaper and more honest
 * to keep those lyrics out of the graph than to detect the lock after the fact.
 *
 * WEAK_WORDS (the/of/you/...) are exactly the words a language leans on most,
 * so their share of a song's content words is a serviceable fingerprint
 * without pulling in a language-detection dependency. Calibrated against a
 * sample of the catalog: English songs cluster at 45-55%, Spanish and Korean
 * songs cluster under 15%, and the threshold sits in the gap between them —
 * a few sparse-lyric English songs (mostly instrumental, or repetitive
 * hooks) fall under it too, which just means one fewer valid answer for a
 * word that has thousands; that's a far cheaper mistake than the lockout.
 * Lyrics too short to judge are left alone rather than guessed at.
 */
const ENGLISH_THRESHOLD = 0.20;
const MIN_JUDGEABLE_TOKENS = 20;

function englishShare(lyrics) {
  const toks = contentLines(lyrics).join(' ').split(' ').filter(Boolean);
  if (toks.length < MIN_JUDGEABLE_TOKENS) return null;
  return toks.filter((t) => WEAK_WORDS.has(t)).length / toks.length;
}

function excludeForeign() {
  const page = db.prepare(`SELECT s.id, r.lyrics FROM songs s
                           JOIN raw_lyrics r ON r.song_id = s.id
                           WHERE s.lyric_state='ok' AND s.id > ?
                           ORDER BY s.id LIMIT ?`);
  const upd = db.prepare("UPDATE songs SET lyric_state='foreign' WHERE id=?");
  let lastId = 0;
  let n = 0;
  for (;;) {
    const batch = page.all(lastId, BATCH);
    if (!batch.length) break;
    lastId = batch[batch.length - 1].id;
    db.transaction(() => {
      for (const row of batch) {
        const share = englishShare(row.lyrics);
        if (share !== null && share < ENGLISH_THRESHOLD) { upd.run(row.id); n++; }
      }
    })();
  }
  return n;
}

/**
 * Collapse covers and re-recordings onto one entry. A cover has a different
 * artist so stage 02's artist|title dedup cannot see it, yet its lyrics are
 * identical — chaining through three versions of one song is a dull chain.
 */
function collapseCovers() {
  const page = db.prepare(`SELECT s.id, r.lyrics FROM songs s
                           JOIN raw_lyrics r ON r.song_id = s.id
                           WHERE s.lyric_state='ok' AND s.opening_hash IS NULL AND s.id > ?
                           ORDER BY s.id LIMIT ?`);
  const upd = db.prepare('UPDATE songs SET opening_hash=? WHERE id=?');
  let lastId = 0;
  for (;;) {
    const batch = page.all(lastId, BATCH);
    if (!batch.length) break;
    lastId = batch[batch.length - 1].id;
    db.transaction(() => {
      for (const row of batch) {
        const sig = openingLines(row.lyrics).join('\n');
        upd.run(createHash('sha1').update(sig).digest('hex').slice(0, 16), row.id);
      }
    })();
  }
  return db.prepare(`
    UPDATE songs SET lyric_state='cover'
    WHERE lyric_state='ok' AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY opening_hash ORDER BY rank DESC, id ASC
        ) rn FROM songs WHERE lyric_state='ok'
      ) WHERE rn = 1
    )`).run().changes;
}

const insert = db.prepare(
  'INSERT INTO occurrences (word, song_id, end_word, snippet, clipped) VALUES (?,?,?,?,?)',
);
const writeBatch = db.transaction((rows) => {
  for (const r of rows) insert.run(r.word, r.songId, r.end, r.snippet, r.clipped ? 1 : 0);
});

function buildGraph() {
  db.exec('DELETE FROM occurrences');
  const total = db.prepare("SELECT COUNT(*) c FROM songs WHERE lyric_state='ok'").get().c;
  const page = db.prepare(`SELECT s.id, s.title, r.lyrics FROM songs s
                           JOIN raw_lyrics r ON r.song_id = s.id
                           WHERE s.lyric_state='ok' AND s.id > ?
                           ORDER BY s.id LIMIT ?`);

  let lastId = 0;
  let songs = 0;
  let edges = 0;

  for (;;) {
    const batch = page.all(lastId, BATCH);
    if (!batch.length) break;
    lastId = batch[batch.length - 1].id;

    const rows = [];
    for (const row of batch) {
      // wordOccurrences already collapses repeats, so a chorus recurring twenty
      // times contributes one edge rather than twenty.
      for (const o of wordOccurrences(row.lyrics, row.title)) {
        rows.push({ songId: row.id, ...o });
      }
    }
    writeBatch(rows);
    edges += rows.length;
    songs += batch.length;
    console.log(`  ${songs.toLocaleString()}/${total.toLocaleString()} songs · ${edges.toLocaleString()} links`);
  }
  return { songs, edges };
}

/** Answer counts per word, and the pruning that guarantees solvability. */
function buildWordIndex() {
  db.exec('DELETE FROM words');
  db.exec(`INSERT INTO words (word, song_count)
           SELECT word, COUNT(DISTINCT song_id) FROM occurrences GROUP BY word`);

  // An edge handing over a word nobody can answer is a dead end; drop it so it
  // can never be served.
  const pruned = db.prepare(`
    DELETE FROM occurrences WHERE end_word NOT IN (
      SELECT word FROM words WHERE song_count >= ?
    )`).run(MIN_ANSWERS).changes;

  // Recount now that dead-end edges are gone.
  db.exec('DELETE FROM words');
  db.exec(`INSERT INTO words (word, song_count)
           SELECT word, COUNT(DISTINCT song_id) FROM occurrences GROUP BY word`);

  return pruned;
}

console.log('building the chain graph');
db.exec("UPDATE songs SET lyric_state='ok' WHERE lyric_state IN ('cover','junk','foreign')");
console.log(`  excluded ${excludeJunk().toLocaleString()} megamix / karaoke releases`);
console.log(`  excluded ${excludeForeign().toLocaleString()} non-English songs`);
console.log(`  collapsed ${collapseCovers().toLocaleString()} covers / alternate recordings`);

const { songs, edges } = buildGraph();
const pruned = buildWordIndex();
console.log(`  pruned ${pruned.toLocaleString()} dead-end links`);

const words = db.prepare('SELECT COUNT(*) c FROM words WHERE song_count >= ?').get(MIN_ANSWERS).c;
const live = db.prepare('SELECT COUNT(*) c FROM occurrences').get().c;
const reach = db.prepare('SELECT COUNT(DISTINCT song_id) c FROM occurrences').get().c;

setMeta(db, 'links_built_at', new Date().toISOString());
console.log(`\ndone — ${live.toLocaleString()} links across ${reach.toLocaleString()} songs`);
console.log(`       ${words.toLocaleString()} chainable words (${MIN_ANSWERS}+ answers each)`);
console.log(`       ${(songs - reach).toLocaleString()} songs contribute nothing and are unreachable`);
