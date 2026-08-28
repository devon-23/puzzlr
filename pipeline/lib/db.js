import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const BUILD_DB = resolve('data/build.db');

/**
 * The build database.
 *
 * `raw_lyrics` is the only table that ever holds full lyric text, and it is
 * dropped by the finalize stage before catalog.db is emitted (§02). Nothing
 * downstream of the graph build may read from it.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS artists (
  deezer_id   INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  picture     TEXT,
  crawled     INTEGER NOT NULL DEFAULT 0,   -- top-tracks fetched
  expanded    INTEGER NOT NULL DEFAULT 0,   -- related-artists fetched
  depth       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_artists_crawled  ON artists(crawled);
CREATE INDEX IF NOT EXISTS idx_artists_expanded ON artists(expanded, depth);

CREATE TABLE IF NOT EXISTS songs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  deezer_id   INTEGER UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  artist_id   INTEGER,
  album       TEXT,
  artwork     TEXT,
  duration    INTEGER,
  rank        INTEGER,                       -- Deezer popularity
  lyric_state TEXT NOT NULL DEFAULT 'pending' -- pending | ok | missing | instrumental
);
CREATE INDEX IF NOT EXISTS idx_songs_state ON songs(lyric_state);
CREATE INDEX IF NOT EXISTS idx_songs_rank  ON songs(rank DESC);

-- TRANSIENT. Dropped at finalize. Never read by the runtime.
CREATE TABLE IF NOT EXISTS raw_lyrics (
  song_id     INTEGER PRIMARY KEY REFERENCES songs(id),
  lyrics      TEXT NOT NULL
);

-- The chain graph. A player handed a word may answer with song_id, and then
-- carries end_word forward. The word may sit anywhere in the line it came from.
CREATE TABLE IF NOT EXISTS occurrences (
  word     TEXT NOT NULL,
  song_id  INTEGER NOT NULL REFERENCES songs(id),
  end_word TEXT NOT NULL,
  snippet  TEXT NOT NULL DEFAULT '',
  clipped  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_occ_word ON occurrences(word);
CREATE INDEX IF NOT EXISTS idx_occ_pair ON occurrences(word, song_id);

-- How many songs can answer each word — solvability, difficulty and rarity.
CREATE TABLE IF NOT EXISTS words (
  word       TEXT PRIMARY KEY,
  song_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/** Columns added after the first build ran; applied idempotently. */
const MIGRATIONS = [
  'ALTER TABLE songs ADD COLUMN dedup_key TEXT',
  'CREATE INDEX IF NOT EXISTS idx_songs_dedup ON songs(dedup_key)',
  'ALTER TABLE songs ADD COLUMN opening_hash TEXT',
  'CREATE INDEX IF NOT EXISTS idx_songs_opening ON songs(opening_hash)',
  "ALTER TABLE occurrences ADD COLUMN snippet TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE occurrences ADD COLUMN clipped INTEGER NOT NULL DEFAULT 0',
  // Retired with the phrase-matching mechanic.
  'DROP TABLE IF EXISTS openings',
  'DROP TABLE IF EXISTS handoffs',
  'DROP TABLE IF EXISTS line_links',
];

export function openBuildDb(path = BUILD_DB) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }
  return db;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
}
