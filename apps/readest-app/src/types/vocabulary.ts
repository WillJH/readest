/**
 * Vocabulary book domain types. A word is identified case-insensitively
 * (`word_key`); every lookup of the same word refreshes its definition
 * snapshot and appends a new reading context (sentence + position).
 */

export interface DefinitionSnapshot {
  /** Dictionary source label as shown in the lookup popup (e.g. 'Wiktionary'). */
  source: string;
  /** Text snapshot of the rendered entry at capture time. */
  content: string;
  /**
   * Sanitized HTML snapshot of the rendered entry, when available — keeps the
   * dictionary's typography (bold headwords, italic phonetics, tables). Older
   * records without it fall back to `content` as plain text.
   */
  html?: string;
}

export interface VocabularyContext {
  id: string;
  bookHash: string;
  bookTitle: string;
  /** CharRange-free locator; empty string when the selection had no CFI. */
  cfi: string;
  sentence: string;
  createdAt: number;
}

/** Word row as shown in the list view (contexts not included). */
export interface VocabularyWord {
  id: string;
  word: string;
  lang: string | null;
  definitions: DefinitionSnapshot[];
  primaryIndex: number;
  /** Title of the book the word was most recently captured from. */
  lastBookTitle: string | null;
  /** Distinct book hashes the word was captured from (for list filtering). */
  bookHashes: string[];
  contextCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface VocabularyWordDetail extends VocabularyWord {
  contexts: VocabularyContext[];
}

export interface SaveVocabularyContext {
  bookHash: string;
  bookTitle: string;
  /** Empty string when unavailable; deduped together with bookHash. */
  cfi: string;
  sentence: string;
}

export interface SaveVocabularyInput {
  word: string;
  lang: string | null;
  /** Empty array keeps the previous snapshot (re-lookup with no results). */
  definitions: DefinitionSnapshot[];
  context: SaveVocabularyContext | null;
}

export interface ListVocabularyOptions {
  /** Case-insensitive substring match against word and definition content. */
  query?: string;
  /** Only words captured at least once from this book. */
  bookHash?: string;
  limit?: number;
  offset?: number;
}
