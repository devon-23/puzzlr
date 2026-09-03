import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { Game, Verdict, MIN_LYRIC_TOKENS, MIN_ANSWERS } from './game.js';

/**
 * A tiny synthetic catalog. Songs and words are invented for this test —
 * real lyrics never appear in this repo (§02).
 *
 * The graph mirrors the game's own example:
 *   alone → (Leave Me Alone) → fun → (Ain't It Fun) → world
 *
 * The word may sit anywhere in a line, which is what lets "people" reach
 * "Treat People With Kindness".
 */
function makeCatalog() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE songs (id INTEGER PRIMARY KEY, deezer_id INTEGER, title TEXT, artist TEXT,
                        album TEXT, artwork TEXT, duration INTEGER, rank INTEGER);
    CREATE TABLE occurrences (word TEXT, song_id INTEGER, end_word TEXT,
                              snippet TEXT DEFAULT '', clipped INTEGER DEFAULT 0);
    CREATE INDEX idx_occ_word ON occurrences(word);
    CREATE TABLE words (word TEXT PRIMARY KEY, song_count INTEGER);
    CREATE VIRTUAL TABLE song_fts USING fts5(title, artist, tokenize='unicode61');
    CREATE VIRTUAL TABLE lyric_fts USING fts5(body, content='', detail='none', tokenize='unicode61');
  `);

  const songs = [
    { id: 1, title: 'Leave Me Alone', artist: 'Kettle Choir', rank: 900 },
    { id: 2, title: 'Second Alone', artist: 'Downpipe', rank: 800 },
    { id: 3, title: 'Third Alone', artist: 'Gutter Choir', rank: 700 },
    { id: 4, title: 'Ladder', artist: 'Roof Party', rank: 600 }, // does not contain "alone"
    { id: 5, title: 'Fourth Alone', artist: 'Kettle Choir', rank: 500 },
    { id: 6, title: 'Funs Anthem', artist: 'Roof Party', rank: 400 }, // has "funs", never "fun"
  ];
  const ins = db.prepare('INSERT INTO songs (id,title,artist,rank) VALUES (?,?,?,?)');
  const fts = db.prepare('INSERT INTO song_fts (rowid,title,artist) VALUES (?,?,?)');
  for (const s of songs) { ins.run(s.id, s.title, s.artist, s.rank); fts.run(s.id, s.title, s.artist); }

  const link = (songId, word, end, snippet = `${word} and then ${end}`) =>
    db.prepare('INSERT INTO occurrences (word,song_id,end_word,snippet) VALUES (?,?,?,?)')
      .run(word, songId, end, snippet);
  // Four songs contain "alone" somewhere.
  link(1, 'alone', 'fun');
  link(1, 'alone', 'dust');   // a second line, leading somewhere thin
  link(2, 'alone', 'fun');
  link(3, 'alone', 'world');
  link(5, 'alone', 'fun');
  // "fun" is answerable; "dust" is a dead end with no answers of its own.
  link(4, 'fun', 'world');
  link(2, 'fun', 'rain');
  link(3, 'fun', 'rain');
  link(5, 'fun', 'world');
  // "world" and "rain" each have enough answers to stay chainable.
  for (const id of [1, 2, 4]) link(id, 'world', 'night');
  for (const id of [1, 3, 5]) link(id, 'rain', 'night');
  for (const id of [2, 3, 4]) link(id, 'night', 'silver');
  link(6, 'funs', 'night'); // near-miss fixture: plural only, singular never appears

  db.exec(`INSERT INTO words (word, song_count)
           SELECT word, COUNT(DISTINCT song_id) FROM occurrences GROUP BY word`);

  const lf = db.prepare('INSERT INTO lyric_fts (rowid, body) VALUES (?,?)');
  lf.run(1, 'the kettle whistles in the empty kitchen');
  lf.run(4, 'counting rungs until the gutter gives way');

  return db;
}

const game = new Game(makeCatalog());

// ── chaining ─────────────────────────────────────────────────────────────────

test('a song containing the word anywhere chains', () => {
  const r = game.validate('alone', 1, [99]);
  assert.equal(r.verdict, Verdict.CHAINED);
  assert.equal(r.nextWord, 'fun', "carries forward that line's last word");
});

test('a song that does not contain the word is refused', () => {
  // Song 4 has lines, but "alone" appears in none of them.
  assert.equal(game.validate('alone', 4, []).verdict, Verdict.NO_LINE);
});

test('a song already in the chain is refused — no looping', () => {
  assert.equal(game.validate('alone', 1, [1]).verdict, Verdict.ALREADY_USED);
});

test('another song by the same artist is allowed', () => {
  // Song 5 shares an artist with song 1 and must still chain.
  assert.equal(game.validate('alone', 5, [1]).verdict, Verdict.CHAINED);
});

test('a plural-only near miss chains instead of striking', () => {
  // Song 6 has "funs" but never the exact prompt word "fun" — that's a
  // spelling technicality, not a wrong guess, so it chains anyway.
  const r = game.validate('fun', 6, []);
  assert.equal(r.verdict, Verdict.CHAINED);
  assert.equal(r.nextWord, 'night');
});

test('an unknown song id is refused rather than crashing', () => {
  assert.equal(game.validate('alone', 999, []).verdict, Verdict.UNKNOWN_SONG);
});

test('the next word is never a dead end', () => {
  // Song 1 offers "fun" (3 answers) and "dust" (none). It must hand over "fun".
  assert.equal(game.validate('alone', 1, []).nextWord, 'fun');
  assert.ok(game.answerCount('dust') < MIN_ANSWERS, 'dust really is a dead end');
});

test('a word already played is never handed over twice', () => {
  // With "fun" spent, song 1's only other continuation is the dead end "dust",
  // so the guess still counts but the chain has nowhere left to go.
  const r = game.validate('alone', 1, [], ['fun']);
  assert.equal(r.verdict, Verdict.CHAINED);
  assert.equal(r.nextWord, null);
});

test('openAnswers lists what is still playable', () => {
  assert.equal(game.openAnswers('alone').length, 4);
  assert.equal(game.openAnswers('alone', [1, 2]).length, 2);
});

test('answerCount reports how many songs can answer a word', () => {
  assert.equal(game.answerCount('alone'), 4);
  assert.equal(game.answerCount('nonsense'), 0);
});

// ── search ───────────────────────────────────────────────────────────────────

test('one-word title search is allowed', () => {
  const r = game.search('ladder');
  assert.equal(r.lyricSearched, false);
  assert.ok(r.results.some((x) => x.id === 4));
  assert.match(r.notice, new RegExp(`${MIN_LYRIC_TOKENS} words`));
});

test('lyric search stays shut below three words', () => {
  const r = game.search('kettle whistles');
  assert.equal(r.lyricSearched, false);
  assert.equal(r.results.length, 0, 'two lyric words must not reach the lyric index');
});

test('lyric search opens at three words', () => {
  const r = game.search('kettle whistles empty');
  assert.equal(r.lyricSearched, true);
  assert.ok(r.results.some((x) => x.id === 1));
});

test('search never returns lyric text', () => {
  const r = game.search('counting rungs gutter');
  assert.ok(r.results.length > 0);
  for (const item of r.results) {
    assert.deepEqual(Object.keys(item).sort(), ['artist', 'artwork', 'id', 'title']);
  }
});

test('a stray quote in the query does not break the FTS expression', () => {
  assert.doesNotThrow(() => game.search('kettle "whistles empty'));
});

test('typing the bare target word does not hand back title matches', () => {
  // Song 1's title is "Leave Me Alone" — searching the current word alone
  // would otherwise be a free way to find every song that answers it.
  const r = game.search('alone', 'alone');
  assert.equal(r.results.length, 0);
  assert.ok(r.notice);
});

test('a plural/singular spelling of the target word is refused the same way', () => {
  const r = game.search('funs', 'fun');
  assert.equal(r.results.length, 0);
});

test('searching a real title still works when it is not the bare target word', () => {
  const r = game.search('ladder', 'alone');
  assert.ok(r.results.some((x) => x.id === 4));
});

// ── the run-up fragment ──────────────────────────────────────────────────────

// ── best-possible-chain search ──────────────────────────────────────────────

test('bestChain finds a valid, non-repeating path from the start', () => {
  const r = game.bestChain(4, 'fun', { timeBudgetMs: 50, sampleSize: 10, lookTop: 3, maxSteps: 20 });
  assert.equal(r.links, r.chain.length);
  assert.ok(r.links >= 1, 'song 4 answering "fun" reaches at least one link');
  assert.equal(r.chain[0].word, 'fun');
  const songIds = r.chain.map((c) => c.songId);
  assert.equal(songIds.length, new Set(songIds).size, 'no song is reused');
  assert.ok(!songIds.includes(4), 'the start song itself is never reused');
});

test('bestChain returns nothing when the start word has no answers left', () => {
  const r = game.bestChain(1, 'nonsense', { timeBudgetMs: 20 });
  assert.deepEqual(r, { links: 0, chain: [] });
});

test('a chained song reports the fragment that made the link', () => {
  const r = game.validate('alone', 2, []);
  assert.equal(r.verdict, Verdict.CHAINED);
  assert.equal(r.snippet, 'alone and then fun');
  assert.ok(r.snippet.endsWith(r.nextWord), 'the fragment ends on the word handed over');
});
