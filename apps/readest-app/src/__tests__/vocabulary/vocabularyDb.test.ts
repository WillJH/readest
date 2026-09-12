import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { DatabaseService } from '@/types/database';
import { VocabularyDb } from '@/services/vocabulary/vocabularyDb';

const DEFS_A = [{ source: 'Wiktionary', content: 'to move quickly' }];
const DEFS_B = [
  { source: 'StarDict', content: 'run: v. to move fast' },
  { source: 'Oxford', content: 'run /rʌn/ verb — move at a speed faster than walking' },
];

async function freshVocabDb(): Promise<VocabularyDb> {
  const db: DatabaseService = await NodeDatabaseService.open(':memory:');
  await migrate(db, getMigrations('vocabulary'));
  return VocabularyDb.from(db);
}

const CTX_BOOK1 = {
  bookHash: 'hash1',
  bookTitle: 'Book One',
  cfi: 'epubcfi(/6/4!/4/10)',
  sentence: 'She had to run to catch the bus.',
};
const CTX_BOOK2 = {
  bookHash: 'hash2',
  bookTitle: 'Book Two',
  cfi: 'epubcfi(/6/6!/4/2)',
  sentence: 'The engine began to run smoothly.',
};

describe('vocabulary migration', () => {
  it('creates the vocabulary tables and indexes', async () => {
    const db = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('vocabulary'));
    const objects = await db.select<{ name: string; type: string }>(
      `SELECT name, type FROM sqlite_master WHERE name LIKE '%vocabulary%'`,
    );
    const names = objects.map((o) => o.name);
    expect(names).toContain('vocabulary');
    expect(names).toContain('vocabulary_contexts');
    expect(names).toContain('idx_vocabulary_updated');
    expect(names).toContain('idx_vocabulary_contexts_word');
    expect(names).toContain('idx_vocabulary_contexts_book');
  });

  it('is idempotent', async () => {
    const db = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('vocabulary'));
    await expect(migrate(db, getMigrations('vocabulary'))).resolves.toBeUndefined();
  });
});

describe('VocabularyDb.saveWord', () => {
  let vocab: VocabularyDb;
  beforeEach(async () => {
    vocab = await freshVocabDb();
  });

  it('saves a new word with definitions and context', async () => {
    const saved = await vocab.saveWord({
      word: 'Run',
      lang: 'en',
      definitions: DEFS_A,
      context: CTX_BOOK1,
    });
    expect(saved.word).toBe('Run');
    expect(saved.definitions).toEqual(DEFS_A);
    expect(saved.contexts).toHaveLength(1);
    expect(saved.contexts[0]).toMatchObject({ bookHash: 'hash1', sentence: CTX_BOOK1.sentence });
    expect(saved.contextCount).toBe(1);
  });

  it('dedupes the same word case-insensitively and refreshes definitions', async () => {
    await vocab.saveWord({ word: 'Run', lang: 'en', definitions: DEFS_A, context: CTX_BOOK1 });
    const again = await vocab.saveWord({
      word: 'run',
      lang: 'en',
      definitions: DEFS_B,
      context: CTX_BOOK1,
    });
    const all = await vocab.listWords();
    expect(all).toHaveLength(1);
    expect(all[0]!.definitions).toEqual(DEFS_B);
    // Same (book, cfi) refreshes in place instead of appending.
    expect(again.contexts).toHaveLength(1);
    expect(again.updatedAt).toBeGreaterThanOrEqual(again.createdAt);
  });

  it('keeps the primary definition when it still exists in the new snapshot', async () => {
    const first = await vocab.saveWord({
      word: 'run',
      lang: 'en',
      definitions: DEFS_B,
      context: CTX_BOOK1,
    });
    await vocab.setPrimaryDefinition(first.id, 1);
    await vocab.saveWord({ word: 'run', lang: 'en', definitions: DEFS_B, context: null });
    const detail = await vocab.getWord(first.id);
    expect(detail?.primaryIndex).toBe(1);
    // Shrinking snapshot clamps an out-of-range primary back to the first entry.
    await vocab.saveWord({ word: 'run', lang: 'en', definitions: DEFS_A, context: null });
    const clamped = await vocab.getWord(first.id);
    expect(clamped?.primaryIndex).toBe(0);
  });

  it('appends a context from a different book or position', async () => {
    await vocab.saveWord({ word: 'run', lang: 'en', definitions: DEFS_A, context: CTX_BOOK1 });
    const detail = await vocab.saveWord({
      word: 'run',
      lang: 'en',
      definitions: [],
      context: CTX_BOOK2,
    });
    expect(detail.contexts).toHaveLength(2);
    // Empty definitions keep the previous snapshot.
    expect(detail.definitions).toEqual(DEFS_A);
    expect(detail.lastBookTitle).toBe('Book Two');
  });

  it('saves a word without a context', async () => {
    const saved = await vocab.saveWord({
      word: 'serendipity',
      lang: 'en',
      definitions: DEFS_A,
      context: null,
    });
    expect(saved.contexts).toHaveLength(0);
    expect(saved.lastBookTitle).toBeNull();
  });
});

