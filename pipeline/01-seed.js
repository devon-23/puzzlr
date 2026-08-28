/**
 * Stage 01 — seed catalog.
 *
 * Deezer's charts are only ~100 deep, so they can't reach 100k on their own.
 * Instead we bootstrap from the per-genre artist charts and walk the
 * related-artist graph outward, taking each artist's top tracks. Every song in
 * the catalog is therefore something *someone* considers that artist's best
 * work — which is the popularity signal the game needs.
 *
 * Resumable: progress lives in the artists table's crawled/expanded flags.
 */

import { openBuildDb, setMeta } from './lib/db.js';
import { createLimiter, fetchJson, pool } from './lib/http.js';

const API = 'https://api.deezer.com';
const TARGET = Number(process.env.TARGET_SONGS ?? 100000);
const RPS = Number(process.env.DEEZER_RPS ?? 8);
const CONCURRENCY = 8;
const TOP_TRACKS = 50;

const db = openBuildDb();
const limiter = createLimiter(RPS);

const upsertArtist = db.prepare(`
  INSERT INTO artists (deezer_id, name, picture, depth) VALUES (?,?,?,?)
  ON CONFLICT(deezer_id) DO NOTHING`);

const insertSong = db.prepare(`
  INSERT INTO songs (deezer_id, title, artist, artist_id, album, artwork, duration, rank)
  VALUES (@deezer_id,@title,@artist,@artist_id,@album,@artwork,@duration,@rank)
  ON CONFLICT(deezer_id) DO NOTHING`);

const markCrawled = db.prepare('UPDATE artists SET crawled=1 WHERE deezer_id=?');
const markExpanded = db.prepare('UPDATE artists SET expanded=1 WHERE deezer_id=?');

const countSongs = db.prepare('SELECT COUNT(*) c FROM songs');
const countArtists = db.prepare('SELECT COUNT(*) c FROM artists');
const nextToCrawl = db.prepare('SELECT deezer_id FROM artists WHERE crawled=0 ORDER BY depth, deezer_id LIMIT ?');
const nextToExpand = db.prepare('SELECT deezer_id, depth FROM artists WHERE expanded=0 ORDER BY depth, deezer_id LIMIT ?');

const addArtists = db.transaction((list, depth) => {
  let n = 0;
  for (const a of list) {
    if (a?.id && a?.name) n += upsertArtist.run(a.id, a.name, a.picture_medium ?? null, depth).changes;
  }
  return n;
});

const addSongs = db.transaction((tracks) => {
  let n = 0;
  for (const t of tracks) {
    if (!t?.id || !t?.title || !t?.artist?.name) continue;
    n += insertSong.run({
      deezer_id: t.id,
      title: t.title,
      artist: t.artist.name,
      artist_id: t.artist.id ?? null,
      album: t.album?.title ?? null,
      artwork: t.album?.cover_medium ?? null,
      duration: t.duration ?? null,
      rank: t.rank ?? null,
    }).changes;
  }
  return n;
});

async function bootstrap() {
  if (countArtists.get().c > 0) return;
  const genres = await fetchJson(`${API}/genre`, { limiter });
  const ids = (genres?.data ?? []).map((g) => g.id);
  console.log(`bootstrapping from ${ids.length} genre charts`);
  await pool(ids, 4, async (gid) => {
    const res = await fetchJson(`${API}/chart/${gid}/artists?limit=100`, { limiter });
    if (res?.data?.length) addArtists(res.data, 0);
  });
  console.log(`  seeded ${countArtists.get().c} chart artists`);
}

async function crawlTopTracks(batchSize) {
  const rows = nextToCrawl.all(batchSize);
  if (!rows.length) return 0;
  let added = 0;
  await pool(rows, CONCURRENCY, async ({ deezer_id }) => {
    const res = await fetchJson(`${API}/artist/${deezer_id}/top?limit=${TOP_TRACKS}`, { limiter });
    if (res?.data?.length) added += addSongs(res.data);
    markCrawled.run(deezer_id);
  });
  return added;
}

async function expandArtists(batchSize) {
  const rows = nextToExpand.all(batchSize);
  if (!rows.length) return 0;
  let discovered = 0;
  await pool(rows, CONCURRENCY, async ({ deezer_id, depth }) => {
    const res = await fetchJson(`${API}/artist/${deezer_id}/related?limit=50`, { limiter });
    if (res?.data?.length) discovered += addArtists(res.data, depth + 1);
    markExpanded.run(deezer_id);
  });
  return discovered;
}

async function main() {
  const started = Date.now();
  await bootstrap();

  let songs = countSongs.get().c;
  console.log(`target ${TARGET.toLocaleString()} songs · starting from ${songs.toLocaleString()}`);

  while (songs < TARGET) {
    // Keep the crawl frontier stocked, staying as close to the popular core as
    // possible by always expanding the shallowest artists first.
    const pending = nextToCrawl.all(1).length;
    if (!pending) {
      const found = await expandArtists(150);
      if (!found && !nextToCrawl.all(1).length) {
        console.log('frontier exhausted — no further artists reachable');
        break;
      }
      continue;
    }

    const added = await crawlTopTracks(150);
    songs = countSongs.get().c;
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(
      `  songs ${songs.toLocaleString()} (+${added})  artists ${countArtists.get().c.toLocaleString()}  ${mins}m`,
    );

    // Stay ahead of the crawler so it never starves.
    if (nextToCrawl.all(200).length < 200) await expandArtists(100);
  }

  setMeta(db, 'seed_completed_at', new Date().toISOString());
  setMeta(db, 'seed_song_count', countSongs.get().c);
  console.log(`\ndone — ${countSongs.get().c.toLocaleString()} songs from ${countArtists.get().c.toLocaleString()} artists`);
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
