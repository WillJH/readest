/**
 * Pluggable, language-aware lemmatizer registry for dictionary lookup.
 *
 * Dictionaries like the Oxford Dictionary of English store only base headwords,
 * so an exact match on an inflected selection (`ran`, `mice`, `analyses`) misses
 * even though the lemma (`run`, `mouse`, `analysis`) is present. Lookup callers
 * append these lemma candidates after the exact/case variants so the lemma is
 * only tried once an exact match fails — exact match always wins.
 *
 * To add another language, write its lemmatizer and register it under the
 * primary subtag below; no caller changes are needed.
 */
import { normalizedLangCode } from '@/utils/lang';
import {
  hasInflectionSuffix,
  inflectionCandidates,
  irregularBaseOf,
  lemmatizeEnglish,
  lookupBaseFormsEnglish,
} from './english';

export { hasInflectionSuffix, inflectionCandidates, irregularBaseOf };

/** Maps a single inflected word to ordered, de-duplicated base-form candidates. */
export type Lemmatizer = (word: string) => string[];

const REGISTRY: Record<string, Lemmatizer> = {
  en: lemmatizeEnglish,
};

/** Like {@link Lemmatizer}, but returns priority-ordered *restricted* guesses. */
type BaseFormLookup = (word: string) => string[];

const BASE_FORM_REGISTRY: Record<string, BaseFormLookup> = {
  en: lookupBaseFormsEnglish,
};

/**
 * Base-form candidates for `word` in the given language. The language is
 * normalized to its primary subtag (`en-US` → `en`). When the language is
 * missing or unknown we default to English — imported dictionaries are
 * overwhelmingly English and the English lemmatizer is a no-op on non-ASCII
 * text. An *explicit* language with no registered lemmatizer yields `[]`.
 */
export const getLemmaCandidates = (word: string, lang?: string | null): string[] => {
  const code = normalizedLangCode(lang) || 'en';
  const lemmatizer = REGISTRY[code];
  return lemmatizer ? lemmatizer(word) : [];
};

/**
 * Priority-ordered base-form guesses for reordering lookup candidates
 * (`cats` → [`cat`]), so dictionaries resolve the real entry ahead of their
 * "plural of cat" stubs. Same language dispatch and defaulting rules as
 * {@link getLemmaCandidates}; a bad guess simply misses in the dictionary and
 * the caller falls through to the surface form.
 */
export const getBaseFormCandidates = (word: string, lang?: string | null): string[] => {
  const code = normalizedLangCode(lang) || 'en';
  const lookup = BASE_FORM_REGISTRY[code];
  return lookup ? lookup(word) : [];
};
