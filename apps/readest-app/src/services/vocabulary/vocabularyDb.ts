import { v4 as uuidv4 } from 'uuid';
import type { AppService } from '@/types/system';
import type { DatabaseService, DatabaseRow } from '@/types/database';
import type {
  DefinitionSnapshot,
  ListVocabularyOptions,
  SaveVocabularyInput,
  VocabularyContext,
  VocabularyWord,
  VocabularyWordDetail,
} from '@/types/vocabulary';

interface WordRow extends DatabaseRow {
  id: string;
  word: string;
  lang: string | null;
  definitions: string;
  primary_index: number;
  last_book_title: string | null;
  book_hashes: string | null;
  context_count: number;
  created_at: number;
  updated_at: number;
}

interface ContextRow extends DatabaseRow {
  id: string;
  book_hash: string;
  book_title: string;
  cfi: string;
  sentence: string;
  created_at: number;
}

export interface VocabularySourceBook {
  bookHash: string;
  bookTitle: string;
  count: number;
}

/**
 * Per-tab singleton open promise — OPFS permits only one access handle per
 * file, so every capture site and the sidebar view must share one
 * connection (same constraint as StatisticsDb).
 */
let sharedDb: Promise<VocabularyDb> | null = null;
let lifecycleBound = false;

function bindLifecycle(): void {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && sharedDb) {
      void sharedDb.then((s) => s.checkpoint()).catch(() => {});
    }
  });
}

