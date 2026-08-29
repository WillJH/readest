import { describe, it, expect, vi } from 'vitest';

// The sync import chain reaches the auth-gated utils whose module-eval
// crashes in this environment (no Supabase env). The adapter under test is
// pure — stub the chain so it stays testable.
vi.mock('@/utils/supabase', () => ({ supabase: {} }));
vi.mock('@/utils/access', () => ({
  getAccessToken: vi.fn(),
  getUserID: vi.fn(),
}));
vi.mock('@/services/sync/replicaPublish', () => ({
  publishReplicaUpsert: vi.fn(),
  publishReplicaDelete: vi.fn(),
}));
import {
  vocabularyAdapter,
  vocabularyContentId,
  type VocabularyReplicaRecord,
} from '@/services/vocabulary/vocabularySync';
import type { ReplicaRow } from '@/types/replica';

const record: VocabularyReplicaRecord = {
  name: 'Run',
  word: 'Run',
  wordKey: 'run',
  lang: 'en',
  definitions: [{ source: 'Oxford', content: 'to move fast' }],
  primaryIndex: 0,
  lastBookTitle: 'Book One',
  contexts: [{ bookHash: 'h1', bookTitle: 'Book One', cfi: 'cfi/1', sentence: 'She had to run.' }],
  createdAt: 1,
  updatedAt: 2,
};

const rowOf = (fields: Record<string, unknown>): ReplicaRow =>
  ({
    user_id: 'u',
    kind: 'vocabulary',
    replica_id: 'r',
    fields_jsonb: fields,
    manifest_jsonb: null,
    deleted_at_ts: null,
    reincarnation: null,
    updated_at_ts: { ts: 0, ctr: 0, node: 'x' },
    schema_version: 1,
  }) as unknown as ReplicaRow;

describe('vocabularyContentId', () => {
  it('is stable and case/space-insensitive (matches saveWord dedup)', () => {
    expect(vocabularyContentId('Run')).toBe(vocabularyContentId(' run '));
    expect(vocabularyContentId('Run')).toBe(vocabularyContentId('RUN'));
    expect(vocabularyContentId('run')).not.toBe(vocabularyContentId('ran'));
  });
});

describe('vocabularyAdapter round-trip', () => {
  it('pack → unpack preserves the snapshot', () => {
    const packed = vocabularyAdapter.pack(record);
    const unpacked = vocabularyAdapter.unpack(packed);
    expect(unpacked).toEqual(record);
  });

  it('unpackRow reads field envelopes and rejects wordless rows', () => {
    const wrap = (v: unknown) => ({ v });
    const row = rowOf({
      word: wrap('Run'),
      wordKey: wrap('run'),
      lang: wrap('en'),
      definitions: wrap(record.definitions),
      primaryIndex: wrap(0),
      lastBookTitle: wrap('Book One'),
      contexts: wrap(record.contexts),
      createdAt: wrap(1),
      updatedAt: wrap(2),
    });
    expect(vocabularyAdapter.unpackRow(row, '')).toEqual(record);
    expect(vocabularyAdapter.unpackRow(rowOf({ word: wrap('') }), '')).toBeNull();
    expect(vocabularyAdapter.unpackRow(rowOf({}), '')).toBeNull();
  });

  it('computeId derives from the word key', async () => {
    expect(await vocabularyAdapter.computeId(record)).toBe(vocabularyContentId('run'));
  });
});
