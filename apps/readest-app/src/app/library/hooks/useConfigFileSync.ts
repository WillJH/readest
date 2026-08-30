import { useEffect, useMemo, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useQuotaStats } from '@/hooks/useQuotaStats';
import { useSettingsStore } from '@/store/settingsStore';
import { debounce } from '@/utils/debounce';
import { getReadyFileSyncBackends } from '@/services/sync/file/runLibrarySync';
import { requestFileConfigSync, runFileConfigSyncPass } from '@/services/sync/file/runConfigSync';

/**
 * Library-scoped auto-sync for the account-level config artifacts
 * (settings/AI/OPDS/ABS, textures, vocabulary, stats, AI chats) on every
 * enabled third-party backend — the config counterpart of
 * {@link useLibraryFileSync}.
 *
 * Triggers:
 *   - once on mount (initial pull after settings load),
 *   - debounced on every settings mutation (prompt edits, connection
 *     changes, texture imports all write settings),
 *   - a slow interval that catches data living outside settings.json
 *     (vocabulary captures, reading events, chat messages) which produce
 *     no settings churn.
 *
 * Vocabulary/stats/chats changes also poke `requestFileConfigSync` from
 * their own writers; this hook's cadence is the safety net, not the only
 * path. All execution + failure isolation lives in runConfigSync.
 */

/** Quiet window for settings-driven passes; collapses edit bursts. */
const SETTINGS_DEBOUNCE_MS = 10_000;
/** Safety-net cadence for non-settings data (vocabulary, stats, chats). */
const INTERVAL_MS = 5 * 60_000;

export const useConfigFileSync = () => {
  const { envConfig } = useEnv();
  const settings = useSettingsStore((s) => s.settings);
  const { userProfilePlan } = useQuotaStats();

  const hasBackends = getReadyFileSyncBackends(settings, userProfilePlan ?? 'free').length > 0;

  const passRef = useRef<() => void>(() => {});
  passRef.current = () => {
    if (envConfig) void runFileConfigSyncPass(envConfig);
  };
  const debouncedSync = useMemo(() => debounce(() => passRef.current(), SETTINGS_DEBOUNCE_MS), []);
  useEffect(() => () => debouncedSync.cancel(), [debouncedSync]);

  // Initial pull + settings-change driven passes.
  useEffect(() => {
    if (!hasBackends || !settings) return;
    debouncedSync();
  }, [settings, hasBackends, debouncedSync]);

  // Interval safety net for data outside settings.json.
  useEffect(() => {
    if (!hasBackends) return;
    const timer = setInterval(() => passRef.current(), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasBackends]);

  // Keep the module-level debounced trigger (used by ReadingStatsTracker)
  // pointed at the live envConfig.
  useEffect(() => {
    if (envConfig) requestFileConfigSync(envConfig);
    // requestFileConfigSync only records the env; the debounce fires later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envConfig]);
};
