import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeLine,
  tokenize,
  isAdlibLine,
  contentLines,
  openingLines,
  wordOccurrences,
  isLinkWord,
  songKey,
} from './normalize.js';

/**
 * Every fixture below is synthetic — nonsense lyrics written for this test file.
 *
 * Real lyrics never appear in this repo. They exist only inside the hydrate
 * stage's memory and are destroyed before anything is written to disk (§02).
 * Fixtures reproduce the *structure* of real transcriptions — ad-lib intros,
 * section markers, curly apostrophes, repeated opening words — without the text.
 */

const AD_LIB_INTRO = `Whoo!

Silver, silver, silver as the kettle starts to sing
Hold the ladder, count the rungs, I'm halfway to the roof
I'm done hiding in the pantry with the jam`;

const MARKED_UP = `[Verse 1]
Paper aeroplanes are grounded (x2)
Tell the neighbours (tell the neighbours) we are moving out
[Chorus]
Every window in the terrace is a different shade of green`;

const CURLY = `I’m done hiding — don’t wait up for me`;

test('normalizeLine folds case, punctuation and curly apostrophes', () => {
  assert.equal(normalizeLine(CURLY), "i'm done hiding don't wait up for me");
});

test('normalizeLine keeps apostrophes only between letters', () => {
  assert.equal(normalizeLine("'Cause it's the dog's bowl"), "cause it's the dog's bowl");
  assert.deepEqual(tokenize("rock 'n' roll"), ['rock', 'n', 'roll']);
});

test('normalizeLine strips bracketed section markers', () => {
  assert.equal(normalizeLine('[Verse 1]'), '');
  assert.equal(normalizeLine('[Pre-Chorus] the lift is stuck again'), 'the lift is stuck again');
});

test('normalizeLine drops repeat annotations but keeps backing vocals', () => {
  assert.equal(normalizeLine('Paper aeroplanes are grounded (x2)'), 'paper aeroplanes are grounded');
  assert.equal(
    normalizeLine('Tell the neighbours (tell the neighbours) we are moving out'),
    'tell the neighbours tell the neighbours we are moving out',
  );
});

test('isAdlibLine is vocabulary-based, not length-based', () => {
  assert.equal(isAdlibLine('Whoo!'), true);
  assert.equal(isAdlibLine('Oh, oh, yeah'), true);
  assert.equal(isAdlibLine(''), true);
  // A one-word line that is a real lyric must survive — this is the whole
  // reason ad-lib detection can't just drop short lines.
  assert.equal(isAdlibLine('Silver'), false);
});

test('contentLines drops blanks, markers and ad-lib lines in order', () => {
  assert.deepEqual(contentLines(MARKED_UP), [
    'paper aeroplanes are grounded',
    'tell the neighbours tell the neighbours we are moving out',
    'every window in the terrace is a different shade of green',
  ]);
});

test('openingLines skips an ad-lib intro — the case strict token-0 gets wrong', () => {
  assert.deepEqual(openingLines(AD_LIB_INTRO), [
    'silver silver silver as the kettle starts to sing',
    'hold the ladder count the rungs i\'m halfway to the roof',
  ]);
});


test('wordOccurrences pairs every content word with the word its line ends on', () => {
  const occ = wordOccurrences('Silver, silver, silver as the kettle starts to sing');
  const pairs = occ.map((o) => `${o.word}->${o.end}`).sort();
  assert.deepEqual(pairs, ['kettle->sing', 'silver->sing', 'starts->sing']);
});

test('wordOccurrences matches mid-line, not just at the start', () => {
  // The case that made "Treat People With Kindness" fail under the old rule.
  const occ = wordOccurrences('Treat people with kindness');
  assert.ok(occ.some((o) => o.word === 'people' && o.end === 'kindness'));
});

test('wordOccurrences ends on the last CHAINABLE word, not the last token', () => {
  // Trailing on "of it" would be a dead end; "worst" was right there.
  const occ = wordOccurrences('People are the worst of it');
  assert.ok(occ.some((o) => o.word === 'people' && o.end === 'worst'));
});

test('wordOccurrences includes the title, so a song is findable by its name', () => {
  const occ = wordOccurrences('Some unrelated line here', 'Treat People With Kindness');
  assert.ok(occ.some((o) => o.word === 'people' && o.end === 'kindness'));
});

test('wordOccurrences never lets a word hand over to itself', () => {
  const occ = wordOccurrences('Kindness begets kindness');
  assert.ok(!occ.some((o) => o.word === o.end));
});

test('wordOccurrences skips ad-lib lines and weak words', () => {
  const occ = wordOccurrences('Whoo!\nThe silver kettle sings');
  assert.deepEqual(occ.map((o) => o.word).sort(), ['kettle', 'silver']);
  assert.ok(!occ.some((o) => o.word === 'the'), 'weak words are never links');
});

test('wordOccurrences bridges a line ending into the next line', () => {
  // "rungs" ends its line, so nothing on that line can follow it. The lyric
  // carries on, so it hands over the next line's ending instead of dead-ending.
  const occ = wordOccurrences('Hold the ladder, count the rungs\nSilver kettle');
  const bridge = occ.find((o) => o.word === 'rungs');
  assert.ok(bridge, 'a line-final word is still a usable link');
  assert.equal(bridge.end, 'kettle');
  assert.equal(bridge.snippet, 'rungs silver kettle');
});

test('a bridge steps over ad-lib lines, the way the lyric reads', () => {
  const occ = wordOccurrences('Count the rungs\nLa la la\nWhoo!\nSilver kettle');
  const bridge = occ.find((o) => o.word === 'rungs');
  assert.equal(bridge.end, 'kettle', 'ad-lib lines are not a dead end');
});

test('the last line has nothing to bridge into and is left alone', () => {
  const occ = wordOccurrences('Silver kettle');
  assert.ok(!occ.some((o) => o.word === 'kettle'));
});

test('a within-line link is preferred over a bridged one for the same pair', () => {
  // "kettle" reaches "sing" directly on line two; that direct fragment must win
  // over the bridge line one would otherwise contribute.
  const occ = wordOccurrences('Hold the kettle\nKettle starts to sing');
  const link = occ.find((o) => o.word === 'kettle' && o.end === 'sing');
  assert.equal(link.snippet, 'kettle starts to sing');
});

test('bridging never lets the title flow into a lyric line', () => {
  const occ = wordOccurrences('Silver kettle', 'Hold The Ladder');
  assert.ok(!occ.some((o) => o.word === 'ladder'), 'the title is not part of the flow');
});

test('isLinkWord rejects words that carry nothing on their own', () => {
  assert.equal(isLinkWord('alone'), true);
  assert.equal(isLinkWord('fun'), true);
  assert.equal(isLinkWord('the'), false, 'a handoff of "the" would match everything');
  assert.equal(isLinkWord('you'), false);
  assert.equal(isLinkWord('a'), false, 'single letters are never a fair link');
});

test('songKey collapses release variants of one recording', () => {
  const base = songKey('The Kettles', 'Silver');
  assert.equal(songKey('The Kettles', 'Silver (Live)'), base);
  assert.equal(songKey('The Kettles', 'Silver - 2011 Remaster'), base);
  assert.equal(songKey('The Kettles', 'Silver (feat. Downpipe)'), base);
  // A real subtitle is not a variant and must stay its own song.
  assert.notEqual(songKey('The Kettles', 'Silver (Part Two)'), base);
  // A cover keeps a different key; covers are caught later, by opening text.
  assert.notEqual(songKey('Downpipe', 'Silver'), base);
});
