<script setup>
import { computed } from 'vue';
import { tierOf, fillFor, splitSnippet } from './api.js';

/**
 * One link in the chain, drawn as a contexto-style bar.
 *
 * Fill width and colour both come from how many songs carried the word: a bar
 * that runs the full row was an easy link, a short red stub was a hard one.
 * Doubling the encoding means the row still reads without colour.
 */
const props = defineProps({
  word: { type: String, required: true },
  answers: { type: Number, default: 0 },
  title: { type: String, default: '' },
  artist: { type: String, default: '' },
  snippet: { type: String, default: '' },
  index: { type: [Number, String], default: '' },
});

const tier = computed(() => tierOf(props.answers));
const fill = computed(() => fillFor(props.answers));
const frag = computed(() => splitSnippet(props.snippet, props.word));
</script>

<template>
  <div class="guess" :class="`b-${tier.key}`">
    <div class="bar" :style="{ '--fill': fill + '%' }">
      <span class="i" v-if="index !== ''">{{ index }}</span>
      <span class="w">{{ word }}</span>
      <span class="c">{{ answers.toLocaleString() }}</span>
    </div>
    <p class="meta" v-if="title">
      <span class="song">{{ title }}</span>
      <span class="artist">{{ artist }}</span>
    </p>
    <p class="snip" v-if="snippet">
      <span v-if="frag.clipped" class="ell">…</span>
      {{ frag.lead }} <b>{{ frag.last }}</b>
    </p>
  </div>
</template>

<style scoped>
.guess { margin-bottom: 10px; }

.bar {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 6px;
  /* The fill is a hard-stopped gradient rather than a nested element, so the
     text can sit across the boundary without extra markup. */
  background:
    linear-gradient(to right, var(--band) 0 var(--fill), var(--band-bg) var(--fill) 100%);
}
.i { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--fg); opacity: 0.5; }
.w { font-weight: 700; font-size: 15px; color: var(--fg); }
.c { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--fg); opacity: 0.65; }

.meta { margin: 5px 0 0; padding-left: 12px; font-size: 14px; line-height: 1.3; }
.song { font-weight: 600; }
.artist { color: var(--fg-mute); }
.artist::before { content: ' — '; }

.snip { margin: 2px 0 0; padding-left: 12px; font-size: 13px; color: var(--fg-mute); line-height: 1.45; }
.snip b { color: var(--ink); font-weight: 700; }
.ell { opacity: 0.6; }
</style>
