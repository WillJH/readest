import { v4 as uuidv4 } from 'uuid';
import type { AppService } from '@/types/system';
import type { DatabaseService, DatabaseRow } from '@/types/database';
import { canonicalizeWord } from '@/services/vocabulary/morphology';
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
  word_key: string;
  lang: string | null;
  definitions: string;
  primary_index: number;
  surface_forms: string;
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

function parseSurfaceForms(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === 'string' && !!f.trim());
  } catch {
    return [];
  }
}

/** Union of surface forms, lowercased, capped so a runaway entry can't bloat. */
function mergeSurfaceForms(...lists: string[][]): string[] {
  const out: string[] = [];
  for (const form of lists.flat()) {
    const lower = form.trim().toLowerCase();
    if (lower && !out.includes(lower) && out.length < 32) out.push(lower);
  }
  return out;
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
    surfaceForms: parseSurfaceForms(row.surface_forms ?? '[]'),
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
        const instance = new VocabularyDb(db);
        await instance.normalizeLegacyWords();
        return instance;
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
   * Save (or refresh) a word. The input form is first canonicalized
   * (`cats`/`running`/`went` → `cat`/`run`/`go`, see the morphology module);
   * same canonical word (case-insensitive) then follows the original merge:
   * refresh the definition snapshot when the new lookup produced entries,
   * record the inflected surface form, and append the context if it comes
   * from a new (book, cfi) pair — same pair refreshes.
   */
  async saveWord(input: SaveVocabularyInput): Promise<VocabularyWordDetail> {
    const now = Date.now();
    const { canonical, surface, changed } = canonicalizeWord(input.word, input.lang, {
      headword: input.headword ?? null,
    });
    const word = canonical;
    const wordKey = word.toLowerCase();
    // The surface list folds in the caller's forms plus the original shape
    // whenever canonicalization actually changed it.
    const incomingSurfaces = changed
      ? mergeSurfaceForms(input.surfaceForms ?? [], [surface])
      : mergeSurfaceForms(input.surfaceForms ?? []);
    const existing = await this.db.select<Pick<WordRow, 'id' | 'surface_forms'>>(
      `SELECT id, surface_forms FROM vocabulary WHERE word_key = ? LIMIT 1`,
      [wordKey],
    );

    let wordId = existing[0]?.id;
    if (!wordId) {
      wordId = uuidv4();
      await this.db.execute(
        `INSERT INTO vocabulary (id, word, word_key, lang, definitions, primary_index, surface_forms, last_book_title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          wordId,
          word,
          wordKey,
          input.lang,
          JSON.stringify(input.definitions),
          JSON.stringify(incomingSurfaces),
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
      const mergedSurfaces = mergeSurfaceForms(
        parseSurfaceForms(existing[0]?.surface_forms ?? '[]'),
        incomingSurfaces,
      );
      await this.db.execute(
        `UPDATE vocabulary SET lang = COALESCE(?, lang),
           last_book_title = COALESCE(?, last_book_title),
           surface_forms = ?, updated_at = ? WHERE id = ?`,
        [
          input.lang,
          input.context ? input.context.bookTitle : null,
          JSON.stringify(mergedSurfaces),
          now,
          wordId,
        ],
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

  /**
   * Full-state export for file-channel sync: every word with its contexts.
   * Two queries (words, contexts) grouped in memory — the per-word context
   * join would otherwise run once per word at vocabulary scale.
   */
  async getAllWords(): Promise<VocabularyWordDetail[]> {
    const rows = await this.db.select<WordRow>(
      `SELECT vocabulary.*,
         (SELECT COUNT(*) FROM vocabulary_contexts c WHERE c.word_id = vocabulary.id) AS context_count,
         (SELECT GROUP_CONCAT(DISTINCT c.book_hash) FROM vocabulary_contexts c WHERE c.word_id = vocabulary.id) AS book_hashes
       FROM vocabulary ORDER BY vocabulary.word_key ASC`,
    );
    if (rows.length === 0) return [];
    const contexts = await this.db.select<ContextRow & { word_id: string }>(
      `SELECT *, word_id FROM vocabulary_contexts ORDER BY created_at ASC`,
    );
    const byWord = new Map<string, ContextRow[]>();
    for (const c of contexts) {
      const list = byWord.get(c.word_id);
      if (list) list.push(c);
      else byWord.set(c.word_id, [c]);
    }
    return rows.map((row) => ({
      ...toWord(row),
      contexts: (byWord.get(row.id) ?? []).map(toContext),
    }));
  }

  /** Row id for a word key, or null when the word isn't captured locally. */
  async findWordIdByKey(wordKey: string): Promise<string | null> {
    const rows = await this.db.select<{ id: string }>(
      `SELECT id FROM vocabulary WHERE word_key = ? LIMIT 1`,
      [wordKey],
    );
    return rows[0]?.id ?? null;
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

  /**
   * One-time re-canonicalization of legacy rows saved before surface-form
   * capture existed: `cats`/`running` entries collapse into `cat`/`run`
   * (definitions from whichever side has one, contexts unioned, surface forms
   * recorded, timestamps min/max-merged). Deterministic across devices — each
   * device converges on the same canonical state when it upgrades, and
   * file/replica sync paths re-canonicalize on apply anyway. Gated by a
   * `vocabulary_meta` flag so it runs exactly once per database.
   */
  private async normalizeLegacyWords(): Promise<void> {
    try {
      const flag = await this.db.select<{ value: string }>(
        `SELECT value FROM vocabulary_meta WHERE key = ? LIMIT 1`,
        ['canonical_forms_v1'],
      );
      if (flag.length > 0) return;

      const rows = await this.db.select<WordRow>(`SELECT * FROM vocabulary`);
      for (const row of rows) {
        const { canonical, changed } = canonicalizeWord(row.word, row.lang);
        const key = canonical.toLowerCase();
        if (!changed || key === row.word_key) continue;

        const target = await this.db.select<WordRow>(
          `SELECT * FROM vocabulary WHERE word_key = ? AND id <> ? LIMIT 1`,
          [key, row.id],
        );
        const rowSurfaces = mergeSurfaceForms(parseSurfaceForms(row.surface_forms), [row.word]);

        if (target.length === 0) {
          await this.db.execute(
            `UPDATE vocabulary SET word = ?, word_key = ?, surface_forms = ? WHERE id = ?`,
            [canonical, key, JSON.stringify(rowSurfaces), row.id],
          );
          continue;
        }

        const t = target[0]!;
        const targetHasDefs = parseDefinitions(t.definitions).length > 0;
        const rowHasDefs = parseDefinitions(row.definitions).length > 0;
        // Keep the target's snapshot (the user's primary choice indexes it);
        // only adopt the row's when the target has none.
        const definitions = targetHasDefs || !rowHasDefs ? t.definitions : row.definitions;
        const primaryIndex = targetHasDefs ? t.primary_index : 0;
        const surfaces = mergeSurfaceForms(parseSurfaceForms(t.surface_forms), rowSurfaces);
        await this.db.execute(
          `UPDATE vocabulary SET definitions = ?, primary_index = ?,
             lang = COALESCE(?, lang), last_book_title = COALESCE(?, last_book_title),
             surface_forms = ?,
             created_at = MIN(created_at, ?), updated_at = MAX(updated_at, ?)
           WHERE id = ?`,
          [
            definitions,
            primaryIndex,
            row.lang,
            row.last_book_title,
            JSON.stringify(surfaces),
            row.created_at,
            row.updated_at,
            t.id,
          ],
        );
        // Conflicting (book, cfi) pairs stay on the losing row and die with it.
        await this.db.execute(
          `UPDATE OR IGNORE vocabulary_contexts SET word_id = ? WHERE word_id = ?`,
          [t.id, row.id],
        );
        await this.db.execute(`DELETE FROM vocabulary_contexts WHERE word_id = ?`, [row.id]);
        await this.db.execute(`DELETE FROM vocabulary WHERE id = ?`, [row.id]);
      }

      await this.db.execute(`INSERT OR REPLACE INTO vocabulary_meta (key, value) VALUES (?, ?)`, [
        'canonical_forms_v1',
        '1',
      ]);
    } catch (err) {
      // A failed pass must never block opening the vocabulary book; the flag
      // stays unset so a later open retries it.
      console.warn('[vocabulary] legacy normalization failed', err);
    }
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
