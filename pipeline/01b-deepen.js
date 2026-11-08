/**
 * Stage 01b — deepen the catalog.
 *
 * Stage 01 takes each artist's *top 50* tracks, which is the right popularity
 * signal for a 100k-song crawl but caps even a beloved band at 50 songs. This
 * stage lifts that cap for a chosen set of artists by walking their full
 * discography: every album, every track.
 *
 * Two sources of targets, unioned:
 *   DEEP_ARTISTS  comma-separated Deezer artist ids or names (names resolved
 *                 via /search/artist, first hit wins)
 *   DEEP_GENRE    a Deezer genre id whose chart artists are all deepened
 *                 (85 = Alternative; 0 disables)
 *
 * Resumable: progress lives in artists.deep_crawled, so a killed run picks up
 * where it stopped. Songs insert ON CONFLICT DO NOTHING against deezer_id, so
 * re-running is additive and never rewrites an existing row.
 *
 * Variant collapsing is NOT done here — songKey() at graph-build time already
 * folds live takes, remasters and radio edits onto one recording, so pulling a
 * whole discography does not flood the game with duplicates.
 */

import { openBuildDb, setMeta } from './lib/db.js';
import { createLimiter, fetchJson, pool } from './lib/http.js';

const API = 'https://api.deezer.com';
const RPS = Number(process.env.DEEZER_RPS ?? 8);
const CONCURRENCY = 6;
const GENRE = Number(process.env.DEEP_GENRE ?? 85);
const CHART_ARTISTS = Number(process.env.DEEP_CHART_ARTISTS ?? 100);
const ALBUM_PAGE = 100;
const TRACK_PAGE = 300;

const db = openBuildDb();
const limiter = createLimiter(RPS);

const upsertArtist = db.prepare(`
  INSERT INTO artists (deezer_id, name, picture, depth) VALUES (?,?,?,?)
  ON CONFLICT(deezer_id) DO NOTHING`);

const insertSong = db.prepare(`
  INSERT INTO songs (deezer_id, title, artist, artist_id, album, artwork, duration, rank)
  VALUES (@deezer_id,@title,@artist,@artist_id,@album,@artwork,@duration,@rank)
  ON CONFLICT(deezer_id) DO NOTHING`);

const markDeep = db.prepare('UPDATE artists SET deep_crawled=1 WHERE deezer_id=?');
const isDeep = db.prepare('SELECT deep_crawled FROM artists WHERE deezer_id=?').pluck();
const countSongs = db.prepare('SELECT COUNT(*) c FROM songs');

const addSongs = db.transaction((tracks, album) => {
  let n = 0;
  for (const t of tracks) {
    if (!t?.id || !t?.title || !t?.artist?.name) continue;
    n += insertSong.run({
      deezer_id: t.id,
      title: t.title,
      artist: t.artist.name,
      artist_id: t.artist.id ?? null,
      // Album tracks come back without their parent album, so carry it down.
      album: album?.title ?? null,
      artwork: album?.cover_medium ?? null,
      duration: t.duration ?? null,
      rank: t.rank ?? null,
    }).changes;
  }
  return n;
});

/** Page through a Deezer list endpoint until it stops returning rows. */
async function fetchAll(path, pageSize) {
  const out = [];
  for (let index = 0; ; index += pageSize) {
    const res = await fetchJson(`${API}${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}&index=${index}`, { limiter });
    const rows = res?.data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function resolveTargets() {
  const targets = new Map();

  const spec = (process.env.DEEP_ARTISTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of spec) {
    if (/^\d+$/.test(item)) {
      const a = await fetchJson(`${API}/artist/${item}`, { limiter });
      if (a?.id) targets.set(a.id, a);
      else console.warn(`  ! no artist with id ${item}`);
      continue;
    }
    const res = await fetchJson(`${API}/search/artist?q=${encodeURIComponent(item)}`, { limiter });
    const hit = res?.data?.[0];
    if (hit?.id) targets.set(hit.id, hit);
    else console.warn(`  ! no artist matched "${item}"`);
  }

  if (GENRE > 0 && CHART_ARTISTS > 0) {
    const res = await fetchJson(`${API}/chart/${GENRE}/artists?limit=${CHART_ARTISTS}`, { limiter });
    for (const a of res?.data ?? []) if (a?.id) targets.set(a.id, a);
  }

  return [...targets.values()];
}

async function deepenArtist(artist) {
  upsertArtist.run(artist.id, artist.name, artist.picture_medium ?? null, 0);
  if (isDeep.get(artist.id)) return { skipped: true, added: 0, albums: 0 };

  const albums = await fetchAll(`/artist/${artist.id}/albums`, ALBUM_PAGE);
  let added = 0;
  for (const album of albums) {
    if (!album?.id) continue;
    const tracks = await fetchAll(`/album/${album.id}/tracks`, TRACK_PAGE);
    if (tracks.length) added += addSongs(tracks, album);
  }
  markDeep.run(artist.id);
  return { skipped: false, added, albums: albums.length };
}

async function main() {
  const started = Date.now();
  const before = countSongs.get().c;

  console.log('resolving targets…');
  const targets = await resolveTargets();
  if (!targets.length) {
    console.error('no target artists — set DEEP_ARTISTS and/or DEEP_GENRE');
    process.exit(1);
  }
  console.log(`${targets.length} artist(s) to deepen · starting from ${before.toLocaleString()} songs\n`);

  let done = 0;
  let skipped = 0;
  await pool(targets, CONCURRENCY, async (artist) => {
    try {
      const r = await deepenArtist(artist);
      done++;
      if (r.skipped) { skipped++; return; }
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(
        `  [${done}/${targets.length}] ${artist.name} — ${r.albums} albums, +${r.added} songs  (${countSongs.get().c.toLocaleString()} total, ${mins}m)`,
      );
    } catch (err) {
      console.warn(`  ! ${artist.name} failed: ${err.message}`);
    }
  });

  const after = countSongs.get().c;
  setMeta(db, 'deepen_completed_at', new Date().toISOString());
  setMeta(db, 'deepen_song_count', after);
  console.log(`\ndone — ${(after - before).toLocaleString()} new songs (${before.toLocaleString()} → ${after.toLocaleString()})`);
  if (skipped) console.log(`${skipped} artist(s) already deepened, skipped`);
}

main().catch((err) => {
  console.error('deepen failed:', err.message);
  process.exit(1);
});
