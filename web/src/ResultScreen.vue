<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, splitSnippet, tierOf, displayName, setDisplayName } from './api.js';
import GuessBar from './GuessBar.vue';
import ArchivePicker from './ArchivePicker.vue';

const props = defineProps({ result: { type: Object, required: true } });
defineEmits(['play']);

const board = ref(null);
const copied = ref(null);

const minutes = computed(() => Math.max(1, Math.round(props.result.durationMs / 60000)));
const rarest = computed(() =>
  props.result.detail.reduce((b, d) => (!b || d.solutionCount < b.solutionCount ? d : b), null),
);

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * The run read as one continuous lyric: each snippet's run-up feeds straight
 * into the next, with the handoff word marked at each pivot. Consecutive
 * snippets share their pivot word (one ends on it, the next opens on it), so
 * that repeat is dropped rather than shown twice.
 */
const flowTokens = computed(() => {
  const tokens = [];
  const detail = props.result.detail;
  let prevLast = null;
  detail.forEach((d, i) => {
    if (!d.snippet) return;
    const { lead, last, clipped } = splitSnippet(d.snippet, d.word);
    let words = lead.split(' ').filter(Boolean);
    if (clipped) {
      tokens.push({ text: '…', marked: false });
    } else if (words.length && prevLast && norm(words[0]) === norm(prevLast)) {
      words = words.slice(1);
    } else if (words.length) {
      tokens.push({ text: words[0], marked: true, answers: d.solutionCount });
      words = words.slice(1);
    }
    words.forEach((w) => tokens.push({ text: w, marked: false }));
    if (last) {
      const next = detail[i + 1];
      const missed = props.result.couldHaveUsed;
      const answers = next
        ? next.solutionCount
        : norm(missed?.word) === norm(last)
          ? missed.answers
          : undefined;
      tokens.push({ text: last, marked: true, answers });
    }
    prevLast = last;
  });
  return tokens;
});

const flowText = computed(() =>
  flowTokens.value.map((t) => (t.marked ? `*${t.text}*` : t.text)).join(' '),
);

/** What "Copy chain" puts on the clipboard: the flow, as one shareable block. */
const story = computed(() =>
  [
    `Lyric Chain #${props.result.puzzle} — ${props.result.links} links`,
    '',
    flowText.value,
    '',
    'puzzlr.duckdns.org',
  ].join('\n'),
);

/** What "Copy songs" puts on the clipboard: just the credits, in order. */
const songCredits = computed(() =>
  [
    `Lyric Chain #${props.result.puzzle} — songs`,
    '',
    ...props.result.detail.map((d, i) => `${i + 1}. ${d.title} — ${d.artist}`),
  ].join('\n'),
);

onMounted(async () => {
  try {
    board.value = await api.leaderboard(props.result.puzzle);
  } catch { /* the board is a bonus, not the result */ }
});

/**
 * Naming yourself for the board.
 *
 * A run is created long before the player cares what they're called, so the
 * name is claimed here — usually on seeing a rank worth putting a name to.
 */
const savedName = ref(props.result.displayName ?? displayName());
const nameInput = ref(savedName.value ?? '');
const savingName = ref(false);
const nameError = ref(null);

async function saveName() {
  const v = nameInput.value.trim();
  if (!v || savingName.value) return;
  savingName.value = true;
  nameError.value = null;
  try {
    const { name } = await api.setName(props.result.sessionId, v);
    setDisplayName(name);
    savedName.value = name;
    nameInput.value = name;
    board.value = await api.leaderboard(props.result.puzzle); // show yourself on it
  } catch (e) {
    nameError.value = e.message;
  } finally {
    savingName.value = false;
  }
}

async function copy(text, which) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = which;
    setTimeout(() => (copied.value = null), 1600);
  } catch {
    copied.value = 'failed';
  }
}
</script>

