/**
 * Server-authoritative game logic — the word chain.
 *
 * You are handed a word. You name a song whose lyrics or title contain it
 * ANYWHERE. The word that line finishes on becomes the next link, and the chain
 * runs on.
 *
 * The client never decides what chains: a leaderboard is an incentive to
 * automate, so every rule below is enforced here and nowhere else.
 *
 * Note what this needs from the catalog: word pairs, not lyrics. The shipped
 * file holds word/end_word per line and no line text at all.
 */

import { tokenize } from '../../pipeline/lib/normalize.js';

/** Lyric search needs three words; title search does not. */
export const MIN_LYRIC_TOKENS = 3;
export const MAX_RESULTS = 12;

/** A word is only handed over if this many songs can answer it. */
export const MIN_ANSWERS = 3;

/**
 * How many answers a good word has.
 *
 * Once a word matches anywhere in a song, the commonest words become useless:
 * "back" has 13,827 answers, so literally anything a player types works and
 * there is no game. Very rare words are the opposite failure. Score words by
 * how close they sit to this band, on a log scale, and pick the best rather
 * than the biggest.
 */
export const IDEAL_ANSWERS = 90;
const SIGMA = 0.9;

export function wordScore(answers) {
  if (answers < MIN_ANSWERS) return 0;
  return Math.exp(-0.5 * ((Math.log(answers / IDEAL_ANSWERS) / SIGMA) ** 2));
}

export const Verdict = {
  CHAINED: 'chained',
  NO_LINE: 'no_line',
  ALREADY_USED: 'already_used',
  UNKNOWN_SONG: 'unknown_song',
};

const ftsQuote = (t) => `"${t.replace(/"/g, '""')}"`;

/** English plural/singular shapes worth checking as a near miss, most-likely first. */
function pluralVariants(word) {
  const out = new Set();
  if (word.endsWith('ies') && word.length > 4) out.add(`${word.slice(0, -3)}y`);
  else if (word.endsWith('y') && word.length > 2 && !'aeiou'.includes(word[word.length - 2])) {
    out.add(`${word.slice(0, -1)}ies`);
  }
  if (word.endsWith('es')) out.add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) out.add(word.slice(0, -1));
  out.add(`${word}s`);
  out.add(`${word}es`);
  out.delete(word);
  return [...out];
}

