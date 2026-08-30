/**
 * Transport routing between the two sync channels.
 *
 * The native (Readest Cloud) channel used to own every account-level kind.
 * This fork moves the lightweight, high-churn kinds — app settings (incl.
 * AI config, prompts, characters, OPDS/ABS catalogs), vocabulary, reading
 * stats, and texture binaries — onto the third-party FILE channel
 * (Google Drive / WebDAV / S3 / …), leaving only the heavy, read-mostly
 * binaries (fonts, imported dictionaries) on the native channel.
 *
 * `isNativeSyncCategoryEnabled` is the single predicate the native-channel
 * publishers/pullers must consult: it returns false for every kind in
 * FILE_EXCLUSIVE_CATEGORIES, so those rows never reach the official server
 * even when the user is signed in. The file channel gates on plain
 * `isSyncCategoryEnabled` (the user's own per-category toggles) plus the
 * presence of an enabled file backend.
 *
 * Hard-disable (not "only when a backend is on") is deliberate: the fork's
 * policy is that these kinds NEVER depend on the official account. With no
 * file backend configured they simply stay local.
 */
import { isSyncCategoryEnabled, type SyncCategory } from './syncCategories';

/** Kinds whose only transport is the third-party file channel. */
export const FILE_EXCLUSIVE_CATEGORIES: ReadonlySet<SyncCategory> = new Set([
  'settings',
  'texture',
  'opds_catalog',
  'abs_server',
  'vocabulary',
  'stats',
] as SyncCategory[]);

/** Kinds that keep riding the native Readest Cloud replica channel. */
export const NATIVE_EXCLUSIVE_CATEGORIES: ReadonlySet<SyncCategory> = new Set([
  'font',
  'dictionary',
] as SyncCategory[]);

/**
 * Gate for every native-channel callsite (replica publish, replica pull,
 * the legacy stats SyncClient). False for file-exclusive kinds regardless
 * of the user's category toggle — the official server must never see them.
 */
export const isNativeSyncCategoryEnabled = (id: string): boolean => {
  const category = id as SyncCategory;
  if (FILE_EXCLUSIVE_CATEGORIES.has(category)) return false;
  return isSyncCategoryEnabled(id);
};

/**
 * Gate for file-channel artifacts: the user's category toggle. The presence
 * of an enabled backend is checked separately by the config-sync runner.
 */
export const isFileSyncCategoryEnabled = (id: string): boolean => isSyncCategoryEnabled(id);