<template>
  <div class="done">
    <p class="label">
      Chain #{{ result.puzzle }}
      <span v-if="result.archive" class="tag">archive · {{ result.puzzleDate }}</span>
    </p>
    <p class="big">{{ result.links }}</p>
    <p class="unit">link{{ result.links === 1 ? '' : 's' }}</p>

    <div class="stats">
      <div>
        <b class="x">{{ '✗'.repeat(result.strikes) || '—' }}</b>
        <span>strikes</span>
      </div>
      <div><b>{{ minutes }}</b><span>minutes</span></div>
      <!-- An archive run has no rank: it isn't racing that day's players. -->
      <div v-if="result.rank && result.playersFinished >= 5">
        <b>{{ result.rank }}</b>
        <span>of {{ result.playersFinished }} today</span>
      </div>
    </div>

    <p v-if="rarest" class="rarest">
      Your rarest link was <b>“{{ rarest.word }}”</b> — only
      {{ rarest.solutionCount.toLocaleString() }} song{{ rarest.solutionCount === 1 ? '' : 's' }}
      in the game have that word.
    </p>

    <div class="actions">
      <button @click="copy(story, 'story')">
        {{ copied === 'story' ? 'Copied' : 'Copy chain' }}
      </button>
      <button class="primary" @click="copy(result.share.grid, 'grid')">
        {{ copied === 'grid' ? 'Copied' : 'Share result' }}
      </button>
      <button @click="copy(songCredits, 'songs')">
        {{ copied === 'songs' ? 'Copied' : 'Copy songs' }}
      </button>
    </div>

    <section class="flow">
      <h2>The story</h2>
      <p class="flowtext">
        <span v-for="(t, i) in flowTokens" :key="i" class="tok">
          <b v-if="t.marked" :class="t.answers != null ? `b-${tierOf(t.answers).key}` : ''">{{ t.text }}</b>
          <template v-else>{{ t.text }}</template>
        </span>
      </p>
    </section>

    <h2>Your chain</h2>
    <div class="chain">
      <GuessBar
        v-for="(d, i) in result.detail"
        :key="i"
        :word="d.word"
        :answers="d.solutionCount ?? 0"
        :title="d.title"
        :artist="d.artist"
        :snippet="d.snippet"
        :index="i + 1"
      />
    </div>

    <section v-if="result.couldHaveUsed" class="missed">
      <h2>Songs you could have used</h2>
      <p class="sub">
        Still on <b>“{{ result.couldHaveUsed.word }}”</b> —
        {{ result.couldHaveUsed.answers.toLocaleString() }} songs had it.
      </p>
      <ul>
        <li v-for="s in result.couldHaveUsed.songs" :key="s.id">
          <span class="t">{{ s.title }}</span>
          <span class="a">{{ s.artist }}</span>
        </li>
      </ul>
    </section>

    <pre class="preview">{{ result.share.grid }}</pre>

    <section v-if="board?.entries?.length" class="board">
      <h2>Today’s longest chains</h2>

      <!-- An archive run isn't on today's board, so there's nothing to claim. -->
      <div v-if="!result.archive" class="claim">
        <p class="note">
          <template v-if="savedName">
            You’re on the board as <b>{{ savedName }}</b>.
          </template>
          <template v-else>
            You’re listed as <b>anonymous</b> — add a name to claim your place.
          </template>
        </p>
        <div class="row">
          <input
            v-model="nameInput"
            maxlength="20"
            placeholder="Your name"
            aria-label="Your name on the leaderboard"
            @keyup.enter="saveName"
          />
          <button @click="saveName" :disabled="!nameInput.trim() || savingName">
            {{ savingName ? 'Saving…' : savedName ? 'Update' : 'Save' }}
          </button>
        </div>
        <p v-if="nameError" class="note warn">{{ nameError }}</p>
      </div>

      <ol>
        <li v-for="e in board.entries.slice(0, 10)" :key="e.rank" :class="{ me: e.rank === result.rank }">
          <span class="r">{{ e.rank }}</span>
          <span class="who">{{ e.name }}</span>
          <span class="l">{{ e.links }}</span>
        </li>
      </ol>
    </section>

    <ArchivePicker @play="$emit('play', $event)" />

    <p class="tomorrow">New chain tomorrow.</p>
  </div>
</template>

<style scoped>
.done { text-align: center; padding-top: 12px; }
.label { margin: 0; font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--fg-mute); }
.tag {
  margin-left: 6px; padding: 2px 7px; border-radius: 999px;
  background: var(--fill); color: var(--fg-soft); letter-spacing: 0.06em;
}
.big { margin: 6px 0 0; font-size: 4rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.unit { margin: 0 0 22px; font-size: 13px; color: var(--fg-mute); }

.stats { display: flex; justify-content: center; gap: 30px; margin-bottom: 22px; }
.stats div { display: flex; flex-direction: column; gap: 2px; }
.stats b { font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.stats span { font-size: 11px; color: var(--fg-mute); }
.x { color: var(--warn); letter-spacing: 2px; }

.rarest { font-size: 14px; color: var(--fg-soft); margin: 0 0 22px; text-wrap: balance; }
.rarest b { color: var(--fg); }

.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 30px; }
.actions button { flex: 1 1 auto; min-width: 96px; padding: 13px 10px; font-size: 13.5px; }

.flow { text-align: left; margin-bottom: 30px; }
.flowtext {
  display: flex; flex-wrap: wrap; gap: 0 0.32em; margin: 0;
  font-size: 15.5px; line-height: 1.7; color: var(--fg-soft);
}
.flowtext .tok { display: inline; }
.flowtext b { font-weight: 700; color: var(--ink, var(--fg)); }

h2 {
  font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--fg-mute); margin: 0 0 10px; text-align: left;
}

.chain { text-align: left; margin-bottom: 30px; }

.missed { text-align: left; margin-bottom: 30px; }
.missed .sub { margin: 0 0 10px; font-size: 13px; color: var(--fg-mute); }
.missed .sub b { color: var(--fg-soft); }
.missed ul { list-style: none; margin: 0; padding: 0; }
.missed li {
  display: flex; flex-direction: column; gap: 1px;
  padding: 8px 0; border-bottom: 1px solid var(--line-soft);
}
.missed .t { font-weight: 600; font-size: 14.5px; }
.missed .a { font-size: 13px; color: var(--fg-mute); }

.preview {
  margin: 0 0 28px; padding: 14px; background: var(--fill); border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.45; white-space: pre-wrap; text-align: left; color: var(--fg-soft);
}

.board { text-align: left; }
.board ol { list-style: none; margin: 0; padding: 0; }
.board li {
  display: grid; grid-template-columns: 24px 1fr auto; gap: 10px;
  padding: 7px 0; border-bottom: 1px solid var(--line-soft); font-size: 14px;
}
.r { color: var(--fg-mute); font-variant-numeric: tabular-nums; }
.l { font-weight: 700; font-variant-numeric: tabular-nums; }
.board li.me { font-weight: 700; }
.board li.me .r, .board li.me .who { color: var(--key); }

.claim { margin-bottom: 14px; }
.claim .note { margin: 0 0 8px; font-size: 13px; color: var(--fg-mute); }
.claim .note b { color: var(--fg-soft); }
.claim .note.warn { margin: 8px 0 0; color: var(--warn); }
.claim .row { display: flex; gap: 8px; }
.claim .row input { flex: 1; min-width: 0; padding: 10px 12px; }
.claim .row button { flex: 0 0 auto; }

.tomorrow { margin-top: 32px; font-size: 12px; color: var(--fg-mute); }
</style>
