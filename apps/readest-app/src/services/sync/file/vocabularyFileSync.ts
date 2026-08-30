/**
 * Readest/config/vocabulary.json — the vocabulary (生词本) artifact.
 *
 * Full-state doc: every word with its contexts, plus a remove-wins
 * tombstone map. Pull folds remote words through the SAME saveWord merge
 * the replica channel used (definitions refreshed, contexts unioned by
 * (book, cfi), primary choice preserved) so semantics don't change with
 * the transport. Push ships the merged full state; a content hash of the
 * export skips no-op uploads.
 *
 * Deletions: SQLite rows are hard-deleted locally, so tombstones are kept
 * in a small localStorage log recorded by the delete paths; a tombstone
 * wins over any word whose updatedAt is older (re-capturing the word
 * afterwards stamps a newer updatedAt and it legitimately returns).
 */
import type { EnvConfigType } from '@/services/environment';
import { VocabularyDb } from '@/services/vocabulary/vocabularyDb';
import { useVocabularyStore } from '@/store/vocabularyStore';
import type { FileSyncProvider } from './provider';
import { buildVocabularyPath, ancestorsOf } from './layout';
import { parseConfigDoc, type RemoteVocabularyDoc, type VocabWordWire } from './configWire';

const TOMBSTONE_KEY = 'readest_filecfg_vocab_tombstones_v1';
const HASH_KEY = 'readest_filecfg_vocab_hash_v1';
/** Cap the tombstone log — old deletions of never-synced words are noise. */
const MAX_TOMBSTONES = 2000;

const loadTombstones = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(TOMBSTONE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
};

const storeTombstones = (map: Record<string, number>): void => {
  try {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    const trimmed = Object.fromEntries(entries.slice(0, MAX_TOMBSTONES));
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('[file-config] vocab tombstone persist failed', err);
  }
};

/** Record a local deletion — called by the vocabulary store's remove path. */
export const recordVocabularyDeletion = (wordKey: string): void => {
  const map = loadTombstones();
  map[wordKey.toLowerCase()] = Date.now();
  storeTombstones(map);
};

const exportWords = async (db: VocabularyDb): Promise<VocabWordWire[]> => {
  const all = await db.getAllWords();
  return all.map((w) => ({
    wordKey: w.word.toLowerCase(),
    word: w.word,
    lang: w.lang ?? '',
    definitions: w.definitions,
    primaryIndex: w.primaryIndex,
    lastBookTitle: w.lastBookTitle ?? null,
    contexts: w.contexts.map((c) => ({
      bookHash: c.bookHash,
      bookTitle: c.bookTitle,
      cfi: c.cfi,
      sentence: c.sentence,
    })),
    updatedAt: w.updatedAt,
  }));
};

