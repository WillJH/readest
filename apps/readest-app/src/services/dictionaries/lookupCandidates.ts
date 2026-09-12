import { getBaseFormCandidates, getLemmaCandidates } from './lemmatize';

/**
 * Ordered, de-duplicated query variants for a dictionary lookup.
 *
 * A double-click selection in the reader can carry leading/trailing
 * whitespace, and most imported dictionaries store headwords lowercased, so
 * an exact match on the raw selection often misses — e.g. `Hello` or
 * `world ` fail to resolve `hello`/`world`. The DICT/StarDict/slob readers
 * already compare case-insensitively, but case-sensitive formats (mdict) do
 * not. Callers try each candidate in order and keep the first hit.
 *
 * Variants, in priority order: base forms of an inflected selection
 * (`cats` → `cat`), then the trimmed selection as-is, all-lowercase,
 * title-case, all-uppercase (for acronym headwords), then language-aware
 * lemma candidates (`ran → run`, `mice → mouse`). The base forms lead
 * because dictionaries like Wiktionary keep a stub entry for every inflected
 * shape ("plural of cat"), and an exact hit on that stub would shadow the
 * real entry — the reason a base miss simply falls through to the surface
 * forms, a bad guess only costs one extra lookup. Lexicalized forms
 * (`interesting`, `tired`) keep the surface-first order via the morphology
 * guard. Returns `[]` for a blank input.
 */
export const buildLookupCandidates = (word: string, lang?: string | null): string[] => {
  const trimmed = word.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const title = trimmed.charAt(0).toUpperCase() + lower.slice(1);
  const upper = trimmed.toUpperCase();
  const bases = getBaseFormCandidates(lower, lang);
  const lemmas = getLemmaCandidates(lower, lang);
  return [...new Set([...bases, trimmed, lower, title, upper, ...lemmas])];
};
