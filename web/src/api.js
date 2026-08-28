/** Thin wrapper over the game API. All rules live on the server. */

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

/** Stable per-browser identity. No signup — that friction is what kills a daily game. */
export function deviceId() {
  const KEY = 'puzzlr.device';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Private windows and blocked site data: fall back to a per-tab identity.
    return (window.__puzzlrDevice ??= crypto.randomUUID());
  }
}

export function displayName() {
  try {
    return localStorage.getItem('puzzlr.name') ?? null;
  } catch {
    return null;
  }
}

export function setDisplayName(name) {
  try {
    localStorage.setItem('puzzlr.name', name);
  } catch { /* nothing to do — the name just won't persist */ }
}

/** The player's own local date decides the puzzle, so midnight is their midnight. */
const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Rarity of the word in play, by how many songs can answer it.
 * Must stay in step with RARITY in server/lib/share.js.
 */
const TIERS = [
  { max: 40, key: 'ultra', label: 'very rare' },
  { max: 120, key: 'rare', label: 'rare' },
  { max: 400, key: 'uncommon', label: 'uncommon' },
  { max: Infinity, key: 'common', label: 'common' },
];

export const tierOf = (answers) => TIERS.find((t) => (answers ?? 0) <= t.max);

/**
 * How full a guess bar reads, in the contexto register: a common word fills the
 * row, a rare one barely starts it. Log-scaled, because answer counts run from
 * single digits to five figures.
 */
export function fillFor(answers) {
  const n = Math.max(1, answers ?? 1);
  const pct = (Math.log(n) / Math.log(20000)) * 100;
  return Math.min(100, Math.max(8, Math.round(pct)));
}

/**
 * Split a stored fragment into its run-up and the word it hands over, so the
 * handover can be shown in bold. `clipped` is true when the fragment had to be
 * trimmed and should show a leading ellipsis.
 */
export function splitSnippet(snippet, matchedWord) {
  const toks = (snippet ?? '').split(' ').filter(Boolean);
  if (!toks.length) return { lead: '', last: '', clipped: false };
  const last = toks[toks.length - 1];
  return {
    lead: toks.slice(0, -1).join(' '),
    last,
    clipped: !!matchedWord && toks[0] !== matchedWord,
  };
}

export const api = {
  session: () => post('/api/session', { deviceId: deviceId(), localDate: localDate(), displayName: displayName() }),
  search: (sessionId, q) => post('/api/search', { sessionId, q }),
  chain: (sessionId, songId) => post('/api/chain', { sessionId, songId }),
  undo: (sessionId) => post('/api/undo', { sessionId }),
  giveUp: (sessionId) => post('/api/giveup', { sessionId }),
  leaderboard: (puzzle) => fetch(`/api/leaderboard?puzzle=${puzzle}`).then((r) => r.json()),
};