/** Cheap content hash so an unchanged vocabulary costs no upload. */
const hashWords = (words: VocabWordWire[], tombstones: Record<string, number>): string => {
  const parts = words
    .map((w) => `${w.wordKey}:${w.updatedAt}:${w.contexts.length}:${w.primaryIndex}`)
    .sort();
  const tomb = Object.entries(tombstones)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`);
  return [...parts, ...tomb].join('|');
};

/** Fold one remote word into local SQLite via saveWord's merge. */
const applyRemoteWord = async (db: VocabularyDb, word: VocabWordWire): Promise<void> => {
  await db.saveWord({
    word: word.word,
    lang: word.lang || null,
    definitions: word.definitions as DefinitionSnapshotLike[],
    context: null,
  });
  if (word.contexts.length > 0) {
    // saveWord merges one context per call; fold in the rest the same way
    // the replica apply path did (vocabularyStore.applyRemoteWord).
    for (const context of word.contexts) {
      await db.saveWord({
        word: word.word,
        lang: word.lang || null,
        definitions: [],
        context: {
          bookHash: context.bookHash,
          bookTitle: context.bookTitle,
          cfi: context.cfi,
          sentence: context.sentence,
        },
      });
    }
  }
  const id = await db.findWordIdByKey(word.wordKey);
  if (id !== null && word.primaryIndex > 0) {
    await db.setPrimaryDefinition(id, word.primaryIndex);
  }
};

type DefinitionSnapshotLike = Parameters<VocabularyDb['saveWord']>[0]['definitions'][number];

export interface VocabularyFileSyncResult {
  pulled: number;
  pushed: boolean;
}

export const syncVocabularyArtifact = async (
  envConfig: EnvConfigType,
  provider: FileSyncProvider,
  deviceId: string,
  options: { strategy: 'silent' | 'send' | 'receive' },
): Promise<VocabularyFileSyncResult> => {
  const result: VocabularyFileSyncResult = { pulled: 0, pushed: false };
  const canPull = options.strategy !== 'send';
  const canPush = options.strategy !== 'receive';
  const appService = await envConfig.getAppService();
  const db = await VocabularyDb.open(appService).catch(() => null);
  if (!db) return result;

  const localWords = await exportWords(db);
  const tombstones = loadTombstones();
  const localHash = hashWords(localWords, tombstones);

  let remoteDoc: RemoteVocabularyDoc | null = null;
  if (canPull) {
    remoteDoc = parseConfigDoc<RemoteVocabularyDoc>(
      await provider.readText(buildVocabularyPath(provider.rootPath)),
    );
  }

  // ── Apply remote state ──
  if (remoteDoc) {
    const localByKey = new Map(localWords.map((w) => [w.wordKey, w]));
    // Tombstones first: a deletion newer than the local word's updatedAt
    // removes it before any (older) word row could re-apply.
    for (const [wordKey, deletedAt] of Object.entries(remoteDoc.deleted ?? {})) {
      const local = localByKey.get(wordKey);
      if (local && deletedAt > local.updatedAt) {
        const id = await db.findWordIdByKey(wordKey);
        if (id) {
          await db.deleteWord(id);
          localByKey.delete(wordKey);
          result.pulled += 1;
        }
      }
      // Adopt the remote tombstone so our next push keeps propagating it.
      if (!tombstones[wordKey] || deletedAt > tombstones[wordKey]) {
        tombstones[wordKey] = deletedAt;
      }
    }
    for (const word of remoteDoc.words) {
      if (tombstones[word.wordKey] && tombstones[word.wordKey]! > word.updatedAt) continue;
      const local = localByKey.get(word.wordKey);
      if (
        local &&
        local.updatedAt >= word.updatedAt &&
        local.contexts.length >= word.contexts.length
      ) {
        continue; // nothing the remote knows that we don't
      }
      await applyRemoteWord(db, word).catch((err) => {
        console.warn('[file-config] vocab word apply failed', word.wordKey, err);
      });
      result.pulled += 1;
    }
    // Re-export after applying — the push ships the merged state.
    if (result.pulled > 0) {
      await useVocabularyStore.getState().refreshIfLoaded();
    }
  }

  if (!canPush) return result;

  const mergedWords = result.pulled > 0 || !remoteDoc ? await exportWords(db) : localWords;
  const mergedHash = hashWords(mergedWords, tombstones);
  const lastPushedHash = localStorage.getItem(HASH_KEY);
  if (remoteDoc && mergedHash === lastPushedHash && localHash === mergedHash) {
    return result; // nothing changed locally and the wire is current
  }

  // Drop tombstones older than every occurrence of the word on the wire —
  // they can never win again and only grow the doc.
  const wordClocks = new Map(mergedWords.map((w) => [w.wordKey, w.updatedAt]));
  const shippedTombstones: Record<string, number> = {};
  for (const [key, at] of Object.entries(tombstones)) {
    const liveClock = wordClocks.get(key);
    if (liveClock !== undefined && liveClock >= at) continue; // word returned
    shippedTombstones[key] = at;
  }
  storeTombstones(tombstones);

  const doc: RemoteVocabularyDoc = {
    schemaVersion: 1,
    deviceId,
    updatedAt: Date.now(),
    words: mergedWords,
    deleted: shippedTombstones,
  };
  await provider.ensureDir(ancestorsOf(buildVocabularyPath(provider.rootPath)));
  await provider.writeText(buildVocabularyPath(provider.rootPath), JSON.stringify(doc));
  localStorage.setItem(HASH_KEY, mergedHash);
  result.pushed = true;
  return result;
};
