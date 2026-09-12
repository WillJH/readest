/**
 * Wire envelopes + PURE merge policies for the account-level config
 * artifacts the file channel syncs under Readest/config/. Mirrors the
 * philosophy of wire.ts/merge.ts: everything here is transport-agnostic,
 * side-effect free, and independently unit-testable.
 *
 * Convergence model: every artifact is a single JSON document a peer owns
 * in full (state-based CRDT). Pull = merge remote into local, push = write
 * the merged superset — a lost intermediate write costs nothing because the
 * next run re-merges.
 *
 *   - settings  → per-field LWW on the `clocks` map (dot-path keyed).
 *   - vocabulary→ per-word upsert via the existing saveWord merge
 *                 semantics (contexts unioned by (book, cfi)) + a
 *                 remove-wins tombstone map.
 *   - stats     → append-only event set; union is idempotent because
 *                 page events key on (book, page, start_time) with
 *                 max-duration conflict resolution in SQLite.
 *   - chats     → per-conversation LWW on updatedAt + per-message union
 *                 by id + a remove-wins tombstone map.
 *   - textures  → per-texture LWW on downloadedAt + tombstones; binaries
 *                 keyed by contentId are immutable so a size-probe makes
 *                 re-uploads a no-op.
 */
import type { AIConversation, AIMessage } from '@/services/ai/types';
import type { PageStatEvent, StatBook } from '@/types/statistics';
import type { CipherEnvelope } from '@/types/replica';

const DOC_SCHEMA_VERSION = 1;

/** Common envelope every config artifact carries. */
export interface ConfigDocEnvelope {
  schemaVersion: 1;
  /** Device that last wrote the doc — diagnostics only, never branched on. */
  deviceId: string;
  updatedAt: number;
}

/**
 * A secret slot on the settings doc: the cipher envelope plus whether the
 * plaintext was a plain string or a JSON-encoded structure (arrays/objects
 * like aiMcpServers[].headers). The replica crypto middleware only ever
 * sees strings; this fork needs the richer shape, so the discriminator
 * travels with the envelope.
 */
export interface SecretSlot {
  $cipher: CipherEnvelope;
  /** true → plaintext was JSON.stringify-ed before encryption. */
  $json: boolean;
}

export const isSecretSlot = (v: unknown): v is SecretSlot =>
  typeof v === 'object' && v !== null && typeof (v as SecretSlot).$cipher === 'object';

/**
 * Readest/config/settings.json — a flat dot-path field map with per-field
 * LWW clocks. Paths are the union of the replica SETTINGS_WHITELIST and
 * the AI/OPDS/ABS additions this fork syncs (see settingsFileSync).
 */
export interface RemoteSettingsDoc extends ConfigDocEnvelope {
  /** dot-path → plaintext value or SecretSlot (whitelist paths only). */
  fields: Record<string, unknown>;
  /** dot-path → last-writer wall clock (millis). */
  clocks: Record<string, number>;
}

/** The last-synced view a device keeps locally to detect its own edits. */
export interface SettingsSyncSnapshot {
  /** dot-path → JSON serialization of the value at last sync. */
  v: Record<string, string>;
  /** dot-path → the clock that shipped at last sync. */
  c: Record<string, number>;
}

export const serializeConfigValue = (v: unknown): string => {
  if (v === undefined) return '';
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};

export interface SettingsMergeInput {
  /** Current local values by dot-path (plaintext). */
  local: Record<string, unknown>;
  /** The remote doc as parsed from the wire (secrets already decrypted). */
  remote: { fields: Record<string, unknown>; clocks: Record<string, number> } | null;
  /** This device's last-synced snapshot. */
  snapshot: SettingsSyncSnapshot;
  now: number;
}

export interface SettingsMergeResult {
  /** Merged field values (plaintext) — apply-remote ∪ local-edits. */
  merged: Record<string, unknown>;
  /** Merged clocks to ship with the doc. */
  clocks: Record<string, number>;
  /**
   * The subset of `merged` that came from the REMOTE side and differs from
   * local — the patch to write into the live settings store. Empty when
   * the remote had nothing newer.
   */
  appliedFromRemote: Record<string, unknown>;
}

/**
 * Per-field LWW against the snapshot. A path is:
 *   - locally changed  → local value wins, clock = max(now, remote clock)
 *   - remotely newer   → remote value wins (goes into appliedFromRemote)
 *   - unchanged both   → keeps snapshot clock (steady state; no echo)
 *
 * Ties keep the local side: a pull that adopts a remote value stores it in
 * the snapshot, so the next merge of the same doc sees equal clocks and
 * stays quiet instead of ping-ponging.
 */
