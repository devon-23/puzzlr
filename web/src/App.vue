<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { api, tierOf, fillFor } from './api.js';
import GuessBar from './GuessBar.vue';
import ResultScreen from './ResultScreen.vue';
import HowToPlay from './HowToPlay.vue';

const session = ref(null);
const loading = ref(true);
const error = ref(null);

const query = ref('');
const results = ref([]);
const notice = ref(null);
const searching = ref(false);

const toast = ref(null);
const result = ref(null);
const busy = ref(false);
const showHelp = ref(false);
const shake = ref(false);

const links = computed(() => session.value?.links ?? 0);
const word = computed(() => session.value?.word ?? null);
const answers = computed(() => session.value?.answers ?? 0);
const strikes = computed(() => session.value?.strikes ?? 0);
const undosLeft = computed(() => session.value?.undosLeft ?? 0);
const tier = computed(() => tierOf(answers.value));

/** Newest first, so the freshest guess sits right under the search box. */
const played = computed(() =>
  (session.value?.chain ?? []).filter((c) => c.word).slice().reverse(),
);
const startSong = computed(() => session.value?.chain?.[0] ?? null);

onMounted(async () => {
  try {
    session.value = await api.session();
    if (session.value.state === 'finished') result.value = await api.giveUp(session.value.sessionId);
    else showHelp.value = !seenHelp();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});

/** Private windows and blocked site data throw on access, so never read it bare. */
function seenHelp() {
  try { return !!localStorage.getItem('puzzlr.seenHelp'); } catch { return false; }
}
function closeHelp() {
  showHelp.value = false;
  try { localStorage.setItem('puzzlr.seenHelp', '1'); } catch { /* it just shows again */ }
}

let flashTimer;
function flash(text, ok = false) {
  toast.value = { text, ok };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (toast.value = null), 2400);
}

let searchToken = 0;
watch(query, (q) => {
  const mine = ++searchToken;
  if (!q.trim()) {
    results.value = [];
    notice.value = null;
    searching.value = false;
    return;
  }
  searching.value = true;
  setTimeout(async () => {
    if (mine !== searchToken) return;
    try {
      const r = await api.search(session.value.sessionId, q);
      if (mine !== searchToken) return;
      results.value = r.results;
      notice.value = r.notice;
    } catch (e) {
      notice.value = e.message;
    } finally {
      if (mine === searchToken) searching.value = false;
    }
  }, 220);
});

const reasonFor = (verdict, w) => {
  return ({
    no_line: `“${w}” isn’t in that song`,
    already_used: 'Already in your chain',
    unknown_song: 'That song isn’t in the catalog',
  })[verdict] ?? 'Doesn’t chain';
};

async function choose(song) {
  if (busy.value) return;
  busy.value = true;
  const inPlay = word.value;
  try {
    const r = await api.chain(session.value.sessionId, song.id);
    session.value = r;
    query.value = '';
    results.value = [];

    if (r.ok) {
      flash(r.exhausted ? 'Chained — but nothing follows that word' : 'Chained', true);
    } else {
      shake.value = true;
      setTimeout(() => (shake.value = false), 420);
      flash(reasonFor(r.verdict, inPlay));
      if (r.eliminated) result.value = await api.giveUp(session.value.sessionId);
    }
  } catch (e) {
    flash(e.message);
  } finally {
    busy.value = false;
  }
}

async function undo() {
  if (busy.value || !undosLeft.value) return;
  busy.value = true;
  try {
    session.value = await api.undo(session.value.sessionId);
    flash('Undone');
  } catch (e) {
    flash(e.message);
  } finally {
    busy.value = false;
  }
}

/**
 * Switch to a past puzzle chosen from the archive. If that run was already
 * finished, go straight to its result rather than a board the player can't move.
 */
async function startArchive(s) {
  session.value = s;
  result.value = s.state === 'finished' ? await api.giveUp(s.sessionId) : null;
  query.value = '';
  results.value = [];
  notice.value = null;
  window.scrollTo({ top: 0 });
}

async function giveUp() {
  if (!confirm(`End today's run at ${links.value} link${links.value === 1 ? '' : 's'}? You can't restart until tomorrow.`)) return;
  result.value = await api.giveUp(session.value.sessionId);
}
</script>