describe('VocabularyDb.saveWord canonicalization', () => {
  let vocab: VocabularyDb;
  beforeEach(async () => {
    vocab = await freshVocabDb();
  });

  it('saves the base form and records the surface form', async () => {
    const saved = await vocab.saveWord({
      word: 'cats',
      lang: 'en',
      definitions: DEFS_A,
      context: CTX_BOOK1,
    });
    expect(saved.word).toBe('cat');
    expect(saved.surfaceForms).toEqual(['cats']);
  });

  it('uses the dictionary headword to resolve unknown bases', async () => {
    const saved = await vocab.saveWord({
      word: 'went',
      lang: 'en',
      definitions: DEFS_A,
      context: null,
      headword: 'go',
    });
    expect(saved.word).toBe('go');
    expect(saved.surfaceForms).toEqual(['went']);
  });

  it('merges an inflected save into the existing canonical entry', async () => {
    await vocab.saveWord({ word: 'run', lang: 'en', definitions: DEFS_A, context: CTX_BOOK1 });
    const merged = await vocab.saveWord({
      word: 'running',
      lang: 'en',
      definitions: [],
      context: CTX_BOOK2,
    });
    const all = await vocab.listWords();
    expect(all).toHaveLength(1);
    expect(all[0]!.word).toBe('run');
    expect(all[0]!.surfaceForms).toContain('running');
    expect(merged.contexts).toHaveLength(2);
  });

  it('unions surface forms across repeated inflected saves', async () => {
    await vocab.saveWord({ word: 'running', lang: 'en', definitions: DEFS_A, context: null });
    await vocab.saveWord({ word: 'ran', lang: 'en', definitions: [], context: null });
    await vocab.saveWord({ word: 'runs', lang: 'en', definitions: [], context: null });
    const detail = await vocab.getWord((await vocab.listWords())[0]!.id);
    expect(detail?.word).toBe('run');
    expect(detail?.surfaceForms.sort()).toEqual(['ran', 'running', 'runs']);
  });

  it('keeps lexicalized forms and non-English words as-is', async () => {
    const tired = await vocab.saveWord({
      word: 'tired',
      lang: 'en',
      definitions: DEFS_A,
      context: null,
    });
    expect(tired.word).toBe('tired');
    expect(tired.surfaceForms).toEqual([]);
    const fr = await vocab.saveWord({
      word: 'chats',
      lang: 'fr',
      definitions: DEFS_A,
      context: null,
    });
    expect(fr.word).toBe('chats');
  });
});

describe('VocabularyDb legacy normalization', () => {
  it('merges legacy inflected rows into their canonical entries once', async () => {
    const db: DatabaseService = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('vocabulary'));
    const now = Date.now();
    // Legacy rows exactly as the pre-canonicalization schema stored them.
    await db.execute(
      `INSERT INTO vocabulary (id, word, word_key, lang, definitions, primary_index, surface_forms, last_book_title, created_at, updated_at)
       VALUES ('id-run', 'run', 'run', 'en', ?, 0, '[]', 'Book One', ?, ?)`,
      [JSON.stringify(DEFS_B), now - 3000, now - 3000],
    );
    await db.execute(
      `INSERT INTO vocabulary (id, word, word_key, lang, definitions, primary_index, surface_forms, last_book_title, created_at, updated_at)
       VALUES ('id-running', 'running', 'running', 'en', ?, 0, '[]', 'Book Two', ?, ?)`,
      [JSON.stringify(DEFS_A), now - 2000, now - 1000],
    );
    await db.execute(
      `INSERT INTO vocabulary_contexts (id, word_id, book_hash, book_title, cfi, sentence, created_at)
       VALUES ('ctx-1', 'id-running', 'hash2', 'Book Two', 'epubcfi(/6/6!/4/2)', 'He was running late.', ?)`,
      [now - 2000],
    );
    await db.execute(
      `INSERT INTO vocabulary_contexts (id, word_id, book_hash, book_title, cfi, sentence, created_at)
       VALUES ('ctx-2', 'id-run', 'hash1', 'Book One', 'epubcfi(/6/4!/4/10)', 'She had to run.', ?)`,
      [now - 3000],
    );

    const fakeAppService = {
      openDatabase: async () => db,
    } as unknown as Parameters<typeof VocabularyDb.open>[0];
    const vocab = await VocabularyDb.open(fakeAppService);
    try {
      const all = await vocab.listWords();
      expect(all).toHaveLength(1);
      expect(all[0]!.word).toBe('run');
      expect(all[0]!.surfaceForms).toContain('running');
      // Target had definitions, so its snapshot wins; contexts unioned.
      expect(all[0]!.definitions).toEqual(DEFS_B);
      expect(all[0]!.contextCount).toBe(2);
      // A canonical word with no definitions adopts the merged row's snapshot
      // when re-saved — covered by saveWord tests; here verify idempotency:
      // reopening runs no further passes (flag set) and the state survives.
      const again = await VocabularyDb.open(fakeAppService);
      expect(await again.listWords()).toHaveLength(1);
    } finally {
      await vocab.close();
    }
  });

  it('renames a legacy row when no canonical target exists', async () => {
    const db: DatabaseService = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('vocabulary'));
    const now = Date.now();
    await db.execute(
      `INSERT INTO vocabulary (id, word, word_key, lang, definitions, primary_index, surface_forms, last_book_title, created_at, updated_at)
       VALUES ('id-cats', 'cats', 'cats', 'en', ?, 0, '[]', NULL, ?, ?)`,
      [JSON.stringify(DEFS_A), now, now],
    );
    const fakeAppService = {
      openDatabase: async () => db,
    } as unknown as Parameters<typeof VocabularyDb.open>[0];
    const vocab = await VocabularyDb.open(fakeAppService);
    try {
      const all = await vocab.listWords();
      expect(all).toHaveLength(1);
      expect(all[0]!.word).toBe('cat');
      expect(all[0]!.surfaceForms).toEqual(['cats']);
    } finally {
      await vocab.close();
    }
  });
});

