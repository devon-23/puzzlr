/**
 * Lyric normalization and the chain graph.
 *
 * Matching is exact, on normalized tokens. No stemming, no fuzzy matching, no
 * equivalence tables: every equivalence is a rule the player can't see and will
 * feel cheated by when it fires (or doesn't).
 */

/** Section markers and repeat annotations, stripped wherever they appear. */
const MARKER_WORDS =
  /^(intro|outro|verse|chorus|pre[-\s]?chorus|bridge|hook|refrain|interlude|breakdown|solo|instrumental|spoken|repeat|x\s?\d+|\d+\s?x)\b/i;

/**
 * Interjections that make up throwaway lines before a song really starts.
 * Vocabulary-based rather than length-based on purpose — a one-word opening
 * like "Golden" has to survive, while "Ha!" must not.
 */
const ADLIB_WORDS = new Set([
  'ha', 'hah', 'aha', 'oh', 'ooh', 'oooh', 'ohh', 'uh', 'uhh', 'huh', 'ah', 'ahh',
  'yeah', 'yea', 'yah', 'ya', 'yo', 'hey', 'ay', 'aye', 'eh', 'mm', 'mmm', 'mmh', 'mmhm',
  'hmm', 'hm', 'woo', 'whoo', 'wooh', 'wo', 'la', 'na', 'da', 'do', 'ba', 'sha', 'doo', 'dum',
  'ooo', 'ohhh', 'shh', 'psh', 'brr', 'skrrt', 'ayy', 'ey', 'mhm', 'nah',
]);

/** Curly quotes, primes and dashes that should read as their ASCII forms. */
const QUOTE_MAP = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  'ʼ': "'", 'ʹ': "'", '`': "'", '´': "'",
  '“': '"', '”': '"', '„': '"', '″': '"',
  '–': '-', '—': '-', '‒': '-', '−': '-',
};

/**
 * Normalize one line to its comparable form.
 * NFKC → straight quotes → lowercase → strip markers → drop punctuation
 * (keeping only intra-word apostrophes) → collapse whitespace.
 */
