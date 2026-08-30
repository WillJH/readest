/**
 * Readest/config/settings.json — the file channel's settings artifact.
 *
 * Covers everything the fork moved off the native replica channel:
 *   - the bundled-scalar whitelist (view/read settings, integrations,
 *     WebDAV/S3 connection fields — same list the replica settings row
 *     used, so behavior is continuous for users who had Readest Cloud),
 *   - the AI configuration: provider endpoints/models, the four prompt
 *     levels (global template, standing instructions, per-connection,
 *     per-character persona), connections, MCP servers, characters,
 *   - OPDS catalogs and ABS servers (small arrays, whole-field LWW).
 *
 * Change detection is snapshot-diff (serialize each dot-path, compare with
 * the last-synced serialization) — the same shape as
 * replicaSettingsSync's push-hash, which lets stores keep writing settings
 * without any clock bookkeeping of their own.
 *
 * customFonts / customDictionaries are deliberately absent: they stay on
 * the native replica channel (this fork's routing). customTextures ride
 * their own artifact (textures.json + binaries) because they carry a
 * binary manifest; the settings doc only carries pure metadata.
 */
import type { EnvConfigType } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomOPDSStore } from '@/store/customOPDSStore';
import { useABSServerStore } from '@/store/absServerStore';
import { useCustomDictionaryStore } from '@/store/customDictionaryStore';
import { SETTINGS_WHITELIST } from '@/services/sync/adapters/settings';
import { readPath } from '@/services/sync/adapters/settings';
import { isCredentialsSyncEnabled, isSyncCategoryEnabled } from '@/services/sync/syncCategories';
import type { FileSyncProvider } from './provider';
import { buildSettingsPath, ancestorsOf } from './layout';
import {
  mergeSettingsDoc,
  parseConfigDoc,
  serializeConfigValue,
  isSecretSlot,
  type RemoteSettingsDoc,
  type SettingsSyncSnapshot,
} from './configWire';
import { createFileCryptoSession, decryptSecretValue, encryptSecretValue } from './configCrypto';

/**
 * Dot-paths added on top of the replica whitelist for the file channel.
 * Array fields travel whole (LWW by field clock) — the accepted tradeoff
 * the replica whitelist already documents for its own array fields.
 */
export const FILE_SETTINGS_EXTRA_FIELDS = [
  'aiSettings.provider',
  'aiSettings.ollamaBaseUrl',
  'aiSettings.ollamaModel',
  'aiSettings.ollamaEmbeddingModel',
  'aiSettings.aiGatewayModel',
  'aiSettings.aiGatewayCustomModel',
  'aiSettings.aiGatewayEmbeddingModel',
  'aiSettings.openrouterBaseUrl',
  'aiSettings.openrouterModel',
  'aiSettings.openrouterEmbeddingModel',
  // The prompt levels the user asked to sync: global template + standing
  // instructions live here; per-connection and per-character prompts ride
  // the aiConnections / aiCharacters array fields below.
  'aiSettings.systemPromptTemplate',
  'aiSettings.userInstructions',
  'aiSettings.spoilerProtection',
  'aiSettings.maxContextChunks',
  'aiSettings.indexingMode',
  'aiConnections',
  'aiCharacters',
  'aiMcpServers',
  'opdsCatalogs',
  'absServers',
] as const;

/** Every dot-path the settings doc may carry. */
export const FILE_SETTINGS_FIELDS: readonly string[] = [
  ...SETTINGS_WHITELIST,
  ...FILE_SETTINGS_EXTRA_FIELDS,
];

/** Scalar secret paths (same set the replica channel encrypted). */
const SCALAR_SECRET_PATHS = new Set<string>([
  'kosync.username',
  'kosync.userkey',
  'kosync.password',
  'readwise.accessToken',
  'hardcover.accessToken',
  'webdav.username',
  'webdav.password',
  's3.accessKeyId',
  's3.secretAccessKey',
  'aiSettings.aiGatewayApiKey',
  'aiSettings.openrouterApiKey',
]);

/**
 * Array fields whose ITEMS carry secret members. The array field itself
 * stays one LWW unit; item secrets are wrapped in SecretSlots in place.
 * (kosync/bookorbit customHeaders are object-valued scalars handled by the
 * replica's JSON-string convention — here they go through the generic
 * SecretSlot $json path like every other non-string secret.)
 */
const ARRAY_SECRET_MEMBERS: Record<string, readonly string[]> = {
  aiConnections: ['apiKey'],
  aiMcpServers: ['headers'],
  opdsCatalogs: ['username', 'password'],
  absServers: ['username', 'password', 'accessToken', 'refreshToken'],
};

const OBJECT_SECRET_PATHS = new Set<string>(['kosync.customHeaders', 'bookorbit.customHeaders']);

const SECRET_PATHS_SET = (() => {
  const set = new Set<string>(SCALAR_SECRET_PATHS);
  for (const p of OBJECT_SECRET_PATHS) set.add(p);
  for (const p of Object.keys(ARRAY_SECRET_MEMBERS)) set.add(p);
  return set;
})();

