/**
 * The config-sync pass — the account-level counterpart of
 * {@link runFileLibrarySyncPass}. Owns, for every enabled file backend:
 *   - Readest/config/settings.json   (settings + AI config + OPDS/ABS)
 *   - character gallery binaries     (records ride the settings doc)
 *   - Readest/config/vocabulary.json (生词本)
 *   - Readest/config/stats.json      (阅读统计)
 *   - Readest/config/chats.json      (AI 聊天记录)
 *   - textures.json + textures/*     (背景)
 *
 * Runs are serialized process-wide (a library sync and a config sync never
 * interleave on the same provider), each artifact is failure-isolated, and
 * the per-backend strategy ('silent' | 'send' | 'receive') is honoured the
 * same way the library pass honours it. Silent by design: no progress UI,
 * results land in the console + the return value for diagnostics.
 */
import type { EnvConfigType } from '@/services/environment';
import type { TranslationFunc } from '@/hooks/useTranslation';
import { debounce } from '@/utils/debounce';
import { useSettingsStore } from '@/store/settingsStore';
import { getReadyFileSyncBackends } from './runLibrarySync';
import { settingsKeyForBackend } from '@/services/sync/cloudSyncProvider';
import { createFileSyncProvider, type FileSyncBackendKind } from './providerRegistry';
import { isFileSyncCategoryEnabled } from '@/services/sync/channelRouting';
import { syncSettingsArtifact } from './settingsFileSync';
import { syncCharacterImages, syncTexturesArtifact } from './texturesFileSync';
import { syncVocabularyArtifact } from './vocabularyFileSync';
import { syncStatsArtifact } from './statsFileSync';
import { syncChatsArtifact } from './chatsFileSync';

export interface ConfigSyncResult {
  backends: FileSyncBackendKind[];
  settingsPulled: number;
  settingsPushed: boolean;
  vocabularyPulled: number;
  statsPulledEvents: number;
  chatsPulled: number;
  texturesDownloaded: number;
  characterImagesDownloaded: number;
  failures: Array<{ backend: FileSyncBackendKind; artifact: string; message: string }>;
}

let passRunning = false;

/** One artifact runner with per-artifact failure isolation. */
const runArtifact = async (
  result: ConfigSyncResult,
  backend: FileSyncBackendKind,
  artifact: string,
  fn: () => Promise<void>,
): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[file-config] ${backend}/${artifact} failed`, err);
    result.failures.push({ backend, artifact, message });
  }
};

/**
 * Run one config pass across every enabled, ready file backend. Returns a
 * summary (never throws); a null return means "nothing to do" (no backends
 * or a pass already in flight — the caller's debounce retries soon).
 */
export const runFileConfigSyncPass = async (
  envConfig: EnvConfigType,
  _t?: TranslationFunc,
): Promise<ConfigSyncResult | null> => {
  if (passRunning) return null;
  const settings = useSettingsStore.getState().settings;
  const backends = getReadyFileSyncBackends(settings);
  if (backends.length === 0) return null;

  passRunning = true;
  const result: ConfigSyncResult = {
    backends,
    settingsPulled: 0,
    settingsPushed: false,
    vocabularyPulled: 0,
    statsPulledEvents: 0,
    chatsPulled: 0,
    texturesDownloaded: 0,
    characterImagesDownloaded: 0,
    failures: [],
  };

  try {
    for (const kind of backends) {
      const current = useSettingsStore.getState().settings;
      const provider = await createFileSyncProvider(kind, current);
      if (!provider) continue;
      const key = settingsKeyForBackend(kind);
      const strategy = (current[key]?.strategy ?? 'silent') as 'silent' | 'send' | 'receive';
      const deviceId = current[key]?.deviceId ?? 'unknown-device';

      if (isFileSyncCategoryEnabled('settings')) {
        await runArtifact(result, kind, 'settings', async () => {
          const r = await syncSettingsArtifact(envConfig, provider, deviceId, { strategy });
          result.settingsPulled += r.pulled;
          result.settingsPushed = result.settingsPushed || r.pushed;
        });
        await runArtifact(result, kind, 'characters', async () => {
          const r = await syncCharacterImages(envConfig, provider, { strategy });
          result.characterImagesDownloaded += r.downloaded;
        });
      }
      if (isFileSyncCategoryEnabled('texture')) {
        await runArtifact(result, kind, 'textures', async () => {
          const r = await syncTexturesArtifact(envConfig, provider, deviceId, { strategy });
          result.texturesDownloaded += r.downloadedBinaries;
        });
      }
      if (isFileSyncCategoryEnabled('vocabulary')) {
        await runArtifact(result, kind, 'vocabulary', async () => {
          const r = await syncVocabularyArtifact(envConfig, provider, deviceId, { strategy });
          result.vocabularyPulled += r.pulled;
        });
      }
      if (isFileSyncCategoryEnabled('stats')) {
        await runArtifact(result, kind, 'stats', async () => {
          const r = await syncStatsArtifact(envConfig, provider, deviceId, { strategy });
          result.statsPulledEvents += r.pulledEvents;
        });
      }
      // AI chat history has no dedicated category toggle — it rides the
      // AI settings the user asked to sync; keep it one-gated with them.
      if (isFileSyncCategoryEnabled('settings')) {
        await runArtifact(result, kind, 'chats', async () => {
          const r = await syncChatsArtifact(provider, deviceId, { strategy });
          result.chatsPulled += r.pulled;
        });
      }
    }
  } finally {
    passRunning = false;
  }
  return result;
};

/** True while a config pass is executing (UI diagnostics use this). */
export const isConfigSyncRunning = (): boolean => passRunning;

// ── Debounced trigger ──────────────────────────────────────────────────────

/**
 * Fire-and-forget config-sync trigger. ReadingStatsTracker and the config
 * hooks call this on data churn; the quiet window collapses bursts (every
 * page-turn batch, every settings save) into one pass.
 */
const REQUEST_DEBOUNCE_MS = 15_000;
let latestEnv: EnvConfigType | null = null;
const debouncedPass = debounce(() => {
  if (latestEnv) void runFileConfigSyncPass(latestEnv);
}, REQUEST_DEBOUNCE_MS);

export const requestFileConfigSync = (envConfig: EnvConfigType): void => {
  latestEnv = envConfig;
  debouncedPass();
};