export function normalizeLine(input) {
  if (!input) return '';

  let s = input.normalize('NFKC');
  s = s.replace(/[‘’‚‛′ʼʹ`´“”„″–—‒−]/g,
    (ch) => QUOTE_MAP[ch] ?? ch);
  s = s.toLowerCase();

  // Bracketed blocks are always annotations — drop them wholesale.
  s = s.replace(/\[[^\]]*\]/g, ' ');

  // Parenthesised blocks are only dropped when they read as an annotation;
  // otherwise they're backing vocals and the words stay (the parens don't).
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => (MARKER_WORDS.test(inner.trim()) ? ' ' : ` ${inner} `));

  // Everything that isn't a letter, digit, apostrophe or space becomes a break.
  s = s.replace(/[^\p{L}\p{N}'\s]+/gu, ' ');

  // Keep apostrophes only between two letters: "don't" survives, "'cause" and
  // trailing possessive marks do not become part of the token.
  s = s.replace(/'+/g, "'");
  s = s.replace(/(^|[^\p{L}])'+|'+([^\p{L}]|$)/gu, '$1$2');

  return s.replace(/\s+/g, ' ').trim();
}

/** Normalize and split into tokens. */
export function tokenize(input) {
  const n = normalizeLine(input);
  return n ? n.split(' ') : [];
}

/** True when a line carries no lyric content — only interjections. */
export function isAdlibLine(line) {
  const toks = tokenize(line);
  if (toks.length === 0) return true;
  return toks.every((t) => ADLIB_WORDS.has(t));
}

/**
 * Split raw lyrics into normalized content lines, dropping blanks, section
 * markers and ad-lib-only lines. Order is preserved.
 */
export function contentLines(rawLyrics) {
  if (!rawLyrics) return [];
  return rawLyrics
    .split(/\r?\n/)
    .map((l) => normalizeLine(l))
    .filter((l) => l.length > 0 && !isAdlibLine(l));
}

/**
 * A song's opening lines, used to fingerprint covers and to decide which part of
 * the lyrics stays out of the search index.
 *
 * Cleaning first matters: LRCLIB's Harry Styles "Golden" opens on a bare "Ha!",
 * so the raw first line is an ad-lib rather than the song.
 */
export const OPENING_LINE_COUNT = 2;

export function openingLines(rawLyrics) {
  return contentLines(rawLyrics).slice(0, OPENING_LINE_COUNT);
}

/**
 * Words that must never become a link.
 *
 * The chain hands off a single word, so it has to carry meaning on its own.
 * "the" or "to" would match tens of thousands of lines and give the player
 * nothing to think about.
 */
export const WEAK_WORDS = new Set(`
a an the and or but if as than that this these those so because
to of in on at for from with into onto over up off out about after before down
i me my you your he him his she her it its we us our they them their
am is are was were be been being do does did done have has had having
will would shall should can could may might must gonna wanna gotta let's
what which where when why how who whom whose there here now then just only very
not no nor all any some more most too own same such each few other
oh ooh ah ha yeah yea uh huh hey ay yo mm mmm hmm woo la na da doo ba
`.trim().split(/\s+/));

/**
 * A word is chainable if it can be handed off on its own.
 *
 * ADLIB_WORDS is checked here too, not just by isAdlibLine: an interjection
 * like "mmh" sitting inside an otherwise real line (isAdlibLine only drops a
 * line that is *nothing but* ad-libs) must still never become the word a
 * player is handed — nobody can chain off of it on purpose.
 */
export const isLinkWord = (w) => !!w && w.length > 1 && !WEAK_WORDS.has(w) && !ADLIB_WORDS.has(w);

/**
 * Every way a song can be reached, and what it hands over.
 *
 * The word may sit ANYWHERE in a line, not just at its start. Requiring the
 * line to begin on the word rejected the obvious answers — handed "people", a
 * player naturally reaches for "Treat People With Kindness", where the word sits
 * in the middle. So each line contributes every content word in it, paired with
 * the word the line finishes on.
 *
 * The end word is the last *chainable* word rather than the literal last token:
 * a line trailing off on "of it" would otherwise be a dead end, when "worst" was
 * sitting right there.
 *
 * The title counts as a line of its own, so a song is findable by the words in
 * its name even when the transcription is patchy.
 */
export const SNIPPET_TOKENS = 6;

export function wordOccurrences(rawLyrics, title = '') {
  const out = new Map(); // `${word}|${end}` -> { word, end, snippet }
  const lines = contentLines(rawLyrics);
  // The title is searchable but is not part of the song's flow, so it takes
  // part in within-line links only and never bridges to a lyric line.
  const lyricLineCount = lines.length;
  const titleLine = normalizeLine(title);
  if (titleLine) lines.push(titleLine);

  // Each line, split once, with the index of the word it hands over on.
  const parsed = lines.map((line) => {
    const toks = line.split(' ');
    let endAt = -1;
    for (let i = toks.length - 1; i >= 0; i--) {
      if (isLinkWord(toks[i])) { endAt = i; break; }
    }
    return { toks, endAt };
  });

  /**
   * Record one edge. First writer wins, so the within-line pass below always
   * takes precedence over the bridging pass for the same pair.
   */
  const add = (word, end, runUp, matchedAt) => {
    // A word never hands over to itself.
    if (word === end) return;
    const key = `${word}|${end}`;
    if (out.has(key)) return;

    // Show the run-up: from the matched word to the word handed over, capped so
    // the fragment stays short. Normalized rather than verbatim — enough to see
    // why the link works, not a reproduction of the line. When the cap cuts the
    // matched word off the front, `clipped` tells the UI to show an ellipsis.
    const from = Math.max(matchedAt, runUp.length - SNIPPET_TOKENS);
    out.set(key, { word, end, snippet: runUp.slice(from).join(' '), clipped: from > matchedAt });
  };

  // Pass 1 — within a line: every content word hands over to the word its own
  // line finishes on.
  for (const { toks, endAt } of parsed) {
    if (endAt < 0) continue;
    const end = toks[endAt];
    const runUp = toks.slice(0, endAt + 1);
    for (let i = 0; i < endAt; i++) {
      if (isLinkWord(toks[i])) add(toks[i], end, runUp, i);
    }
  }

  // Pass 2 — across the line break: the word a line ends on is trapped, since
  // nothing on its own line comes after it to be handed over. Chaining is what
  // the game is, so let the lyric carry on into the next line and hand over that
  // line's ending instead — "…three four" reads on into "well come" rather than
  // dead-ending on "four".
  for (let li = 0; li < lyricLineCount; li++) {
    const { toks, endAt } = parsed[li];
    if (endAt < 0) continue;

    let next = null;
    for (let j = li + 1; j < lyricLineCount; j++) {
      if (parsed[j].endAt >= 0) { next = parsed[j]; break; }
    }
    if (!next) continue;

    const word = toks[endAt];
    add(word, next.toks[next.endAt], [word, ...next.toks.slice(0, next.endAt + 1)], 0);
  }

  return [...out.values()];
}

/**
 * Collapse the release variants Deezer returns for one recording.
 *
 * A live take, a remaster and a radio edit all carry the same lyrics, so they
 * open on the same phrase and would sit in search results as interchangeable
 * answers to the same handoff. They are one song as far as the game is
 * concerned. Qualifiers are only stripped when they name a variant — a
 * parenthetical that isn't one (say a real subtitle) is left alone.
 */
const VARIANT_QUALIFIER =
  /\b(live|remaster(ed)?|remix|re-?recorded|version|edit|mix|acoustic|demo|radio|instrumental|karaoke|mono|stereo|deluxe|bonus|explicit|clean|extended|single|album|feat\.?|featuring|with)\b/i;

export function songKey(artist, title) {
  let t = title ?? '';
  t = t.replace(/[([][^)\]]*[)\]]/g, (m) => (VARIANT_QUALIFIER.test(m) ? ' ' : m));
  t = t.replace(/\s-\s.*$/, (m) => (VARIANT_QUALIFIER.test(m) ? '' : m));
  const a = normalizeLine(artist ?? '');
  const n = normalizeLine(t);
  return `${a}|${n}`;
}
