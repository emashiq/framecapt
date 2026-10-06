/** A match: higher `score` is better; `indices` are the matched characters of the text (to highlight). */
export interface Match {
  score: number;
  indices: number[];
}

const isBoundary = (text: string, index: number): boolean =>
  index === 0 || /[\s\-–—_:/.()]/.test(text.charAt(index - 1));

/** One word of the query against the text: a substring beats a subsequence. */
function matchWord(word: string, text: string): Match | null {
  const at = text.indexOf(word);
  if (at >= 0) {
    const score = 1000 + (at === 0 ? 300 : isBoundary(text, at) ? 150 : 0) - at - text.length / 10;
    return { score, indices: Array.from({ length: word.length }, (_, i) => at + i) };
  }
  // Subsequence: every letter in order, rewarding runs and word starts.
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const letter of word) {
    const found = text.indexOf(letter, from);
    if (found < 0) return null;
    const previous = indices.at(-1);
    score +=
      previous !== undefined && found === previous + 1 ? 20 : isBoundary(text, found) ? 15 : 5;
    score -= found - from;
    indices.push(found);
    from = found + 1;
  }
  return { score, indices };
}

/**
 * Fuzzy match of `query` (words separated by spaces, all of which must match) against `text`,
 * ignoring case. An empty query matches everything with score 0. Pure.
 */
export function fuzzyMatch(query: string, text: string): Match | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  let score = 0;
  const indices = new Set<number>();
  for (const word of words) {
    const found = matchWord(word, haystack);
    if (!found) return null;
    score += found.score;
    for (const index of found.indices) indices.add(index);
  }
  return { score, indices: [...indices].sort((a, b) => a - b) };
}

/** The text cut into runs, each flagged when it was matched (for a highlighted label). */
export function highlightRuns(
  text: string,
  indices: readonly number[],
): { text: string; hit: boolean }[] {
  const hits = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hit = hits.has(i);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += text.charAt(i);
    else runs.push({ text: text.charAt(i), hit });
  }
  return runs;
}
