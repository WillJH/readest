/**
 * Readest/config/stats.json — the reading-statistics artifact.
 *
 * Full-state doc of KOReader-compatible page events. Union is idempotent:
 * events key on (bookMd5, page, startTime) with max-duration conflict
 * resolution inside SQLite (`applyRemoteEvents`), so re-applying the whole
 * remote doc costs nothing semantically — a state-based CRDT over an
 * immutable event log. A content hash skips no-op uploads.
 *
 * This replaces the old official-server SyncClient path for stats
 * (ReadingStatsTracker); KOReader/BookOrbit third-party pushes are
 * untouched.
 */
import type { EnvConfigType } from '@/services/environment';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import type { FileSyncProvider } from './provider';
import { buildStatsPath, ancestorsOf } from './layout';
import { mergeStatEvents, parseConfigDoc, type RemoteStatsDoc } from './configWire';

const HASH_KEY = 'readest_filecfg_stats_hash_v1';

export interface StatsFileSyncResult {
  pulledEvents: number;
  pushed: boolean;
}

export const syncStatsArtifact = async (
  envConfig: EnvConfigType,
  provider: FileSyncProvider,
  deviceId: string,
  options: { strategy: 'silent' | 'send' | 'receive' },
): Promise<StatsFileSyncResult> => {
  const result: StatsFileSyncResult = { pulledEvents: 0, pushed: false };
  const canPull = options.strategy !== 'send';
  const canPush = options.strategy !== 'receive';
  const appService = await envConfig.getAppService();
  const db = await StatisticsDb.open(appService).catch(() => null);
  if (!db) return result;

  const { events: localEvents, books: localBooks } = await db.getEventsForPush(0);

  let remoteDoc: RemoteStatsDoc | null = null;
  if (canPull) {
    remoteDoc = parseConfigDoc<RemoteStatsDoc>(
      await provider.readText(buildStatsPath(provider.rootPath)),
    );
  }

  // ── Apply remote events (idempotent union) ──
  if (remoteDoc && remoteDoc.events.length + remoteDoc.books.length > 0) {
    await db.applyRemoteEvents(remoteDoc.books, remoteDoc.events).catch((err) => {
      console.warn('[file-config] stats apply failed', err);
    });
    result.pulledEvents = remoteDoc.events.length;
  }

  if (!canPush) return result;

  // Push the MERGED state: re-export after applying remote, so the doc we
  // ship is the union (state-based convergence — peers re-merge on pull).
  const merged =
    result.pulledEvents > 0
      ? await db.getEventsForPush(0)
      : { events: localEvents, books: localBooks };
  const mergedEvents = mergeStatEvents(merged.events, remoteDoc?.events ?? []);
  // Books map keyed by md5; merged set wins on title (LWW upsert in SQLite).
  const bookByMd5 = new Map(merged.books.map((b) => [b.bookMd5, b]));
  for (const b of remoteDoc?.books ?? []) {
    if (!bookByMd5.has(b.bookMd5)) bookByMd5.set(b.bookMd5, b);
  }

  const hash = `${mergedEvents.length}:${mergedEvents.reduce(
    (acc, e) => acc + e.startTime * 31 + e.duration,
    0,
  )}`;
  if (remoteDoc && hash === localStorage.getItem(HASH_KEY)) {
    return result; // wire already holds exactly what we'd write
  }

  const doc: RemoteStatsDoc = {
    schemaVersion: 1,
    deviceId,
    updatedAt: Date.now(),
    books: Array.from(bookByMd5.values()),
    events: mergedEvents.sort((a, b) => a.startTime - b.startTime),
  };
  await provider.ensureDir(ancestorsOf(buildStatsPath(provider.rootPath)));
  await provider.writeText(buildStatsPath(provider.rootPath), JSON.stringify(doc));
  localStorage.setItem(HASH_KEY, hash);
  result.pushed = true;
  return result;
};
