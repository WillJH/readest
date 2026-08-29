import { md5 } from '@/utils/md5';
import { publishReplicaDelete, publishReplicaUpsert } from '@/services/sync/replicaPublish';
import type { ReplicaAdapter } from '@/services/sync/replicaRegistry';
import type { ReplicaLocalRecord } from '@/services/sync/replicaPullAndApply';
import type { FieldsObject, ReplicaRow } from '@/types/replica';
import { unwrap } from '@/services/sync/adapters/helpers';
import type { SaveVocabularyInput, VocabularyWordDetail } from '@/types/vocabulary';

export const VOCABULARY_KIND = 'vocabulary';
export const VOCABULARY_SCHEMA_VERSION = 1;

/**
 * Cross-device identity: the case-folded word itself. Two devices that
 * capture "Run" and "run" converge to one replica row, mirroring the
 * local saveWord dedup key.
 */
export const vocabularyContentId = (wordKey: string): string =>
  md5(`vocab:${wordKey.trim().toLowerCase()}`);

/**
 * The pull-side record. `name` satisfies ReplicaLocalRecord (display name);
 * the rest is the full merged snapshot the receiving device folds into its
 * local vocabulary.db via saveWord (definitions refreshed, contexts
 * unioned by (book, cfi)).
 */
export interface VocabularyReplicaRecord extends ReplicaLocalRecord {
  word: string;
  wordKey: string;
  lang: string | null;
  definitions: SaveVocabularyInput['definitions'];
  primaryIndex: number;
  lastBookTitle: string | null;
  contexts: SaveVocabularyInput['context'] extends infer C | null ? (C | null)[] : never;
  createdAt: number;
  updatedAt: number;
}

function detailToRecord(detail: VocabularyWordDetail): VocabularyReplicaRecord {
  return {
    name: detail.word,
    word: detail.word,
    wordKey: detail.word.trim().toLowerCase(),
    lang: detail.lang,
    definitions: detail.definitions,
    primaryIndex: detail.primaryIndex,
    lastBookTitle: detail.lastBookTitle,
    contexts: detail.contexts.map((c) => ({
      bookHash: c.bookHash,
      bookTitle: c.bookTitle,
      cfi: c.cfi,
      sentence: c.sentence,
    })),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

/** Publish a word's full merged snapshot (fire-and-forget, sync-gated). */
export const publishVocabularyUpsert = (detail: VocabularyWordDetail): void => {
  void publishReplicaUpsert(
    VOCABULARY_KIND,
    detailToRecord(detail),
    vocabularyContentId(detail.word),
  );
};

/** Tombstone by word (remove-wins, same as the local hard delete). */
export const publishVocabularyDelete = (word: string): void => {
  void publishReplicaDelete(VOCABULARY_KIND, vocabularyContentId(word));
};

export const vocabularyAdapter: ReplicaAdapter<VocabularyReplicaRecord> = {
  kind: VOCABULARY_KIND,
  schemaVersion: VOCABULARY_SCHEMA_VERSION,

  pack(record): Record<string, unknown> {
    return {
      word: record.word,
      wordKey: record.wordKey,
      lang: record.lang,
      definitions: record.definitions,
      primaryIndex: record.primaryIndex,
      lastBookTitle: record.lastBookTitle,
      contexts: record.contexts,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  },

  unpack(fields: Record<string, unknown>): VocabularyReplicaRecord {
    const word = String(fields['word'] ?? '');
    return {
      name: word,
      word: word,
      wordKey: String(fields['wordKey'] ?? word.trim().toLowerCase()),
      lang: fields['lang'] === null || fields['lang'] === undefined ? null : String(fields['lang']),
      definitions: Array.isArray(fields['definitions'])
        ? (fields['definitions'] as SaveVocabularyInput['definitions'])
        : [],
      primaryIndex: Number(fields['primaryIndex'] ?? 0),
      lastBookTitle:
        fields['lastBookTitle'] === null || fields['lastBookTitle'] === undefined
          ? null
          : String(fields['lastBookTitle']),
      contexts: Array.isArray(fields['contexts'])
        ? (fields['contexts'] as VocabularyReplicaRecord['contexts'])
        : [],
      createdAt: Number(fields['createdAt'] ?? Date.now()),
      updatedAt: Number(fields['updatedAt'] ?? Date.now()),
    };
  },

  computeId: async (record) => vocabularyContentId(record.wordKey),

  unpackRow(row: ReplicaRow): VocabularyReplicaRecord | null {
    const fields: FieldsObject = row.fields_jsonb;
    const word = unwrap(fields['word']);
    if (typeof word !== 'string' || !word.trim()) return null;
    return vocabularyAdapter.unpack({
      word,
      wordKey: unwrap(fields['wordKey']),
      lang: unwrap(fields['lang']),
      definitions: unwrap(fields['definitions']),
      primaryIndex: unwrap(fields['primaryIndex']),
      lastBookTitle: unwrap(fields['lastBookTitle']),
      contexts: unwrap(fields['contexts']),
      createdAt: unwrap(fields['createdAt']),
      updatedAt: unwrap(fields['updatedAt']),
    });
  },
};
