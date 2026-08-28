/**
 * The write store — everything the read-only catalog can't hold.
 *
 * Kept deliberately separate from catalog.db: that file is immutable and shipped
 * in CI, this one is small-row and write-heavy. When the leaderboard needs to be
 * transactional across instances, this is the database that moves to Postgres;
 * the catalog does not move.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PLAYERS_DB = resolve('data/players.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  display_name  TEXT,
  puzzle        INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'active',   -- active | finished
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  undos         INTEGER NOT NULL DEFAULT 0,
  strikes       INTEGER NOT NULL DEFAULT 0,
  links         INTEGER NOT NULL DEFAULT 0,
  rarity_score  REAL NOT NULL DEFAULT 0,
  current_song  INTEGER,
  current_word  TEXT,
  UNIQUE(device_id, puzzle)
);
CREATE INDEX IF NOT EXISTS idx_sessions_board
  ON sessions(puzzle, links DESC, undos ASC, finished_at ASC);

CREATE TABLE IF NOT EXISTS chain_steps (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  song_id        INTEGER NOT NULL,
  word           TEXT,            -- the word this song was reached BY
  snippet        TEXT,            -- the run-up that made the link
  next_word      TEXT,            -- the word it handed over
  solution_count INTEGER,
  PRIMARY KEY (session_id, position)
);


/* "How many others chained this" — populated as chains are built. */
CREATE TABLE IF NOT EXISTS song_daily_counts (
  puzzle  INTEGER NOT NULL,
  song_id INTEGER NOT NULL,
  plays   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (puzzle, song_id)
);
`;

export function openPlayersDb(path = PLAYERS_DB) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

/**
 * Puzzle numbering. Local-date based, so nobody gets a 5pm reset.
 *
 * The epoch is the day BEFORE launch, so launch day is Chain #1. Set
 * PUZZLE_EPOCH=YYYY-MM-DD to the real launch-day-minus-one before going live;
 * changing it afterwards renumbers every past puzzle.
 */
export const PUZZLE_EPOCH = (() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(process.env.PUZZLE_EPOCH ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.UTC(2026, 7, 27);
})();

export function puzzleNumberFor(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr ?? '');
  if (!m) return null;
  const ts = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(ts)) return null;
  return Math.floor((ts - PUZZLE_EPOCH) / 86400000);
}

/**
 * The client reports its own local date, which is the only way to give every
 * timezone a midnight reset. Clamp it to ±1 day of UTC so nobody can farm the
 * archive by lying about the date.
 */
export function resolvePuzzle(clientDate) {
  const today = Math.floor((Date.now() - PUZZLE_EPOCH) / 86400000);
  const claimed = puzzleNumberFor(clientDate);
  // Never below #1: the epoch is launch-day-minus-one, so 0 means "before launch".
  if (claimed === null) return Math.max(1, today);
  return Math.max(1, Math.min(Math.max(claimed, today - 1), today + 1));
}
