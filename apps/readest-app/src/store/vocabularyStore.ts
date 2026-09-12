import { create } from 'zustand';
import type { AppService } from '@/types/system';
import type { VocabularyWord } from '@/types/vocabulary';
import { VocabularyDb } from '@/services/vocabulary/vocabularyDb';
import {
  publishVocabularyDelete,
  publishVocabularyUpsert,
  type VocabularyReplicaRecord,
} from '@/services/vocabulary/vocabularySync';
import { recordVocabularyDeletion } from '@/services/sync/file/vocabularyFileSync';
import type { EnvConfigType } from '@/services/environment';

interface VocabularyState {
  words: VocabularyWord[];
  isLoading: boolean;
  /** True once the list has been loaded in this session (guards refreshes). */
  isLoaded: boolean;
  /**
   * Reading position a vocabulary jump displaced, so the return chip can
   * restore it. Cleared on return/dismiss; one slot (latest jump wins).
   */
  jumpedFrom: { bookKey: string; cfi: string; at: number } | null;
  loadWords: (appService: AppService) => Promise<void>;
  /** Reload only if a previous load happened — used after captures. */
  refreshIfLoaded: () => Promise<void>;
  removeWord: (appService: AppService, id: string) => Promise<void>;
  /** Local-only delete for applying a server tombstone — never republishes. */
  removeWordLocal: (id: string) => Promise<void>;
  /**
   * Fold a pulled replica snapshot into the local SQLite via saveWord's
   * merge (definitions refreshed, contexts unioned by (book, cfi)) and
   * refresh the list. Sync-apply path — never republishes.
   */
  applyRemoteWord: (envConfig: EnvConfigType, record: VocabularyReplicaRecord) => Promise<void>;
  /** Persist the primary-definition choice and publish it. */
  setPrimaryAndPublish: (appService: AppService, id: string, index: number) => Promise<void>;
  setJumpedFrom: (from: { bookKey: string; cfi: string }) => void;
  clearJumpedFrom: () => void;
}

/** Last appService used to open the DB, so refreshes don't need to thread it. */
let lastAppService: AppService | null = null;

async function openDb(envConfig: EnvConfigType): Promise<VocabularyDb | null> {
  try {
    const appService = await envConfig.getAppService();
    lastAppService = appService;
    return await VocabularyDb.open(appService);
  } catch (err) {
    console.warn('[vocab-sync] failed to open db:', err);
    return null;
  }
}

export const useVocabularyStore = create<VocabularyState>((set, get) => ({
  words: [],
  isLoading: false,
  isLoaded: false,
  jumpedFrom: null,

  loadWords: async (appService) => {
    set({ isLoading: true });
    try {
      lastAppService = appService;
      const db = await VocabularyDb.open(appService);
      // The store is the source of truth for the notebook list AND for
      // in-text marking + mark clicks — a silent cap would both hide words
      // from the list and leave them unmarked, so load generously rather
      // than stopping at listWords' 200 default.
      const words = await db.listWords({ limit: 5000 });
      set({ words, isLoaded: true });
    } catch (err) {
      console.warn('Failed to load vocabulary words:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  refreshIfLoaded: async () => {
    if (!get().isLoaded || !lastAppService) return;
    await get().loadWords(lastAppService);
  },

  removeWord: async (appService, id) => {
    const word = get().words.find((w) => w.id === id);
    const db = await VocabularyDb.open(appService);
    await db.deleteWord(id);
    set({ words: get().words.filter((w) => w.id !== id) });
    // File-channel tombstone so the removal propagates to peers via
    // config/vocabulary.json (the replica publish below is dormant under
    // the fork's channel routing).
    if (word) recordVocabularyDeletion(word.word);
    if (word) publishVocabularyDelete(word.word);
  },

  removeWordLocal: async (id) => {
    const db = await VocabularyDb.open(require_lastAppService());
    await db.deleteWord(id);
    set({ words: get().words.filter((w) => w.id !== id) });
  },

  applyRemoteWord: async (envConfig, record) => {
    const db = await openDb(envConfig);
    if (!db) return;
    const contexts = record.contexts.filter((c): c is NonNullable<typeof c> => !!c);
    const detail = await db.saveWord({
      word: record.word,
      lang: record.lang,
      definitions: record.definitions,
      context: contexts[0] ?? null,
      surfaceForms: record.surfaceForms,
    });
    // saveWord merges one context per call; fold in the rest.
    for (const context of contexts.slice(1)) {
      await db.saveWord({
        word: record.word,
        lang: record.lang,
        definitions: [],
        context,
        surfaceForms: record.surfaceForms,
      });
    }
    if (record.primaryIndex !== detail.primaryIndex) {
      await db.setPrimaryDefinition(detail.id, record.primaryIndex);
    }
    await get().refreshIfLoaded();
  },

  setPrimaryAndPublish: async (appService, id, index) => {
    const db = await VocabularyDb.open(appService);
    await db.setPrimaryDefinition(id, index);
    const detail = await db.getWord(id);
    await get().refreshIfLoaded();
    if (detail) publishVocabularyUpsert(detail);
  },

  setJumpedFrom: (from) => {
    set({ jumpedFrom: { ...from, at: Date.now() } });
  },

  clearJumpedFrom: () => {
    set({ jumpedFrom: null });
  },
}));

function require_lastAppService(): AppService {
  if (!lastAppService) throw new Error('vocabulary store not loaded yet');
  return lastAppService;
}