<template>
  <header class="bar">
    <button class="icon" @click="showHelp = true" aria-label="How to play">?</button>
    <h1>Lyric Chain</h1>
    <span class="strikes" v-if="session && !result" :aria-label="`${strikes} of 3 strikes`">
      <i v-for="n in 3" :key="n" :class="{ hit: n <= strikes }">✗</i>
    </span>
    <span v-else class="strikes"></span>
  </header>

  <main>
    <p v-if="loading" class="status">Loading today’s chain…</p>
    <p v-else-if="error" class="status warn">{{ error }}</p>

    <ResultScreen v-else-if="result" :result="result" @play="startArchive" />

    <template v-else>
      <!-- Playing back in time is easy to forget you did; say so plainly. -->
      <p v-if="session?.archive" class="archive-note">
        Archive chain #{{ session.puzzle }} — {{ session.puzzleDate }}
      </p>

      <!-- The prompt and the search box keep a fixed position; everything the
           player builds grows downward beneath them. -->
      <section class="ask" :class="[`b-${tier.key}`, { shake }]" v-if="word">
        <p class="label">Next word</p>
        <p class="word">{{ word }}</p>
        <div class="gauge"><span :style="{ width: fillFor(answers) + '%' }"></span></div>
        <p class="rule">
          <b>{{ answers.toLocaleString() }}</b> songs have it · {{ tier.label }}
        </p>
      </section>
      <section class="ask b-ultra" v-else>
        <p class="label">Nothing follows</p>
        <p class="word">—</p>
        <p class="rule">No word left to chain from here. Undo, or end the run.</p>
      </section>

      <input
        v-model="query"
        :disabled="!word"
        placeholder="Song title, artist, or 3+ words of lyrics"
        aria-label="Search for the next song"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />

      <ul class="results" v-if="results.length">
        <li v-for="song in results" :key="song.id">
          <button class="row" @click="choose(song)" :disabled="busy">
            <span class="t">{{ song.title }}</span>
            <span class="a">{{ song.artist }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="query && !searching && !notice" class="note">No songs found.</p>
      <p v-if="notice" class="note">{{ notice }}</p>

      <div class="controls">
        <button @click="undo" :disabled="!undosLeft || played.length < 1">
          Undo<span v-if="undosLeft"> ({{ undosLeft }})</span>
        </button>
        <button class="give" @click="giveUp">End run</button>
      </div>

      <!-- Newest first: the guess you just made sits at the top. -->
      <div class="chain">
        <GuessBar
          v-for="(item, i) in played"
          :key="item.position"
          :word="item.word"
          :answers="item.answers"
          :title="item.title"
          :artist="item.artist"
          :snippet="item.snippet"
          :index="played.length - i"
        />
        <p v-if="startSong" class="opener">
          Today’s opener — <b>{{ startSong.title }}</b> <em>{{ startSong.artist }}</em>
        </p>
      </div>
    </template>
  </main>

  <Transition name="fade">
    <p v-if="toast" class="toast" :class="{ ok: toast.ok }" role="status">{{ toast.text }}</p>
  </Transition>

  <HowToPlay v-if="showHelp" @close="closeHelp" />
</template>

<style scoped>
.bar {
  display: grid;
  grid-template-columns: 44px 1fr 60px;
  align-items: center;
  border-bottom: 1px solid var(--line);
  padding: 8px 12px;
}
h1 { margin: 0; text-align: center; font-size: 1.35rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
.icon { border: 0; padding: 0; width: 34px; height: 34px; border-radius: 50%; font-weight: 700; color: var(--fg-mute); }

.strikes { display: flex; justify-content: flex-end; gap: 4px; }
.strikes i { font-style: normal; font-size: 15px; font-weight: 700; color: var(--line); line-height: 1; }
.strikes i.hit { color: var(--warn); }

main { max-width: 480px; margin: 0 auto; padding: 16px 16px 90px; }
.status { text-align: center; color: var(--fg-mute); padding: 64px 0; }
.status.warn { color: var(--warn); }

.archive-note {
  margin: 0 0 10px; padding: 7px 12px; border-radius: 6px;
  background: var(--fill); color: var(--fg-soft);
  font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; text-align: center;
}

/* ── the prompt ── */
.ask {
  text-align: center;
  padding: 18px 16px 16px;
  border-radius: 8px;
  margin-bottom: 12px;
  background: var(--band-bg);
}
.label { margin: 0; font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--fg-mute); }
.word {
  margin: 4px 0 0; font-size: 2.4rem; font-weight: 700; letter-spacing: -0.02em;
  word-break: break-word; color: var(--ink);
}
.gauge {
  height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--band) 22%, transparent);
  margin: 12px auto 0; max-width: 260px; overflow: hidden;
}
.gauge span { display: block; height: 100%; background: var(--band); border-radius: 3px; }
.rule { margin: 8px auto 0; font-size: 12.5px; color: var(--fg-mute); }
.rule b { color: var(--ink); }

@media (prefers-reduced-motion: no-preference) {
  .ask.shake { animation: shake 0.4s; }
  .gauge span { transition: width 0.35s ease; }
}
@keyframes shake {
  10%, 90% { transform: translateX(-2px); }
  20%, 80% { transform: translateX(4px); }
  30%, 50%, 70% { transform: translateX(-7px); }
  40%, 60% { transform: translateX(7px); }
}

.note { font-size: 13px; color: var(--fg-mute); margin: 10px 0 0; text-align: center; }

.results { list-style: none; margin: 8px 0 0; padding: 0; }
.row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line-soft);
  border-radius: 0; padding: 10px 8px; font-weight: 400;
}
.row .t { font-weight: 600; font-size: 15px; }
.row .a { font-size: 13px; color: var(--fg-mute); }

.controls { display: flex; gap: 8px; margin: 16px 0 18px; }
.controls .give { margin-left: auto; color: var(--fg-mute); }

.chain { margin-top: 4px; }
.opener {
  margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--line-soft);
  font-size: 13px; color: var(--fg-mute); text-align: center;
}
.opener b { color: var(--fg-soft); font-weight: 600; }

.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); margin: 0;
  background: var(--fg); color: var(--bg); padding: 11px 18px; border-radius: 6px;
  font-size: 14px; font-weight: 600; max-width: calc(100vw - 32px); text-align: center;
}
.toast.ok { background: var(--key); color: var(--key-ink); }

.fade-enter-active, .fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .fade-enter-active, .fade-leave-active { transition: none; } }
</style>
