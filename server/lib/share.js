/**
 * The share artifact — the two copy-paste blocks.
 *
 * Wordle's engine was never the word, it was the grid. The difference here is
 * that everyone starts on the same song and chains through different ones, so
 * every result is a path someone can actually read.
 *
 * Both blocks are built from handoff phrases only (2-6 words each). Never widen
 * this to include the lyric line a phrase came from — the short phrase is what
 * keeps the share safe to post (§09).
 */

/** Rarity of a link, by how many songs could have answered that handoff. */
/**
 * Rarity bands, scaled for anywhere-in-song matching: a word now typically has
 * dozens to thousands of answers, where the old phrase rule counted in single
 * digits. Ordered violet → orange → gold → green → blue → white, which reads
 * as escalating commonness without borrowing red from the strike marker.
 *
 * The top band used to be one bucket, "common," running from 401 answers all
 * the way to the most generic word in the catalog (70k+) — a word with 1,100
 * answers and one with 12,000 read identically even though the second is an
 * order of magnitude more common. Split at 1,500 and 5,000, which roughly
 * track the catalog's 98th and 99.5th percentiles, so "common" still means
 * "common," not "anything not already rare."
 */
export const RARITY = [
  { max: 40, square: '🟪', name: 'ultra-rare' },
  { max: 120, square: '🟧', name: 'rare' },
  { max: 400, square: '🟨', name: 'uncommon' },
  { max: 1500, square: '🟩', name: 'common' },
  { max: 5000, square: '🟦', name: 'very-common' },
  { max: Infinity, square: '⬜', name: 'ubiquitous' },
];

export const rarityOf = (solutionCount) => RARITY.find((r) => solutionCount <= r.max);

/** Long chains are the brag, but they still have to paste into a post. */
const MAX_ROWS = 25;

export function buildShare({ puzzle, links, undos = 0, strikes = 0, siteUrl = 'puzzlr.duckdns.org' }) {
  const squares = links.map((l) => rarityOf(l.solution_count).square);

  let grid;
  if (squares.length <= MAX_ROWS) {
    grid = squares.join('\n');
  } else {
    const head = squares.slice(0, MAX_ROWS - 6);
    const tail = squares.slice(-5);
    grid = [...head, '⋮', ...tail].join('\n');
  }

  const rarest = links.reduce(
    (best, l) => (best === null || l.solution_count < best.solution_count ? l : best),
    null,
  );

  const marks = strikes ? ` · ${'✗'.repeat(strikes)}` : '';
  const header = [
    `🎵 Lyric Chain #${puzzle}`,
    `${links.length} link${links.length === 1 ? '' : 's'}${marks}${undos ? ` · ${undos} undo${undos === 1 ? '' : 's'}` : ''}`,
  ].join('\n');

  const footer = rarest
    ? `\nrarest link: ${rarityOf(rarest.solution_count).name}\n${siteUrl}`
    : `\n${siteUrl}`;

  return {
    grid: `${header}\n\n${grid}\n${footer}`,
    poem: links.map((l) => l.handoff).join(' → '),
  };
}
