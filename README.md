# Lyric Chain

**One word. One song. One line's worth of momentum, and then you're on to the next.**

Lyric Chain is a daily word-association game built on real song lyrics. You're handed a word. You name any song — a real one, from a catalog of 80,000+ tracks — that contains that word anywhere in its title or lyrics. Whatever word *that song's line ends on* becomes the next word you have to answer. Chain as many songs together as you can before you rack up three wrong guesses.

Everyone gets the same opening song each day, and from there every player's chain forks off in its own direction — same start, same rules, wildly different paths. Longest chain wins.

It plays like a cross between Contexto and the six-degrees game, except the connective tissue is something you already know by heart: song lyrics.

## How a chain works

```
Word: "alone"
  → Leave Me Alone — Reneé Rapp     "...leave me alone, I wanna have fun"
Word: "fun"
  → Ain't It Fun — Paramore         "ain't it fun, living in the real world"
Word: "world"
  → On Top Of The World — Imagine Dragons
```

Every guess is scored by rarity — a word 9,000 songs could answer is trivial, a word only 12 songs carry is a real find. The rarer your links, the better your run.

The rules, in short:
- Name a song that contains the current word — anywhere in its lyrics or title.
- The **last word of the line it appears in** becomes the next word in play.
- Wrong guess or a repeated song → a strike. Three strikes ends the run.
- 3 undos per run if a word has you stuck.
- Search by title/artist freely, or by lyric with 3+ words — song openings aren't searchable, so search never just hands you the answer.

## Under the hood

Lyric Chain is a small full-stack app split into three independently runnable pieces:

| Layer | Tech |
|---|---|
| **Frontend** | [Vue 3](https://vuejs.org/) (`<script setup>` SFCs) built with [Vite](https://vitejs.dev/) — no router, no state library, just a handful of composable components |
| **Backend** | [Express](https://expressjs.com/) — a small, server-authoritative API. All game rules (what chains, what's a strike, what word comes next) are enforced server-side; the client is only ever told the outcome |
| **Data** | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), synchronous and file-based. Two databases: a read-only `catalog.db` (songs, lyrics-derived word graph, full-text search) shipped as a build artifact, and a small write-heavy `players.db` for sessions and the leaderboard |
| **Search** | SQLite FTS5, in two flavors — a normal title/artist index and a `content=''` / `detail='none'` lyric index that stores no text and no term positions, so lyrics can be matched but never reconstructed from the index |

### The data pipeline

The song catalog isn't hand-curated — it's built by a small resumable pipeline that crawls public APIs and compiles everything down into one shipped SQLite file:

1. **`seed`** — bootstraps ~100k songs from Deezer's per-genre charts, walking the related-artist graph outward so the catalog reflects what real artists' fans consider their best work.
2. **`hydrate`** — fetches lyrics per track from [LRCLIB](https://lrclib.net/), respecting a strict "never log a lyric" handling rule.
3. **`links`** — turns every lyric line into chain edges: `word → song → the word that line ends on`. This is the actual word graph the game runs on.
4. **`finalize`** — emits the final `catalog.db`. Only short, capped, normalized snippet fragments cross over into the shipped file — never full lyric text — so the artifact can show *why* a link works without shipping anything that resembles the original lyrics.

### Game logic highlights

- **No dead ends.** A word is only ever handed to a player if enough songs can answer it, and a correct guess always resolves to whichever of its lines hands over the *most answerable* next word — so a right answer never punishes you with an unwinnable follow-up.
- **Rarity-scored words.** Mid-chain words are picked to sit near an ideal rarity band (rare enough to be interesting, common enough to be fair); the very first word of the day is deliberately easy, so nobody strikes out before they understand the game.
- **Server-authoritative, always.** A public leaderboard is an obvious incentive to script the game, so nothing about validity, scoring, or the next word is decided on the client.

## Getting started

### Requirements
- Node.js 18+
- No API keys or accounts needed — the data pipeline talks to Deezer and LRCLIB's public, unauthenticated APIs.

### 1. Install

```bash
npm install
```

### 2. Build the song catalog

The app needs `data/catalog.db` to exist before the server will start. Build it once with the pipeline (this crawls real APIs, so it takes a while — tune `TARGET_SONGS` down for a quick local catalog):

```bash
npm run seed              # crawl artists/tracks from Deezer
npm run hydrate           # fetch lyrics from LRCLIB
npm run build:catalog     # build the word-chain graph + emit catalog.db
```

Handy env vars for a faster local build: `TARGET_SONGS=5000 npm run seed`, `HYDRATE_LIMIT=5000 npm run hydrate`.

### 3. Run it

Two processes, both required:

```bash
npm run server   # Express API on :3000
npm run dev      # Vite dev server on :5173, proxying /api to :3000
```

Open **http://localhost:5173** and play.

### Other scripts

```bash
npm test          # unit tests for the pipeline and game logic (node --test)
npm run smoke      # end-to-end smoke test against a running server
npm run build      # production frontend bundle → dist/
```

## Project layout

```
pipeline/    the catalog build — seed → hydrate → links → finalize
server/      the Express API + game rules (server/lib/game.js is the core engine)
web/         the Vue 3 + Vite frontend
scripts/     smoke test
```
