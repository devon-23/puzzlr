/**
 * End-to-end smoke test against a running server.
 *
 * Plays a real word chain over HTTP the way the client does, then probes the
 * rules that matter: a song must contain the word somewhere, no song twice,
 * three strikes ends the run, and the search gate holds.
 *
 * Usage:  node server/index.js &   node scripts/smoke.js
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const catalog = new Database(resolve('data/catalog.db'), { readonly: true });

const answersFor = catalog.prepare(`
  SELECT DISTINCT o.song_id id, s.title, s.artist FROM occurrences o
  JOIN songs s ON s.id = o.song_id WHERE o.word = ? ORDER BY s.rank DESC LIMIT 60`);

const noLineFor = catalog.prepare(`
  SELECT s.id, s.title FROM songs s
  WHERE NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.song_id=s.id AND o.word=?)
  ORDER BY s.rank DESC LIMIT 1`);

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const device = `smoke-${Date.now()}`;
const today = new Date().toISOString().slice(0, 10);

console.log('\nSESSION');
const { body: start } = await post('/api/session', { deviceId: device, localDate: today, displayName: 'smoke' });
const sid = start.sessionId;
check('session created', !!sid);
check('starts on one song', start.chain?.length === 1, start.chain?.[0]?.title);
check('a word is in play', !!start.word, `"${start.word}" (${start.answers} answers)`);
check('three strikes available', start.strikesLeft === 3);

console.log('\nSEARCH GATE');
const one = await post('/api/search', { sessionId: sid, q: 'golden' });
check('one word searches titles only', one.body.lyricSearched === false);
check('one word still returns title hits', one.body.results.length > 0, `${one.body.results.length} results`);
const three = await post('/api/search', { sessionId: sid, q: 'i never wanted' });
check('three words opens lyric search', three.body.lyricSearched === true);
check('results carry no lyric text',
  three.body.results.every((r) => Object.keys(r).every((k) => ['id', 'title', 'artist', 'artwork'].includes(k))));

console.log('\nCHAIN');
let state = start;
const used = [state.chain[0].songId];
let played = 0;
const trail = [];

for (let i = 0; i < 20 && state.word; i++) {
  const options = answersFor.all(state.word).filter((s) => !used.includes(s.id));
  if (!options.length) { console.log(`  (nothing unused starts a line with "${state.word}")`); break; }
  const pick = options[0];
  const word = state.word;
  const { body } = await post('/api/chain', { sessionId: sid, songId: pick.id });
  if (!body.ok) { check(`chain "${word}" → ${pick.title}`, false, body.verdict); break; }
  trail.push(`${word} → ${pick.title}`);
  used.push(pick.id);
  played++;
  state = body;
}
check('built a chain', played >= 8, `${played} links`);
check('server agrees on length', state.links === played, `server=${state.links}`);
check('no song appears twice', new Set(state.chain.map((c) => c.songId)).size === state.chain.length);
check('no word served twice', (() => {
  const w = state.chain.map((c) => c.word).filter(Boolean);
  return new Set(w).size === w.length;
})());
check('no strikes from correct answers', state.strikes === 0, `${state.strikes}`);
console.log('   ' + trail.slice(0, 6).join('\n   '));

// Strikes are probed in a fresh session: the chain above may have run itself
// out of words, and a run with nothing in play returns 409 for every guess —
// which would pass these checks for entirely the wrong reason.
console.log('\nSTRIKES  (fresh session)');
const { body: b0 } = await post('/api/session', { deviceId: `${device}-strikes`, localDate: today });
const bsid = b0.sessionId;
const firstPick = answersFor.all(b0.word)[0];
const { body: b1 } = await post('/api/chain', { sessionId: bsid, songId: firstPick.id });
check('one good link to start', b1.ok === true, `"${b0.word}" → ${firstPick.title}`);

const repeat = await post('/api/chain', { sessionId: bsid, songId: firstPick.id });
check('replaying a used song is refused', repeat.body.ok === false, repeat.body.verdict);
check('verdict is already_used', repeat.body.verdict === 'already_used');
check('a reuse costs a strike', repeat.body.strikes === 1, `${repeat.body.strikes}`);

const wrong = noLineFor.get(b1.word);
const s2 = await post('/api/chain', { sessionId: bsid, songId: wrong.id });
check('a song not containing the word is refused', s2.body.verdict === 'no_line', s2.body.verdict);
check('two strikes, still alive', s2.body.strikes === 2 && !s2.body.eliminated);

const s3 = await post('/api/chain', { sessionId: bsid, songId: wrong.id });
check('three strikes ends the run', s3.body.eliminated === true, `strikes=${s3.body.strikes}`);
check('session is finished', s3.body.state === 'finished', s3.body.state);

const after = await post('/api/chain', { sessionId: bsid, songId: wrong.id });
check('a finished run accepts nothing more', after.status === 409, `HTTP ${after.status}`);

console.log('\nRESULT');
const { body: result } = await post('/api/giveup', { sessionId: sid });
check('result reports links', result.links === played, `${result.links}`);
check('result reports strikes', result.strikes === 0, `${result.strikes}`);
check('share grid exists', !!result.share?.grid);
check('share chain is words only', !!result.share?.poem && !result.share.poem.includes('\n'));
check('every link carries its run-up fragment', result.detail.every((d) => !!d.snippet));
check('the opening word is an easy one', start.answers >= 400, `${start.answers.toLocaleString()} answers`);
check('puzzle numbering starts at 1', start.puzzle >= 1 && start.puzzle < 10, `#${start.puzzle}`);
check('songs-you-could-have-used is present', (result.couldHaveUsed?.songs?.length ?? 0) > 0,
  result.couldHaveUsed ? `${result.couldHaveUsed.songs.length} for "${result.couldHaveUsed.word}"` : 'none');
check('each fragment ends on the word handed over',
  result.detail.every((d, i) => {
    const next = result.detail[i + 1];
    return !next || d.snippet.split(' ').pop() === next.word;
  }));

console.log('\n--- how the chain reads ---');
for (const d of result.detail.slice(0, 6)) {
  const t = d.snippet.split(' ');
  console.log(`   ${d.word.padEnd(12)} ${d.title} — ${d.artist}`);
  console.log(`   ${''.padEnd(12)} ${t.slice(0, -1).join(' ')} [${t[t.length - 1].toUpperCase()}]`);
}

console.log('\n--- share ---');
console.log(result.share.grid);
console.log('\n' + result.share.poem);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