describe('VocabularyDb list/filter/search', () => {
  let vocab: VocabularyDb;
  beforeEach(async () => {
    vocab = await freshVocabDb();
    // Distinct, strictly increasing capture timestamps — several saves can
    // land in the same millisecond, which makes MAX(created_at) ordering
    // (listSourceBooks / listWords) nondeterministic.
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    await vocab.saveWord({ word: 'run', lang: 'en', definitions: DEFS_B, context: CTX_BOOK1 });
    await vocab.saveWord({
      word: 'elaborate',
      lang: 'en',
      definitions: DEFS_A,
      context: CTX_BOOK2,
    });
    await vocab.saveWord({ word: 'run', lang: 'en', definitions: [], context: CTX_BOOK2 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists words newest-first with context counts', async () => {
    const all = await vocab.listWords();
    expect(all).toHaveLength(2);
    expect(all[0]!.word).toBe('run'); // touched last
    expect(all[0]!.contextCount).toBe(2);
  });

  it('searches word and definition content case-insensitively', async () => {
    expect((await vocab.listWords({ query: 'ELAB' })).map((w) => w.word)).toEqual(['elaborate']);
    expect((await vocab.listWords({ query: 'move fast' })).map((w) => w.word)).toEqual(['run']);
    expect(await vocab.listWords({ query: 'zzz' })).toHaveLength(0);
  });

  it('escapes LIKE wildcards in the query', async () => {
    expect(await vocab.listWords({ query: '%' })).toHaveLength(0);
    expect(await vocab.listWords({ query: '_' })).toHaveLength(0);
  });

  it('filters by source book', async () => {
    const fromBook1 = await vocab.listWords({ bookHash: 'hash1' });
    expect(fromBook1.map((w) => w.word)).toEqual(['run']);
    const fromBook2 = await vocab.listWords({ bookHash: 'hash2' });
    expect(fromBook2.map((w) => w.word).sort()).toEqual(['elaborate', 'run']);
  });

  it('lists source books for the filter dropdown', async () => {
    const books = await vocab.listSourceBooks();
    expect(books).toHaveLength(2);
    expect(books[0]).toMatchObject({ bookHash: 'hash2', count: 2 });
    expect(books.find((b) => b.bookHash === 'hash1')).toMatchObject({ count: 1 });
  });
});

describe('VocabularyDb delete', () => {
  it('removes the word and its contexts', async () => {
    const vocab = await freshVocabDb();
    const saved = await vocab.saveWord({
      word: 'run',
      lang: 'en',
      definitions: DEFS_A,
      context: CTX_BOOK1,
    });
    await vocab.deleteWord(saved.id);
    expect(await vocab.getWord(saved.id)).toBeNull();
    expect(await vocab.listWords()).toHaveLength(0);
    // Re-saving starts a fresh row (no resurrected contexts).
    const resaved = await vocab.saveWord({
      word: 'run',
      lang: 'en',
      definitions: DEFS_A,
      context: CTX_BOOK1,
    });
    expect(resaved.contexts).toHaveLength(1);
  });
});