const SNAPSHOT_KEY = 'readest_filecfg_settings_v1';

const loadSnapshot = (): SettingsSyncSnapshot => {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return { v: {}, c: {} };
    const parsed = JSON.parse(raw) as SettingsSyncSnapshot;
    return { v: parsed.v ?? {}, c: parsed.c ?? {} };
  } catch {
    return { v: {}, c: {} };
  }
};

const storeSnapshot = (snap: SettingsSyncSnapshot): void => {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch (err) {
    console.warn('[file-config] settings snapshot persist failed', err);
  }
};

/** Read the current local field map (plaintext, whitelist paths only). */
export const readLocalSettingsFields = (
  settings: SystemSettings,
  enabledCategories: { dictionary: boolean },
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const path of FILE_SETTINGS_FIELDS) {
    if (!enabledCategories.dictionary && path.startsWith('dictionarySettings.')) continue;
    const value = readPath(settings, path);
    if (value !== undefined) out[path] = value;
  }
  return out;
};

/** Encrypt every secret-carrying slot in a field map, in place → new map. */
const encryptSecrets = async (
  fields: Record<string, unknown>,
  encrypt: (v: unknown) => Promise<unknown>,
): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    const members = ARRAY_SECRET_MEMBERS[path];
    if (members && Array.isArray(value)) {
      out[path] = await Promise.all(
        value.map(async (item) => {
          if (typeof item !== 'object' || item === null) return item;
          const clone = { ...item } as Record<string, unknown>;
          for (const member of members) {
            if (clone[member] === undefined || clone[member] === null || clone[member] === '') {
              continue;
            }
            clone[member] = await encrypt(clone[member]);
          }
          return clone;
        }),
      );
      continue;
    }
    if (SECRET_PATHS_SET.has(path)) {
      if (value === undefined || value === null || value === '') continue;
      out[path] = await encrypt(value);
      continue;
    }
    out[path] = value;
  }
  return out;
};

/** Decrypt SecretSlots back to plaintext; undecryptable slots are dropped. */
const decryptSecrets = async (
  fields: Record<string, unknown>,
  decrypt: (v: unknown) => Promise<unknown | null>,
): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    const members = ARRAY_SECRET_MEMBERS[path];
    if (members && Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        if (typeof item !== 'object' || item === null) {
          items.push(item);
          continue;
        }
        const clone = { ...item } as Record<string, unknown>;
        for (const member of members) {
          if (isSecretSlot(clone[member])) {
            const plain = await decrypt(clone[member]);
            if (plain === null) delete clone[member];
            else clone[member] = plain;
          }
        }
        items.push(clone);
      }
      out[path] = items;
      continue;
    }
    if (SECRET_PATHS_SET.has(path)) {
      if (isSecretSlot(value)) {
        const plain = await decrypt(value);
        // null = locked/undecryptable: drop the field so the LOCAL plaintext
        // survives untouched and nothing half-applied reaches the store.
        if (plain !== null) out[path] = plain;
      } else if (value !== undefined && value !== null && value !== '') {
        out[path] = value;
      }
      continue;
    }
    out[path] = value;
  }
  return out;
};

/**
 * Merge a remote patch into the live settings store. Mirrors
 * replicaSettingsSync.mergeSettings (shallow merge + deep merges for the
 * known nested groups) and adds the AI groups the file whitelist carries.
 */
const applySettingsPatch = (
  envConfig: EnvConfigType,
  patch: Record<string, unknown>,
): SystemSettings | null => {
  const { settings, setSettings, saveSettings } = useSettingsStore.getState();
  if (!settings || Object.keys(patch).length === 0) return null;

  const partial = patch as Partial<SystemSettings>;
  const merged: SystemSettings = { ...settings, ...partial };
  const deepMerge = <K extends keyof SystemSettings>(key: K) => {
    const patchGroup = partial[key] as Record<string, unknown> | undefined;
    if (patchGroup && typeof patchGroup === 'object') {
      const current = settings[key] as Record<string, unknown>;
      (merged[key] as Record<string, unknown>) = { ...current, ...patchGroup };
    }
  };
  deepMerge('globalViewSettings');
  deepMerge('globalReadSettings');
  deepMerge('kosync');
  deepMerge('bookorbit');
  deepMerge('readwise');
  deepMerge('hardcover');
  deepMerge('webdav');
  deepMerge('s3');
  deepMerge('dictionarySettings');
  deepMerge('aiSettings');

  setSettings(merged);
  saveSettings(envConfig, merged);

  // The OPDS / ABS / dictionary panels cache their arrays in their own
  // stores; a settings write alone leaves them stale until remount. Refresh
  // the ones the patch touched (best-effort, mirrors the replica apply path).
  if (partial.opdsCatalogs) {
    void useCustomOPDSStore
      .getState()
      .loadCustomOPDSCatalogs(envConfig)
      .catch(() => {});
  }
  if (partial.absServers) {
    void useABSServerStore
      .getState()
      .loadABSServers(envConfig)
      .catch(() => {});
  }
  if (partial.dictionarySettings) {
    useCustomDictionaryStore.getState().applyRemoteDictionarySettings(partial.dictionarySettings);
  }
  return merged;
};