function parseDefinitions(raw: string): DefinitionSnapshot[] {
  try {
    const parsed = JSON.parse(raw) as DefinitionSnapshot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toWord(row: WordRow): VocabularyWord {
  return {
    id: row.id,
    word: row.word,
    lang: row.lang,
    definitions: parseDefinitions(row.definitions),
    primaryIndex: row.primary_index,
    lastBookTitle: row.last_book_title,
    bookHashes: row.book_hashes ? row.book_hashes.split(',').filter(Boolean) : [],
    contextCount: row.context_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toContext(row: ContextRow): VocabularyContext {
  return {
    id: row.id,
    bookHash: row.book_hash,
    bookTitle: row.book_title,
    cfi: row.cfi,
    sentence: row.sentence,
    createdAt: row.created_at,
  };
}

/** Typed wrapper over the global `vocabulary.db` (words captured from lookups). */
export class VocabularyDb {
  private constructor(private readonly db: DatabaseService) {}

  /** Production entry point — opens + migrates vocabulary.db (per-tab singleton). */
  static async open(appService: AppService): Promise<VocabularyDb> {
    bindLifecycle();
    if (!sharedDb) {
      const opening = (async () => {
        const db = await appService.openDatabase('vocabulary', 'vocabulary.db', 'Data');
        return new VocabularyDb(db);
      })();
      sharedDb = opening;
      void opening.catch(() => {
        if (sharedDb === opening) sharedDb = null;
      });
    }
    return sharedDb;
  }

  /** Test/advanced entry point — wrap an already-migrated DatabaseService. */
  static from(db: DatabaseService): VocabularyDb {
    return new VocabularyDb(db);
  }

  async checkpoint(): Promise<void> {
    await this.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  async close(): Promise<void> {
    try {
      await this.checkpoint();
    } catch {
      // best-effort — a checkpoint failure must not block close
    }
    await this.db.close();
    sharedDb = null;
  }

  /**
   * Save (or refresh) a word. Same word (case-insensitive): refresh the
   * definition snapshot when the new lookup produced entries, and append the
   * context if it comes from a new (book, cfi) pair — same pair refreshes.
   */
  async saveWord(input: SaveVocabularyInput): Promise<VocabularyWordDetail> {
    const now = Date.now();
    const word = input.word.trim();
    const wordKey = word.toLowerCase();
    const existing = await this.db.select<{ id: string }>(
      `SELECT id FROM vocabulary WHERE word_key = ? LIMIT 1`,
      [wordKey],
    );

    let wordId = existing[0]?.id;
    if (!wordId) {
      wordId = uuidv4();
      await this.db.execute(
        `INSERT INTO vocabulary (id, word, word_key, lang, definitions, primary_index, last_book_title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          wordId,
          word,
          wordKey,
          input.lang,
          JSON.stringify(input.definitions),
          input.context ? input.context.bookTitle : null,
          now,
          now,
        ],
      );
    } else {
      if (input.definitions.length > 0) {
        // Keep the user's primary choice when it still points at a loaded
        // entry of the new snapshot; otherwise fall back to the first.
        const current = await this.db.select<{ primary_index: number }>(
          `SELECT primary_index FROM vocabulary WHERE id = ?`,
          [wordId],
        );
        const prevPrimary = current[0]?.primary_index ?? 0;
        const clamped = prevPrimary < input.definitions.length ? prevPrimary : 0;
        await this.db.execute(
          `UPDATE vocabulary SET definitions = ?, primary_index = ? WHERE id = ?`,
          [JSON.stringify(input.definitions), clamped, wordId],
        );
      }
      await this.db.execute(
        `UPDATE vocabulary SET lang = COALESCE(?, lang),
           last_book_title = COALESCE(?, last_book_title), updated_at = ? WHERE id = ?`,
        [input.lang, input.context ? input.context.bookTitle : null, now, wordId],
      );
    }

    if (input.context) {
      await this.db.execute(
        `INSERT INTO vocabulary_contexts (id, word_id, book_hash, book_title, cfi, sentence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(word_id, book_hash, cfi)
         DO UPDATE SET sentence = excluded.sentence, book_title = excluded.book_title, created_at = excluded.created_at`,
        [
          uuidv4(),
          wordId,
          input.context.bookHash,
          input.context.bookTitle,
          input.context.cfi || '',
          input.context.sentence,
          now,
        ],
      );
    }

    const detail = await this.getWord(wordId);
    if (!detail) throw new Error(`vocabulary word disappeared after save: ${wordId}`);
    return detail;
  }

  async listWords(options: ListVocabularyOptions = {}): Promise<VocabularyWord[]> {
    const { query, bookHash, limit = 200, offset = 0 } = options;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query && query.trim()) {
      const like = `%${escapeLike(query.trim())}%`;
      where.push(
        `(vocabulary.word LIKE ? ESCAPE '\\' OR vocabulary.definitions LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like);
    }
    if (bookHash) {
      where.push(
        `EXISTS (SELECT 1 FROM vocabulary_contexts c WHERE c.word_id = vocabulary.id AND c.book_hash = ?)`,
      );
      params.push(bookHash);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const rows = await this.db.select<WordRow>(
      `SELECT vocabulary.*,
         (SELECT COUNT(*) FROM vocabulary_contexts c WHERE c.word_id = vocabulary.id) AS context_count,
         (SELECT GROUP_CONCAT(DISTINCT c.book_hash) FROM vocabulary_contexts c WHERE c.word_id = vocabulary.id) AS book_hashes
       FROM vocabulary
       ${whereSql}
       ORDER BY vocabulary.updated_at DESC
       LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map(toWord);
  }

  async getWord(id: string): Promise<VocabularyWordDetail | null> {
    const rows = await this.db.select<WordRow>(
      `SELECT vocabulary.*,
         (SELECT COUNT(*) FROM vocabulary_contexts c WHERE c.word_id = vocabulary.id) AS context_count,
         (SELECT GROUP_CONCAT(DISTINCT c.book_hash) FROM vocabulary_contexts c WHERE c.word_id = vocabulary.id) AS book_hashes
       FROM vocabulary WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!rows[0]) return null;
    const contexts = await this.db.select<ContextRow>(
      `SELECT * FROM vocabulary_contexts WHERE word_id = ? ORDER BY created_at DESC`,
      [id],
    );
    return { ...toWord(rows[0]), contexts: contexts.map(toContext) };
  }

  async setPrimaryDefinition(id: string, index: number): Promise<void> {
    await this.db.execute(`UPDATE vocabulary SET primary_index = ?, updated_at = ? WHERE id = ?`, [
      index,
      Date.now(),
      id,
    ]);
  }

  async deleteWord(id: string): Promise<void> {
    await this.db.execute(`DELETE FROM vocabulary_contexts WHERE word_id = ?`, [id]);
    await this.db.execute(`DELETE FROM vocabulary WHERE id = ?`, [id]);
  }

  /** Source books for the filter dropdown, most recently captured first. */
  async listSourceBooks(): Promise<VocabularySourceBook[]> {
    const rows = await this.db.select<DatabaseRow>(
      `SELECT book_hash, book_title, COUNT(*) AS count, MAX(created_at) AS latest
       FROM vocabulary_contexts GROUP BY book_hash ORDER BY latest DESC`,
    );
    return rows.map((r) => ({
      bookHash: String(r['book_hash']),
      bookTitle: String(r['book_title']),
      count: Number(r['count']),
    }));
  }
}
