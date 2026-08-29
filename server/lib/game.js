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

  search(rawQuery) {
    const tokens = tokenize(rawQuery);
    if (!tokens.length) return { results: [], lyricSearched: false, notice: null };

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
    const lines = this.q.linesFor.all(songId, word);
    if (!lines.length) return { verdict: Verdict.NO_LINE, song, nearMiss: this.nearMiss(word, songId) };

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
   * The one exception to exact matching being invisible: singular/plural is
   * the single most common near miss, so a rejected guess is worth checking
   * for it and saying so. Matching itself stays exact — no equivalence class,
   * just an honest reason when a strike is really just a spelling technicality.
   */
  nearMiss(word, songId) {
    for (const variant of pluralVariants(word)) {
      if (this.q.linesFor.all(songId, variant).length) return variant;
    }
    return null;
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

}