export interface SettingsFileSyncResult {
  pulled: number;
  pushed: boolean;
}

/**
 * One settings artifact pass against one provider. Pull → merge → apply →
 * push-the-merged-state. Secrets only travel when the credentials category
 * is opted in AND the crypto session is unlocked; otherwise they are
 * dropped from the doc (local copies always survive).
 */
export const syncSettingsArtifact = async (
  envConfig: EnvConfigType,
  provider: FileSyncProvider,
  deviceId: string,
  options: { strategy: 'silent' | 'send' | 'receive' },
): Promise<SettingsFileSyncResult> => {
  const result: SettingsFileSyncResult = { pulled: 0, pushed: false };
  const canPull = options.strategy !== 'send';
  const canPush = options.strategy !== 'receive';
  const settings = useSettingsStore.getState().settings;
  if (!settings) return result;

  const crypto = await createFileCryptoSession(provider);
  const credentialsOn = isCredentialsSyncEnabled() && crypto.usable;

  // ── Pull + merge ──
  let remoteDoc: RemoteSettingsDoc | null = null;
  if (canPull) {
    remoteDoc = parseConfigDoc<RemoteSettingsDoc>(
      await provider.readText(buildSettingsPath(provider.rootPath)),
    );
  }
  let remoteForMerge: { fields: Record<string, unknown>; clocks: Record<string, number> } | null =
    null;
  if (remoteDoc) {
    remoteForMerge = {
      clocks: remoteDoc.clocks,
      fields: await decryptSecrets(remoteDoc.fields, (v) => decryptSecretValue(crypto.session, v)),
    };
  }

  const local = readLocalSettingsFields(settings, {
    dictionary: isSyncCategoryEnabled('dictionary'),
  });
  const merge = mergeSettingsDoc({
    local,
    remote: remoteForMerge,
    snapshot: loadSnapshot(),
    now: Date.now(),
  });

  // ── Apply remote wins into the live store ──
  if (Object.keys(merge.appliedFromRemote).length > 0) {
    const patched = applySettingsPatch(envConfig, merge.appliedFromRemote);
    if (patched) result.pulled = Object.keys(merge.appliedFromRemote).length;
  }

  // ── Push the merged state when it differs from the wire ──
  if (canPush && remoteDoc) {
    const mergedAlreadyOnWire =
      Object.keys(merge.merged).length === Object.keys(remoteForMerge?.fields ?? {}).length &&
      Object.entries(merge.merged).every(
        ([path, value]) =>
          path in (remoteForMerge?.fields ?? {}) &&
          serializeConfigValue(remoteForMerge?.fields?.[path]) === serializeConfigValue(value),
      );
    if (mergedAlreadyOnWire && clocksEqual(merge.clocks, remoteDoc.clocks)) {
      // Nothing to add — still refresh the snapshot so our local edits
      // (already reflected in the doc) don't re-diff as changes.
      const mergedSettings = useSettingsStore.getState().settings ?? settings;
      const refreshed = readLocalSettingsFields(mergedSettings, {
        dictionary: isSyncCategoryEnabled('dictionary'),
      });
      storeSnapshot(buildSnapshot(refreshed, merge.clocks));
      return result;
    }
  }

  // Snapshot BEFORE pushing the doc that contains secret slots: secrets are
  // compared pre-encryption, so the snapshot stores the plaintext value the
  // device last shipped (never leaves localStorage).
  storeSnapshot(buildSnapshot(merge.merged, merge.clocks));

  if (canPush) {
    const fields = credentialsOn
      ? await encryptSecrets(merge.merged, (v) => encryptSecretValue(crypto.session, v))
      : await stripSecrets(merge.merged);
    const doc: RemoteSettingsDoc = {
      schemaVersion: 1,
      deviceId,
      updatedAt: Date.now(),
      fields,
      clocks: merge.clocks,
    };
    await provider.ensureDir(ancestorsOf(buildSettingsPath(provider.rootPath)));
    await provider.writeText(buildSettingsPath(provider.rootPath), JSON.stringify(doc));
    result.pushed = true;
  }
  return result;
};

const buildSnapshot = (
  fields: Record<string, unknown>,
  clocks: Record<string, number>,
): SettingsSyncSnapshot => {
  const v: Record<string, string> = {};
  for (const [path, value] of Object.entries(fields)) {
    v[path] = serializeConfigValue(value);
  }
  return { v, c: { ...clocks } };
};

const clocksEqual = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  }
  return true;
};

/** Credentials opted out: drop every secret path before the doc ships. */
const stripSecrets = async (fields: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    if (SECRET_PATHS_SET.has(path)) continue;
    const members = ARRAY_SECRET_MEMBERS[path];
    if (members && Array.isArray(value)) {
      out[path] = value.map((item) => {
        if (typeof item !== 'object' || item === null) return item;
        const clone = { ...item } as Record<string, unknown>;
        for (const member of members) delete clone[member];
        return clone;
      });
      continue;
    }
    out[path] = value;
  }
  return out;
};
