<script setup>
defineEmits(['close']);
</script>

<template>
  <div class="scrim" @click.self="$emit('close')">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="How to play">
      <button class="x" @click="$emit('close')" aria-label="Close">×</button>
      <h2>How to play</h2>

      <p class="lede">Chain songs together, one word at a time.</p>

      <p>
        You're given a word. Name any song with that word <b>anywhere</b> in its
        lyrics or title. The <b>last word of the line it appears in</b> becomes
        your next word — and on it goes.
      </p>

      <div class="demo">
        <p class="label">Say the word is</p>
        <p class="phrase">alone</p>
        <ul class="flow">
          <li>
            <b>Leave Me Alone</b> <em>Reneé Rapp</em>
            <span>…leave me <i>alone</i>, I wanna have <i>fun</i></span>
          </li>
          <li>
            <b>Ain't It Fun</b> <em>Paramore</em>
            <span>ain't it <i>fun</i>, living in the real <i>world</i></span>
          </li>
          <li>
            <b>On Top Of The World</b> <em>Imagine Dragons</em>
            <span><i>world</i>, …</span>
          </li>
        </ul>
      </div>

      <h3>Three strikes</h3>
      <ul class="rules">
        <li>Pick a song that doesn't contain the word and you get an <b class="strike">✗</b>.</li>
        <li>Three and the run is over.</li>
        <li>Reusing a song you've already played also costs a strike.</li>
      </ul>

      <h3>Searching</h3>
      <ul class="rules">
        <li>Search a <b>title or artist</b> with any number of words.</li>
        <li>Search <b>lyrics</b> with three words or more — song openings aren't searchable, so search won't just hand you the answer.</li>
      </ul>

      <h3>Also</h3>
      <ul class="rules">
        <li>A song can only appear <b>once</b> per chain — no looping.</li>
        <li>Another song by the same artist is fine.</li>
        <li><b>3 undos</b> if a word has you stuck.</li>
        <li>The first word each day is an easy one.</li>
      </ul>

      <p class="foot">Everyone starts on the same song each day. Longest chain wins.</p>

      <button class="primary go" @click="$emit('close')">Play</button>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  display: grid;
  place-items: center;
  padding: 16px;
  overflow-y: auto;
  z-index: 20;
}
.sheet {
  position: relative;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  max-width: 460px;
  width: 100%;
  padding: 26px 24px 24px;
}
.x {
  position: absolute;
  top: 10px;
  right: 10px;
  border: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 20px;
  line-height: 1;
  color: var(--fg-mute);
  padding: 0;
}
h2 { margin: 0 0 4px; font-size: 1.15rem; letter-spacing: 0.02em; }
h3 { margin: 20px 0 6px; font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-mute); }
p { margin: 0 0 12px; font-size: 15px; }
.lede { color: var(--fg-soft); }

.demo { border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; margin: 16px 0 4px; }
.label { margin: 0; font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--fg-mute); }
.phrase { margin: 4px 0 10px; font-size: 1.3rem; font-weight: 700; }
.demo ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.demo li { font-size: 14px; color: var(--fg-soft); }
.demo i { font-style: normal; color: var(--fg); }
.yes { color: var(--key); font-weight: 700; margin-right: 6px; }
.no { color: var(--warn); font-weight: 700; margin-right: 6px; }

.flow { gap: 10px !important; }
.flow li { display: grid; gap: 1px; padding-left: 16px; position: relative; }
.flow li::before { content: '↓'; position: absolute; left: 0; top: 1px; color: var(--fg-mute); }
.flow li:first-child::before { content: '·'; }
.flow b { font-size: 14.5px; color: var(--fg); }
.flow em { font-style: normal; color: var(--fg-mute); font-size: 13px; }
.flow em::before { content: ' — '; }
.flow span { font-size: 13px; color: var(--fg-mute); }
.flow span i { font-weight: 700; color: var(--key); }
.strike { color: var(--warn); }

.rules { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.rules li { font-size: 14.5px; }
.rules li::marker { color: var(--fg-mute); }

.foot { margin: 20px 0 0; font-size: 13px; color: var(--fg-mute); }
.go { width: 100%; margin-top: 16px; padding: 13px; }
</style>
