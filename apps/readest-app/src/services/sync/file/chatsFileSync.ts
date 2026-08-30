/**
 * Readest/config/chats.json — the AI chat-history artifact.
 *
 * The RAG index and chunk store stay device-local (they are derived data,
 * rebuildable from the book); only the conversations + messages travel.
 * Merge: per-conversation LWW on updatedAt, messages unioned by id (they
 * are append-only), and a remove-wins tombstone map for deletions — the
 * same shape as the vocabulary artifact.
 */
import { aiStore } from '@/services/ai/storage/aiStore';
import type { FileSyncProvider } from './provider';
import { buildChatsPath, ancestorsOf } from './layout';
import { parseConfigDoc, type ChatConversationWire, type RemoteChatsDoc } from './configWire';

const TOMBSTONE_KEY = 'readest_filecfg_chat_tombstones_v1';
const HASH_KEY = 'readest_filecfg_chats_hash_v1';
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
    localStorage.setItem(
      TOMBSTONE_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(0, MAX_TOMBSTONES))),
    );
  } catch (err) {
    console.warn('[file-config] chat tombstone persist failed', err);
  }
};

/**
 * Record a local conversation deletion — called by the chat store's
 * deleteConversation so removals propagate to peers.
 */
export const recordChatDeletion = (conversationId: string): void => {
  const map = loadTombstones();
  map[conversationId] = Date.now();
  storeTombstones(map);
};

const buildLocalDoc = async (): Promise<{ conversations: ChatConversationWire[] }> => {
  const [conversations, messages] = await Promise.all([
    aiStore.getAllConversations(),
    aiStore.getAllMessages(),
  ]);
  const byConversation = new Map<string, ChatConversationWire>(
    conversations.map((c) => [c.id, { ...c, messages: [] }]),
  );
  for (const m of messages) {
    byConversation.get(m.conversationId)?.messages.push(m);
  }
  for (const conv of byConversation.values()) {
    conv.messages.sort((a, b) => a.createdAt - b.createdAt);
  }
  return { conversations: Array.from(byConversation.values()) };
};

const hashDoc = (
  conversations: ChatConversationWire[],
  tombstones: Record<string, number>,
): string => {
  const parts = conversations.map((c) => `${c.id}:${c.updatedAt}:${c.messages.length}`).sort();
  const tomb = Object.entries(tombstones)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`);
  return [...parts, ...tomb].join('|');
};

export interface ChatsFileSyncResult {
  pulled: number;
  pushed: boolean;
}

export const syncChatsArtifact = async (
  provider: FileSyncProvider,
  deviceId: string,
  options: { strategy: 'silent' | 'send' | 'receive' },
): Promise<ChatsFileSyncResult> => {
  const result: ChatsFileSyncResult = { pulled: 0, pushed: false };
  const canPull = options.strategy !== 'send';
  const canPush = options.strategy !== 'receive';

  const local = await buildLocalDoc();
  const localById = new Map(local.conversations.map((c) => [c.id, c]));
  const tombstones = loadTombstones();

  let remoteDoc: RemoteChatsDoc | null = null;
  if (canPull) {
    remoteDoc = parseConfigDoc<RemoteChatsDoc>(
      await provider.readText(buildChatsPath(provider.rootPath)),
    );
  }

  // ── Apply remote state ──
  if (remoteDoc) {
    for (const [id, deletedAt] of Object.entries(remoteDoc.deleted ?? {})) {
      if (localById.has(id) && deletedAt > (localById.get(id)!.updatedAt ?? 0)) {
        await aiStore.deleteConversation(id).catch((err) => {
          console.warn('[file-config] chat delete apply failed', id, err);
        });
        localById.delete(id);
        result.pulled += 1;
      }
      if (!tombstones[id] || deletedAt > tombstones[id]!) tombstones[id] = deletedAt;
    }
    for (const remote of remoteDoc.conversations) {
      if (tombstones[remote.id] && tombstones[remote.id]! > remote.updatedAt) continue;
      const localConv = localById.get(remote.id);
      if (localConv) {
        // Union messages by id; LWW the conversation meta on updatedAt.
        const localMsgIds = new Set(localConv.messages.map((m) => m.id));
        let added = 0;
        if (remote.updatedAt > localConv.updatedAt) {
          await aiStore.saveConversation({
            id: remote.id,
            bookHash: remote.bookHash,
            title: remote.title,
            characterId: remote.characterId,
            createdAt: remote.createdAt,
            updatedAt: remote.updatedAt,
          });
        }
        for (const m of remote.messages) {
          if (localMsgIds.has(m.id)) continue;
          await aiStore.saveMessage(m);
          added += 1;
        }
        if (added > 0) result.pulled += 1;
      } else {
        await aiStore.saveConversation({
          id: remote.id,
          bookHash: remote.bookHash,
          title: remote.title,
          characterId: remote.characterId,
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
        });
        for (const m of remote.messages) await aiStore.saveMessage(m);
        result.pulled += 1;
      }
    }
  }

  if (!canPush) return result;

  const mergedConversations =
    result.pulled > 0 || !remoteDoc ? (await buildLocalDoc()).conversations : local.conversations;
  const mergedHash = hashDoc(mergedConversations, tombstones);
  if (remoteDoc && mergedHash === localStorage.getItem(HASH_KEY)) {
    return result;
  }

  // Tombstones older than a live conversation are spent — the conversation
  // was re-created and legitimately returned.
  const shippedTombstones: Record<string, number> = {};
  for (const [id, at] of Object.entries(tombstones)) {
    const live = mergedConversations.find((c) => c.id === id);
    if (live && live.updatedAt >= at) continue;
    shippedTombstones[id] = at;
  }
  storeTombstones(tombstones);

  const doc: RemoteChatsDoc = {
    schemaVersion: 1,
    deviceId,
    updatedAt: Date.now(),
    conversations: mergedConversations,
    deleted: shippedTombstones,
  };
  await provider.ensureDir(ancestorsOf(buildChatsPath(provider.rootPath)));
  await provider.writeText(buildChatsPath(provider.rootPath), JSON.stringify(doc));
  localStorage.setItem(HASH_KEY, mergedHash);
  result.pushed = true;
  return result;
};
