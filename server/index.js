/**
 * Puzzlr API — server-authoritative.
 *
 * The chain runs on single words: you are handed one, you name a song whose
 * lyrics or title contain it anywhere, and the word that line finishes on is
 * what you carry forward. Three wrong answers end the run.
 *
 * Chain state lives here, never on the client. A leaderboard is an incentive to
 * automate, so validation and word selection happen server-side and the client
 * is only ever told the outcome.
 */

import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Game, Verdict, MIN_LYRIC_TOKENS } from './lib/game.js';
import { openPlayersDb, resolvePuzzle, puzzleNumberFor, todayPuzzle, dateForPuzzle } from './lib/players.js';
import { buildShare, rarityOf } from './lib/share.js';

const CATALOG = resolve('data/catalog.db');
const PORT = Number(process.env.PORT ?? 3000);
const MAX_STRIKES = 3;
const MAX_UNDOS = 3;
const SEARCH_PER_MIN = 60;

if (!existsSync(CATALOG)) {
  console.error(`catalog.db not found at ${CATALOG}\nRun: npm run seed && npm run hydrate && npm run build:catalog`);
  process.exit(1);
}

const catalog = new Database(CATALOG, { readonly: true });
const game = new Game(catalog);
const players = openPlayersDb();

const app = express();
app.use(express.json({ limit: '16kb' }));

const poolSize = catalog.prepare('SELECT COUNT(*) c FROM daily_pool').get().c;
const startFor = catalog.prepare('SELECT song_id FROM daily_pool WHERE seq=?');

const S = {
  byId: players.prepare('SELECT * FROM sessions WHERE id=?'),
  byDevice: players.prepare('SELECT * FROM sessions WHERE device_id=? AND puzzle=?'),
  create: players.prepare(`INSERT INTO sessions (id,device_id,display_name,puzzle,started_at,current_song,current_word,archive)
                           VALUES (?,?,?,?,?,?,?,?)`),
  setCurrent: players.prepare('UPDATE sessions SET current_song=?, current_word=? WHERE id=?'),
  finish: players.prepare("UPDATE sessions SET state='finished', finished_at=? WHERE id=?"),
  bump: players.prepare('UPDATE sessions SET links=?, rarity_score=? WHERE id=?'),
  addStrike: players.prepare('UPDATE sessions SET strikes=strikes+1 WHERE id=?'),
  addUndo: players.prepare('UPDATE sessions SET undos=undos+1 WHERE id=?'),
  steps: players.prepare('SELECT * FROM chain_steps WHERE session_id=? ORDER BY position'),
  addStep: players.prepare(`INSERT INTO chain_steps
    (session_id,position,song_id,word,snippet,next_word,solution_count) VALUES (?,?,?,?,?,?,?)`),
  dropStep: players.prepare('DELETE FROM chain_steps WHERE session_id=? AND position=?'),
  countPlay: players.prepare(`INSERT INTO song_daily_counts (puzzle,song_id,plays) VALUES (?,?,1)
                              ON CONFLICT(puzzle,song_id) DO UPDATE SET plays=plays+1`),
  playsFor: players.prepare('SELECT plays FROM song_daily_counts WHERE puzzle=? AND song_id=?'),
  // The daily boards count only same-day runs — see the `archive` column.
  playersOn: players.prepare("SELECT COUNT(*) c FROM sessions WHERE puzzle=? AND state='finished' AND archive=0"),
  board: players.prepare(`SELECT display_name, links, strikes, finished_at FROM sessions
                          WHERE puzzle=? AND state='finished' AND archive=0
                          ORDER BY links DESC, strikes ASC, finished_at ASC LIMIT ?`),
};

const usedIdsOf = (sid) => S.steps.all(sid).map((s) => s.song_id);
const usedWordsOf = (sid) => S.steps.all(sid).map((s) => s.word).filter(Boolean);

function chainView(sid) {
  return S.steps.all(sid).map((s) => {
    const song = game.getSong(s.song_id);
    return {
      position: s.position,
      songId: s.song_id,
      title: song?.title,
      artist: song?.artist,
      artwork: song?.artwork,
      word: s.word,
      snippet: s.snippet,
      nextWord: s.next_word,
      answers: s.solution_count,
    };
  });
}

function stateOf(sess) {
  return {
    sessionId: sess.id,
    puzzle: sess.puzzle,
    puzzleDate: dateForPuzzle(sess.puzzle),
    archive: !!sess.archive,
    state: sess.state,
    chain: chainView(sess.id),
    links: sess.links,
    strikes: sess.strikes,
    strikesLeft: Math.max(0, MAX_STRIKES - sess.strikes),
    undos: sess.undos,
    undosLeft: Math.max(0, MAX_UNDOS - sess.undos),
    word: sess.current_word,
    answers: sess.current_word ? game.answerCount(sess.current_word) : 0,
  };
}

