<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from './api.js';

/**
 * The way back into past puzzles.
 *
 * Shown once a run is over, because the point is "that's done, here's more to
 * play" — offering it mid-chain would just be a way to abandon a bad run.
 */
const emit = defineEmits(['play']);

const range = ref(null);
const chosen = ref('');
const busy = ref(false);
const error = ref(null);

onMounted(async () => {
  try {
    range.value = await api.archive();
    chosen.value = range.value.last?.date ?? '';
  } catch {
    error.value = 'Could not load the archive.';
  }
});

/** Puzzles this device has already played, by date — those are not replayable. */
const playedBy = computed(() =>
  Object.fromEntries((range.value?.played ?? []).map((p) => [p.date, p])),
);
const already = computed(() => playedBy.value[chosen.value] ?? null);

/** Nothing to reach back to on launch day itself. */
const empty = computed(() => range.value && range.value.last.puzzle < 1);

async function play() {
  if (!chosen.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    emit('play', await api.session(chosen.value));
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="archive">
    <h2>Play a past chain</h2>

    <p v-if="empty" class="note">The archive opens tomorrow — today is the first chain.</p>

    <template v-else-if="range">
      <p class="note">
        Every chain back to
        <b>{{ range.first.date }}</b>. One attempt each, and archive runs stay off
        the daily leaderboard.
      </p>

      <div class="row">
        <input
          type="date"
          v-model="chosen"
          :min="range.first.date"
          :max="range.last.date"
          aria-label="Pick a past date to play"
        />
        <button class="primary" @click="play" :disabled="!chosen || busy || !!already">
          {{ busy ? 'Loading…' : already ? 'Played' : 'Play' }}
        </button>
      </div>

      <p v-if="already" class="note done">
        You already played that one — {{ already.links }}
        link{{ already.links === 1 ? '' : 's' }}.
      </p>
      <p v-if="error" class="note warn">{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.archive { text-align: left; margin-bottom: 30px; }
h2 {
  font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--fg-mute); margin: 0 0 10px;
}
.note { margin: 0 0 10px; font-size: 13px; color: var(--fg-mute); line-height: 1.5; }
.note b { color: var(--fg-soft); }
.note.done { margin: 8px 0 0; color: var(--fg-soft); }
.note.warn { margin: 8px 0 0; color: var(--warn); }

.row { display: flex; gap: 8px; }
.row input { flex: 1; min-width: 0; }
.row button { flex: 0 0 auto; padding: 13px 20px; }
</style>