export const mergeSettingsDoc = (input: SettingsMergeInput): SettingsMergeResult => {
  const { local, remote, snapshot, now } = input;
  const paths = new Set([
    ...Object.keys(local),
    ...Object.keys(snapshot.v),
    ...(remote ? Object.keys(remote.fields) : []),
  ]);
  const merged: Record<string, unknown> = {};
  const clocks: Record<string, number> = {};
  const appliedFromRemote: Record<string, unknown> = {};

  for (const path of paths) {
    const hasLocal = path in local;
    const localStr = hasLocal ? serializeConfigValue(local[path]) : '';
    const snapStr = snapshot.v[path];
    const locallyChanged = hasLocal && localStr !== snapStr;

    if (locallyChanged) {
      merged[path] = local[path];
      clocks[path] = Math.max(now, remote?.clocks[path] ?? 0);
      continue;
    }
    const remoteClock = remote?.clocks[path] ?? 0;
    const snapClock = snapshot.c[path] ?? 0;
    const remoteValue = remote?.fields[path];
    const hasRemote = remote ? path in remote.fields : false;
    if (hasRemote && remoteClock > snapClock && remoteValue !== undefined) {
      // Remote advanced beyond what this device last knew → adopt it.
      // (A path the remote DROPPED never reaches this branch: absence is
      // not a tombstone, so a local value the user has survives.)
      merged[path] = remoteValue;
      if (!hasLocal || serializeConfigValue(remoteValue) !== localStr) {
        appliedFromRemote[path] = remoteValue;
      }
      clocks[path] = remoteClock;
      continue;
    }
    if (hasLocal) {
      merged[path] = local[path];
      clocks[path] = snapClock;
    }
  }
  return { merged, clocks, appliedFromRemote };
};

// ── Vocabulary ─────────────────────────────────────────────────────────────

export interface VocabContextWire {
  bookHash: string;
  bookTitle: string;
  cfi: string;
  sentence: string;
}

export interface VocabWordWire {
  wordKey: string;
  word: string;
  lang: string;
  /** Inflected surface forms encountered under the canonical entry. */
  surfaceForms?: string[];
  definitions: unknown[];
  primaryIndex: number;
  lastBookTitle: string | null;
  contexts: VocabContextWire[];
  updatedAt: number;
}

/** Readest/config/vocabulary.json. */
export interface RemoteVocabularyDoc extends ConfigDocEnvelope {
  words: VocabWordWire[];
  /** wordKey → deletion time. Remove-wins against word.updatedAt. */
  deleted: Record<string, number>;
}

// ── Reading stats ──────────────────────────────────────────────────────────

/** Readest/config/stats.json — KOReader-compatible event set. */
export interface RemoteStatsDoc extends ConfigDocEnvelope {
  books: StatBook[];
  events: PageStatEvent[];
}

/** Key an event by its SQLite identity (id_book is derived from bookMd5). */
export const statEventKey = (e: PageStatEvent): string => `${e.bookMd5}:${e.page}:${e.startTime}`;

/** Union two event sets, keeping the max duration per key (SQLite's rule). */
export const mergeStatEvents = (a: PageStatEvent[], b: PageStatEvent[]): PageStatEvent[] => {
  const byKey = new Map<string, PageStatEvent>();
  for (const e of a) byKey.set(statEventKey(e), e);
  for (const e of b) {
    const cur = byKey.get(statEventKey(e));
    if (!cur || e.duration > cur.duration) byKey.set(statEventKey(e), e);
  }
  return Array.from(byKey.values());
};

// ── AI chat history ────────────────────────────────────────────────────────

export interface ChatConversationWire extends AIConversation {
  messages: AIMessage[];
}

/** Readest/config/chats.json. */
export interface RemoteChatsDoc extends ConfigDocEnvelope {
  conversations: ChatConversationWire[];
  /** conversationId → deletion time. Remove-wins against updatedAt. */
  deleted: Record<string, number>;
}

// ── Textures ───────────────────────────────────────────────────────────────

export interface TextureIndexEntry {
  contentId: string;
  name: string;
  filename: string;
  byteSize: number;
  downloadedAt: number;
  deletedAt?: number;
}

/** Readest/config/textures.json — the index over the textures/ binary tree. */
export interface RemoteTexturesDoc extends ConfigDocEnvelope {
  textures: TextureIndexEntry[];
}

/**
 * Union-by-contentId LWW merge for texture index rows. A tombstone wins
 * over any live row with an older clock; a live row never resurrects a
 * newer tombstone (re-import mints a fresh contentId, mirroring the
 * replica reincarnation model).
 */
export const mergeTextureIndexes = (
  local: TextureIndexEntry[],
  remote: TextureIndexEntry[],
): TextureIndexEntry[] => {
  const byId = new Map<string, TextureIndexEntry>();
  for (const t of local) byId.set(t.contentId, t);
  for (const r of remote) {
    const l = byId.get(r.contentId);
    if (!l) {
      byId.set(r.contentId, r);
      continue;
    }
    const lClock = l.deletedAt ?? l.downloadedAt;
    const rClock = r.deletedAt ?? r.downloadedAt;
    byId.set(r.contentId, rClock >= lClock ? r : l);
  }
  return Array.from(byId.values());
};

// ── Crypto salt registry ───────────────────────────────────────────────────

/** One derived-key salt row, byte-compatible with the replica server row. */
export interface RemoteKeyRow {
  saltId: string;
  alg: string;
  /** Base64 salt bytes. Salts are not secret — they foil rainbow tables. */
  salt: string;
}

/** Readest/config/keys.json — the file-channel salt registry. */
export interface RemoteKeysDoc {
  schemaVersion: 1;
  keys: RemoteKeyRow[];
}

// ── Shared parse helper ────────────────────────────────────────────────────

export const parseConfigDoc = <T extends ConfigDocEnvelope>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as T;
    if (!parsed || parsed.schemaVersion !== DOC_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
};