const rate = new Map();
function rateLimited(key) {
  const now = Date.now();
  const b = rate.get(key);
  if (!b || now > b.resetAt) { rate.set(key, { n: 1, resetAt: now + 60000 }); return false; }
  return ++b.n > SEARCH_PER_MIN;
}

// ── routes ───────────────────────────────────────────────────────────────────

app.post('/api/session', (req, res) => {
  const { deviceId, localDate, displayName, archiveDate } = req.body ?? {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const today = resolvePuzzle(localDate);

  // With no archiveDate this is the ordinary daily run. With one, the player is
  // deliberately reaching back, which is allowed for any past puzzle but never
  // for today's or a future one — that would just be a second attempt.
  let puzzle = today;
  let archive = 0;
  if (archiveDate != null) {
    const n = puzzleNumberFor(archiveDate);
    if (n === null) return res.status(400).json({ error: 'archiveDate must be YYYY-MM-DD' });
    if (n < 1 || n >= today) return res.status(400).json({ error: 'the archive holds past puzzles only' });
    puzzle = n;
    archive = 1;
  }

  // One run per puzzle per device, archive included: replaying a past puzzle
  // until it goes well would make the score meaningless.
  const existing = S.byDevice.get(deviceId, puzzle);
  if (existing) return res.json(stateOf(existing));

  if (!poolSize) return res.status(503).json({ error: 'catalog has no daily pool' });
  const startSong = startFor.get(((puzzle % poolSize) + poolSize) % poolSize)?.song_id;
  const opening = startSong ? game.openingWord(startSong) : null;
  if (!opening) return res.status(503).json({ error: 'no start song for this puzzle' });

  const id = randomUUID();
  players.transaction(() => {
    S.create.run(id, deviceId, displayName ?? null, puzzle, Date.now(), startSong, opening.word, archive);
    S.addStep.run(id, 0, startSong, null, null, opening.word, null);
  })();

  res.json(stateOf(S.byId.get(id)));
});

/**
 * What the archive covers: every puzzle from #1 up to yesterday, plus which of
 * them this device has already played, so the picker can show them as done.
 */
app.get('/api/archive', (req, res) => {
  const device = String(req.query.deviceId ?? '');
  const today = todayPuzzle();
  const played = device
    ? players.prepare("SELECT puzzle, links, state FROM sessions WHERE device_id=? AND puzzle < ?")
        .all(device, today)
        .map((r) => ({ puzzle: r.puzzle, date: dateForPuzzle(r.puzzle), links: r.links, finished: r.state === 'finished' }))
    : [];
  res.json({
    first: { puzzle: 1, date: dateForPuzzle(1) },
    last: { puzzle: today - 1, date: dateForPuzzle(today - 1) },
    played,
  });
});

app.post('/api/search', (req, res) => {
  const { sessionId, q } = req.body ?? {};
  const sess = S.byId.get(sessionId ?? '');
  if (!sess) return res.status(404).json({ error: 'no such session' });
  if (rateLimited(sess.device_id)) return res.status(429).json({ error: 'slow down' });

  const { results, lyricSearched, notice } = game.search(q ?? '');
  res.json({ results, lyricSearched, notice, minLyricTokens: MIN_LYRIC_TOKENS });
});

app.post('/api/chain', (req, res) => {
  const { sessionId, songId } = req.body ?? {};
  const sess = S.byId.get(sessionId ?? '');
  if (!sess) return res.status(404).json({ error: 'no such session' });
  if (sess.state !== 'active') return res.status(409).json({ error: 'this chain is finished' });
  if (!sess.current_word) return res.status(409).json({ error: 'no word in play' });

  const used = usedIdsOf(sess.id);
  const seenWords = usedWordsOf(sess.id);
  const result = game.validate(sess.current_word, Number(songId), used, seenWords);

  if (result.verdict !== Verdict.CHAINED) {
    S.addStrike.run(sess.id);
    const out = S.byId.get(sess.id).strikes >= MAX_STRIKES;
    if (out) S.finish.run(Date.now(), sess.id);
    return res.json({
      ok: false,
      verdict: result.verdict,
      song: result.song && { title: result.song.title, artist: result.song.artist },
      ...stateOf(S.byId.get(sess.id)),
      eliminated: out,
    });
  }

  const answers = game.answerCount(sess.current_word);
  const links = sess.links + 1;
  const rarity = sess.rarity_score + 1 / Math.max(1, answers);

  players.transaction(() => {
    S.addStep.run(sess.id, used.length, result.song.id, sess.current_word,
                  result.snippet ?? null, result.nextWord, answers);
    S.bump.run(links, rarity, sess.id);
    // "How many others chained this" describes that day's players, so a much
    // later archive run must not add itself to the tally.
    if (!sess.archive) S.countPlay.run(sess.puzzle, result.song.id);
    S.setCurrent.run(result.song.id, result.nextWord, sess.id);
  })();

  res.json({
    ok: true,
    verdict: result.verdict,
    ...stateOf(S.byId.get(sess.id)),
    exhausted: result.nextWord === null,
  });
});

app.post('/api/undo', (req, res) => {
  const { sessionId } = req.body ?? {};
  const sess = S.byId.get(sessionId ?? '');
  if (!sess) return res.status(404).json({ error: 'no such session' });
  if (sess.state !== 'active') return res.status(409).json({ error: 'this chain is finished' });
  if (sess.undos >= MAX_UNDOS) return res.status(409).json({ error: 'no undos left' });

  const steps = S.steps.all(sess.id);
  if (steps.length < 2) return res.status(409).json({ error: 'nothing to undo' });

  const last = steps[steps.length - 1];
  const prev = steps[steps.length - 2];

  players.transaction(() => {
    S.dropStep.run(sess.id, last.position);
    S.addUndo.run(sess.id);
    S.bump.run(sess.links - 1, Math.max(0, sess.rarity_score - 1 / Math.max(1, last.solution_count ?? 1)), sess.id);
    // Put the word that led here back in play — the player is retrying it.
    S.setCurrent.run(prev.song_id, last.word, sess.id);
  })();

  res.json(stateOf(S.byId.get(sess.id)));
});

app.post('/api/giveup', (req, res) => {
  const { sessionId } = req.body ?? {};
  const sess = S.byId.get(sessionId ?? '');
  if (!sess) return res.status(404).json({ error: 'no such session' });
  if (sess.state === 'finished') return res.json(resultOf(sess));
  S.finish.run(Date.now(), sess.id);
  res.json(resultOf(S.byId.get(sess.id)));
});

function resultOf(sess) {
  const steps = S.steps.all(sess.id).filter((s) => s.word);
  const links = steps.map((s) => ({ handoff: s.word, solution_count: s.solution_count ?? 1 }));
  const share = buildShare({ puzzle: sess.puzzle, links, undos: sess.undos, strikes: sess.strikes });

  const finished = S.playersOn.get(sess.puzzle).c;
  const detail = steps.map((s) => {
    const song = game.getSong(s.song_id);
    return {
      title: song?.title,
      artist: song?.artist,
      word: s.word,
      snippet: s.snippet,
      nextWord: s.next_word,
      solutionCount: s.solution_count,
      rarity: rarityOf(s.solution_count ?? 1).name,
      // Player-relative rarity is noise until there is volume; catalog rarity
      // carries the stats screen from day one.
      alsoChosenBy: finished >= 30 ? (S.playsFor.get(sess.puzzle, s.song_id)?.plays ?? 1) : null,
    };
  });

  // Ranked against that day's players only; an archive run is scored for the
  // player's own sake but never placed among them.
  const rank = sess.archive ? null : players
    .prepare(`SELECT COUNT(*)+1 r FROM sessions WHERE puzzle=? AND state='finished' AND archive=0
              AND (links > ? OR (links = ? AND strikes < ?))`)
    .get(sess.puzzle, sess.links, sess.links, sess.strikes).r;

  return {
    puzzle: sess.puzzle,
    puzzleDate: dateForPuzzle(sess.puzzle),
    archive: !!sess.archive,
    links: sess.links,
    strikes: sess.strikes,
    undos: sess.undos,
    durationMs: (sess.finished_at ?? Date.now()) - sess.started_at,
    rank,
    playersFinished: finished,
    detail,
    share,
    // What was still on the table when the run ended.
    couldHaveUsed: (() => {
      const word = sess.current_word ?? steps[steps.length - 1]?.word ?? null;
      if (!word) return null;
      const songs = game.couldHaveUsed(word, S.steps.all(sess.id).map((s) => s.song_id));
      return songs.length ? { word, answers: game.answerCount(word), songs } : null;
    })(),
  };
}

app.get('/api/leaderboard', (req, res) => {
  const puzzle = Number(req.query.puzzle);
  if (!Number.isFinite(puzzle)) return res.status(400).json({ error: 'puzzle required' });
  res.json({
    puzzle,
    entries: S.board.all(puzzle, 100).map((e, i) => ({
      rank: i + 1,
      name: e.display_name ?? 'anonymous',
      links: e.links,
      strikes: e.strikes,
    })),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    songs: catalog.prepare('SELECT COUNT(*) c FROM songs').get().c,
    links: catalog.prepare('SELECT COUNT(*) c FROM occurrences').get().c,
    words: catalog.prepare('SELECT COUNT(*) c FROM words').get().c,
    dailyPool: poolSize,
  });
});

// In dev, Vite serves the frontend and proxies /api here. In production
// there's no separate frontend server, so this process serves the built
// bundle too — one process, one port. No client-side router, so any
// unmatched GET just falls back to index.html.
const STATIC_DIR = resolve('dist');
if (existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.use((_req, res) => res.sendFile(resolve(STATIC_DIR, 'index.html')));
}

app.listen(PORT, () => console.log(`puzzlr api on :${PORT}`));