/** A random n-element sample of `arr`, via partial Fisher-Yates. */
function sampleFrom(arr, n) {
  if (arr.length <= n) return arr;
  const copy = [...arr];
  for (let i = copy.length - 1; i > copy.length - 1 - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(copy.length - n);
}

export class Game {
  constructor(db) {
    this.db = db;
    this.q = {
      songById: db.prepare('SELECT id, title, artist, album, artwork, duration FROM songs WHERE id=?'),
      wordCount: db.prepare('SELECT song_count FROM words WHERE word=?'),
      linesFor: db.prepare(
        'SELECT end_word, snippet, clipped FROM occurrences WHERE song_id=? AND word=?',
      ),
      answers: db.prepare(`
        SELECT DISTINCT o.song_id, s.title, s.artist, s.artwork, s.rank
        FROM occurrences o JOIN songs s ON s.id = o.song_id
        WHERE o.word = ? ORDER BY s.rank DESC`),
      titleSearch: db.prepare(`
        SELECT s.id, s.title, s.artist, s.artwork, s.rank
        FROM song_fts f JOIN songs s ON s.id = f.rowid
        WHERE song_fts MATCH ? ORDER BY s.rank DESC LIMIT ?`),
      lyricSearch: db.prepare(`
        SELECT s.id, s.title, s.artist, s.artwork, s.rank
        FROM lyric_fts f JOIN songs s ON s.id = f.rowid
        WHERE lyric_fts MATCH ? ORDER BY s.rank DESC LIMIT ?`),
    };
  }

  getSong(id) {
    return this.q.songById.get(id) ?? null;
  }

  answerCount(word) {
    return this.q.wordCount.get(word)?.song_count ?? 0;
  }

  // ── search ────────────────────────────────────────────────────────────────

  search(rawQuery, currentWord = null) {
    const tokens = tokenize(rawQuery);
    if (!tokens.length) return { results: [], lyricSearched: false, notice: null };

    // Anti-cheat: typing the target word itself (or a trivial plural/singular
    // spelling of it) isn't searching for a song — it's asking the title index
    // to just hand back the answer. Refuse it the same way a too-short lyric
    // search is refused, and say why.
    if (currentWord) {
      const targetForms = new Set([currentWord, ...pluralVariants(currentWord)]);
      if (tokens.every((t) => targetForms.has(t))) {
        return {
          results: [], lyricSearched: false,
          notice: 'That just searches for the word itself — try a song title, artist, or a few words of the lyric.',
        };
      }
    }

    const seen = new Map();
    const add = (rows) => {
      for (const r of rows) {
        if (!seen.has(r.id)) seen.set(r.id, { id: r.id, title: r.title, artist: r.artist, artwork: r.artwork });
      }
    };

    try {
      add(this.q.titleSearch.all(tokens.map((t) => `${ftsQuote(t)}*`).join(' '), MAX_RESULTS));
    } catch { /* malformed FTS expression — no title hits */ }

    let lyricSearched = false;
    let notice = null;
    if (tokens.length >= MIN_LYRIC_TOKENS) {
      lyricSearched = true;
      try {
        add(this.q.lyricSearch.all(tokens.map(ftsQuote).join(' AND '), MAX_RESULTS));
      } catch { /* ignore */ }
    } else {
      notice = `Lyric search needs ${MIN_LYRIC_TOKENS} words — searching titles and artists only.`;
    }

    return { results: [...seen.values()].slice(0, MAX_RESULTS), lyricSearched, notice };
  }

  // ── the chain ─────────────────────────────────────────────────────────────

  /** Songs containing `word` that the player hasn't used. */
  openAnswers(word, usedSongIds = []) {
    const used = new Set(usedSongIds);
    return this.q.answers.all(word).filter((r) => !used.has(r.song_id));
  }

  /**
   * Does `songId` answer `word`, and if so what does the player carry forward?
   *
   * A song usually contains the word in several lines. The one that hands over
   * the most answerable next word is chosen, so a correct guess is never
   * punished with a dead end the player couldn't have seen.
   */
  validate(word, songId, usedSongIds = [], usedWords = []) {
    const song = this.getSong(songId);
    if (!song) return { verdict: Verdict.UNKNOWN_SONG, song: null };
    if (new Set(usedSongIds).has(songId)) return { verdict: Verdict.ALREADY_USED, song };

    const seenWords = new Set(usedWords);

    // Singular/plural is the single most common near miss: the player named a
    // real line, just not in the exact inflection the prompt happened to be
    // in. That's a spelling technicality, not a wrong guess, so accept the
    // closest variant that actually appears rather than strike for it.
    let lines = this.q.linesFor.all(songId, word);
    if (!lines.length) {
      for (const variant of pluralVariants(word)) {
        lines = this.q.linesFor.all(songId, variant);
        if (lines.length) break;
      }
    }
    if (!lines.length) return { verdict: Verdict.NO_LINE, song };

    const ranked = lines
      .map((l) => {
        const answers = this.answerCount(l.end_word);
        return { ...l, answers, score: wordScore(answers) };
      })
      .filter((l) => l.answers >= MIN_ANSWERS && !seenWords.has(l.end_word))
      .sort((a, b) => b.score - a.score);

    // Every continuation is exhausted, but the guess itself was right — still
    // report a fragment, or the last link of a run shows no reason for matching.
    if (!ranked.length) {
      const any = lines.find((l) => l.snippet) ?? lines[0];
      return {
        verdict: Verdict.CHAINED, song, nextWord: null,
        snippet: any?.snippet ?? '', clipped: !!any?.clipped,
      };
    }

    return {
      verdict: Verdict.CHAINED,
      song,
      nextWord: ranked[0].end_word,
      nextAnswers: ranked[0].answers,
      // The run-up that shows why this link works.
      snippet: ranked[0].snippet,
      clipped: !!ranked[0].clipped,
    };
  }

  /**
   * The word a puzzle opens on.
   *
   * Deliberately NOT the banded choice used mid-chain: the first move should be
   * a gift, so nobody loses a strike before they have understood the game.
   *
   * But not the single commonest word either — that picks things like "see"
   * with 23,000 answers, where literally any song works and the opening move
   * teaches nothing. Aim at the easy end of the common band instead.
   */
  openingWord(songId) {
    const EASY_TARGET = 1200;
    const rows = this.db
      .prepare('SELECT DISTINCT end_word FROM occurrences WHERE song_id=?')
      .all(songId)
      .map((r) => ({ word: r.end_word, answers: this.answerCount(r.end_word) }))
      .filter((r) => r.answers >= MIN_ANSWERS);
    if (!rows.length) return null;

    const easy = rows.filter((r) => r.answers >= 400);
    if (!easy.length) return rows.sort((a, b) => b.answers - a.answers)[0];
    return easy.sort(
      (a, b) => Math.abs(a.answers - EASY_TARGET) - Math.abs(b.answers - EASY_TARGET),
    )[0];
  }

  /**
   * Songs that would have answered a word — the end-screen "you could have
   * played these". Ordered by popularity so the list reads as recognisable
   * misses rather than obscure trivia.
   */
  couldHaveUsed(word, usedSongIds = [], limit = 12) {
    return this.openAnswers(word, usedSongIds)
      .slice(0, limit)
      .map((s) => ({ id: s.song_id, title: s.title, artist: s.artist }));
  }

  // ── best-possible-chain search ───────────────────────────────────────────

  /**
   * How long a chain COULD run from a given start, found by search rather
   * than played.
   *
   * "Try every path" is longest-simple-path on a graph with millions of
   * edges — NP-hard and nowhere near tractable in a request. So this runs
   * many short greedy rollouts instead: at each step, sample a handful of
   * songs that answer the current word, and go with whichever keeps the next
   * word most answerable (breaking ties with a little randomness, so repeat
   * rollouts explore different branches rather than retracing one greedy
   * path). Keep the longest rollout found before the time budget runs out.
   *
   * This runs synchronously on the shared request thread (better-sqlite3 is
   * sync), so the budget is kept deliberately short — it's "the best chain
   * found in under a second," never claimed as the provably longest one.
   */
  bestChain(startSongId, startWord, opts = {}) {
    const { timeBudgetMs = 900, sampleSize = 25, lookTop = 5, maxSteps = 400 } = opts;
    const deadline = Date.now() + timeBudgetMs;

    let best = { chain: [], rarity: 0 };
    while (Date.now() < deadline) {
      const rollout = this.#rollout(startSongId, startWord, sampleSize, lookTop, maxSteps, deadline);
      if (rollout.chain.length > best.chain.length ||
          (rollout.chain.length === best.chain.length && rollout.rarity > best.rarity)) {
        best = rollout;
      }
    }
    return { links: best.chain.length, chain: best.chain };
  }

  #rollout(startSongId, startWord, sampleSize, lookTop, maxSteps, deadline) {
    const usedSongs = new Set([startSongId]);
    const usedWords = new Set();
    const chain = [];
    let word = startWord;
    let rarity = 0;

    for (let i = 0; i < maxSteps && Date.now() < deadline; i++) {
      const usedSongsArr = [...usedSongs];
      const pool = sampleFrom(this.openAnswers(word, usedSongsArr), sampleSize);
      if (!pool.length) break;

      const usedWordsArr = [...usedWords];
      const scored = pool
        .map((s) => ({ s, r: this.validate(word, s.song_id, usedSongsArr, usedWordsArr) }))
        .filter((x) => x.r.verdict === Verdict.CHAINED);
      if (!scored.length) break;

      // Alive branches (still have somewhere to go) always beat dead ones;
      // among alive branches, favor whichever next word has the most answers
      // of its own, since that is the one least likely to strand the chain.
      scored.sort((a, b) => {
        const aAlive = a.r.nextWord !== null;
        const bAlive = b.r.nextWord !== null;
        if (aAlive !== bAlive) return aAlive ? -1 : 1;
        return (b.r.nextAnswers ?? 0) - (a.r.nextAnswers ?? 0);
      });
      const pick = scored[Math.floor(Math.random() * Math.min(lookTop, scored.length))];

      const answers = this.answerCount(word);
      chain.push({
        songId: pick.s.song_id, title: pick.s.title, artist: pick.s.artist,
        word, answers, nextWord: pick.r.nextWord, snippet: pick.r.snippet,
      });
      rarity += 1 / Math.max(1, answers);
      usedWords.add(word);
      usedSongs.add(pick.s.song_id);
      if (!pick.r.nextWord) break;
      word = pick.r.nextWord;
    }
    return { chain, rarity };
  }
}
