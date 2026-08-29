import { create } from 'zustand';

/**
 * Which AI message is currently being spoken (wordPronouncer is a single
 * slot — starting a new utterance supersedes the old one, whose callback
 * then never fires, so per-message local state alone would go stale).
 */
interface AiSpeakState {
  speakingId: string | null;
  start: (id: string) => void;
  stop: () => void;
}

export const useAiSpeakStore = create<AiSpeakState>((set) => ({
  speakingId: null,
  start: (id) => set({ speakingId: id }),
  stop: () => set({ speakingId: null }),
}));
