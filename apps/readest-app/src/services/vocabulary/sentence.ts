/**
 * Context-sentence extraction for vocabulary capture. Given the selection
 * Range at lookup time, find the sentence containing the word so the saved
 * entry can show how the word was actually used (and jump back to it).
 *
 * There is no sentence tokenizer in the app to reuse (the translator chunker
 * is length-driven), so this is a pragmatic paragraph→sentence trim:
 * take the closest block ancestor's text, split on sentence-final
 * punctuation, and keep the segment containing the word.
 */

const BLOCK_SELECTOR = 'p, div, li, blockquote, dd, dt, td, h1, h2, h3, h4, h5, h6, pre';
const MAX_SENTENCE_LENGTH = 500;
const FALLBACK_PREVIEW_LENGTH = 300;

/** Split on sentence-final punctuation, keeping trailing quotes/brackets. No lookbehind (old WebKit). */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let last = 0;
  // Latin enders need trailing whitespace (so "e.g." mid-sentence stays
  // intact); CJK enders are self-terminating — no space follows them.
  const re = /[.!?…]+["'”’)\]]*(?:\s+|$)|[。！？]+["'”’)\]]*/g;
  for (const match of text.matchAll(re)) {
    const end = match.index! + match[0].length;
    const sentence = text.slice(last, end).trim();
    if (sentence) sentences.push(sentence);
    last = end;
  }
  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) sentences.push(tail);
  }
  return sentences;
}

/** Pick the sentence containing `word` (case-insensitive), with fallbacks. */
export function pickSentenceFromText(text: string, word: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const needle = word.trim().toLowerCase();
  let picked = '';
  if (needle) {
    const lower = normalized.toLowerCase();
    const at = lower.indexOf(needle);
    if (at >= 0) {
      picked = splitSentences(normalized).find((s) => s.toLowerCase().includes(needle)) ?? '';
      // Word matched somewhere the splitter missed (e.g. no sentence-final
      // punctuation in the block): fall back to a window around the match.
      if (!picked) {
        const start = Math.max(0, at - 120);
        picked = normalized.slice(start, start + MAX_SENTENCE_LENGTH).trim();
      }
    }
  }
  if (!picked) picked = normalized.slice(0, FALLBACK_PREVIEW_LENGTH).trim();
  return picked.length > MAX_SENTENCE_LENGTH ? `${picked.slice(0, MAX_SENTENCE_LENGTH)}…` : picked;
}

/** Sentence containing a DOM selection, from its closest block ancestor. */
export function extractSentenceFromRange(range: Range, word: string): string {
  const startNode =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as Element | null);
  const block = startNode?.closest?.(BLOCK_SELECTOR) ?? null;
  const text = block?.textContent ?? range.toString();
  return pickSentenceFromText(text, word || range.toString());
}
