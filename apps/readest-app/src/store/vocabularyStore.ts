import { create } from 'zustand';
import type { AppService } from '@/types/system';
import type { VocabularyWord } from '@/types/vocabulary';
import { VocabularyDb } from '@/services/vocabulary/vocabularyDb';

interface VocabularyState {
  words: VocabularyWord[];
  isLoading: boolean;
  /** True once the list has been loaded in this session (guards refreshes). */
  isLoaded: boolean;
  loadWords: (appService: AppService) => Promise<void>;
  /** Reload only if a previous load happened — used after captures. */
  refreshIfLoaded: () => Promise<void>;
  removeWord: (appService: AppService, id: string) => Promise<void>;
}

/** Last appService used to open the DB, so refreshes don't need to thread it. */
let lastAppService: AppService | null = null;

export const useVocabularyStore = create<VocabularyState>((set, get) => ({
  words: [],
  isLoading: false,
  isLoaded: false,

  loadWords: async (appService) => {
    set({ isLoading: true });
    try {
      lastAppService = appService;
      const db = await VocabularyDb.open(appService);
      const words = await db.listWords();
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
    const db = await VocabularyDb.open(appService);
    await db.deleteWord(id);
    set({ words: get().words.filter((w) => w.id !== id) });
  },
}));
