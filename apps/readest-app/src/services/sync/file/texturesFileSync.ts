/**
 * Texture backgrounds (背景) + AI character image galleries — the file
 * channel's binary artifacts beyond books.
 *
 * Layout:
 *   Readest/config/textures.json          ← index (per-texture LWW + tombs)
 *   Readest/textures/<contentId>/<file>   ← texture binaries (immutable
 *                                            per contentId → size-probe
 *                                            makes re-uploads a no-op)
 *   Readest/characters/<characterId>/<file> ← avatar/gallery binaries;
 *     the character RECORDS ride the settings doc (aiCharacters), so this
 *     module only mirrors the bytes — index-driven for textures,
 *     settings-driven for characters.
 *
 * Pull policy mirrors the replica flow: adopt the metadata row first
 * (placeholder `unavailable` when the binary can't land yet), then write
 * the binary. Texture rows land in settings.customTextures via the
 * texture store, which already knows how to persist + refresh.
 */
import { v4 as uuidv4 } from 'uuid';
import type { EnvConfigType } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomTextureStore } from '@/store/customTextureStore';
import type { CustomTexture } from '@/styles/textures';
import { getTextureId } from '@/styles/textures';
import { characterImagePath } from '@/services/ai/characterImageService';
import type { FileSyncProvider } from './provider';
import {
  buildTextureBinaryPath,
  buildTexturesIndexPath,
  buildCharacterBinaryPath,
  buildCharacterBinaryDirPath,
  ancestorsOf,
} from './layout';
import {
  mergeTextureIndexes,
  parseConfigDoc,
  type RemoteTexturesDoc,
  type TextureIndexEntry,
} from './configWire';

const HASH_KEY = 'readest_filecfg_textures_hash_v1';

/** Local filename of a texture: last path segment of `<bundleDir>/<filename>`. */
const textureFilename = (t: CustomTexture): string => t.path.split('/').pop() ?? t.path;

const toIndexEntry = (t: CustomTexture): TextureIndexEntry | null => {
  if (!t.contentId) return null; // legacy import — never synced (re-import to opt in)
  return {
    contentId: t.contentId,
    name: t.name,
    filename: textureFilename(t),
    byteSize: t.byteSize ?? 0,
    downloadedAt: t.downloadedAt ?? 0,
    ...(t.deletedAt ? { deletedAt: t.deletedAt } : {}),
  };
};

const hashIndex = (entries: TextureIndexEntry[]): string =>
  entries
    .map((t) => `${t.contentId}:${t.deletedAt ?? t.downloadedAt}:${t.byteSize}`)
    .sort()
    .join('|');

/** Upload bytes unless the remote already holds the exact size. */
const putBinaryIfChanged = async (
  provider: FileSyncProvider,
  path: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<boolean> => {
  let head = null;
  try {
    head = await provider.head(path);
  } catch (err) {
    const e = err as { code?: string };
    if (e?.code !== 'NETWORK') throw err;
  }
  if (head && head.size === bytes.byteLength) return false;
  await provider.ensureDir(ancestorsOf(`${path}/.p`));
  await provider.writeBinary(path, bytes, contentType);
  return true;
};

const guessImageType = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'mp4') return 'video/mp4';
  return 'image/jpeg';
};

export interface TexturesFileSyncResult {
  pushedBinaries: number;
  downloadedBinaries: number;
  pushedIndex: boolean;
}

export const syncTexturesArtifact = async (
  envConfig: EnvConfigType,
  provider: FileSyncProvider,
  deviceId: string,
  options: { strategy: 'silent' | 'send' | 'receive' },
): Promise<TexturesFileSyncResult> => {
  const result: TexturesFileSyncResult = {
    pushedBinaries: 0,
    downloadedBinaries: 0,
    pushedIndex: false,
  };
  const canPull = options.strategy !== 'send';
  const canPush = options.strategy !== 'receive';
  const appService = await envConfig.getAppService();

  const remoteDoc = canPull
    ? parseConfigDoc<RemoteTexturesDoc>(
        await provider.readText(buildTexturesIndexPath(provider.rootPath)),
      )
    : null;

  // ── Pull: adopt remote textures this device doesn't have ──
  if (remoteDoc) {
    const store = useCustomTextureStore.getState();
    for (const entry of remoteDoc.textures) {
      if (entry.deletedAt) continue;
      const existing = store.findByContentId(entry.contentId);
      if (existing && !existing.unavailable) continue;
      if (existing?.deletedAt && existing.deletedAt >= (entry.downloadedAt ?? 0)) continue;

      const localPath = existing?.path ?? `${uuidv4()}/${entry.filename}`;
      let bytes: ArrayBuffer | null = null;
      try {
        bytes = await provider.readBinary(
          buildTextureBinaryPath(provider.rootPath, entry.contentId, entry.filename),
        );
      } catch (err) {
        console.warn('[file-config] texture binary download failed', entry.contentId, err);
      }

      const texture: CustomTexture = {
        ...(existing ?? {}),
        id: existing?.id ?? getTextureId(entry.name),
        name: entry.name,
        path: localPath,
        contentId: entry.contentId,
        bundleDir: localPath.includes('/') ? localPath.split('/')[0] : undefined,
        byteSize: entry.byteSize,
        downloadedAt: entry.downloadedAt,
        deletedAt: undefined,
        unavailable: bytes ? undefined : true,
      };
      if (bytes) {
        try {
          if (texture.bundleDir) await appService.createDir(texture.bundleDir, 'Images', true);
          await appService.writeFile(localPath, 'Images', bytes);
          result.downloadedBinaries += 1;
        } catch (err) {
          console.warn('[file-config] texture binary write failed', entry.contentId, err);
          texture.unavailable = true;
        }
      }
      store.applyRemoteTexture(texture);
    }
    // Propagate remote tombstones: a deleted texture leaves the local shelf.
    for (const entry of remoteDoc.textures) {
      if (!entry.deletedAt) continue;
      const existing = useCustomTextureStore.getState().findByContentId(entry.contentId);
      if (existing && !existing.deletedAt && entry.deletedAt >= (existing.downloadedAt ?? 0)) {
        useCustomTextureStore.getState().softDeleteByContentId(entry.contentId);
      }
    }
  }

  if (!canPush) return result;

  // ── Push: binaries first, index last (the replica ordering rule) ──
  const localTextures = useCustomTextureStore.getState().textures;
  const localEntries = localTextures
    .map(toIndexEntry)
    .filter((e): e is TextureIndexEntry => e !== null);
  const remoteById = new Map((remoteDoc?.textures ?? []).map((t) => [t.contentId, t]));

  for (const entry of localEntries) {
    if (entry.deletedAt) continue;
    const local = localTextures.find((t) => t.contentId === entry.contentId);
    if (!local) continue;
    const remote = remoteById.get(entry.contentId);
    if (remote && !remote.deletedAt && remote.byteSize === entry.byteSize) continue;
    try {
      const file = await appService.openFile(local.path, 'Images');
      const bytes = await file.arrayBuffer();
      const uploaded = await putBinaryIfChanged(
        provider,
        buildTextureBinaryPath(provider.rootPath, entry.contentId, entry.filename),
        bytes,
        guessImageType(entry.filename),
      );
      if (uploaded) result.pushedBinaries += 1;
    } catch (err) {
      console.warn('[file-config] texture binary upload failed', entry.contentId, err);
    }
  }

  const mergedIndex = mergeTextureIndexes(localEntries, remoteDoc?.textures ?? []);
  const hash = hashIndex(mergedIndex);
  if (remoteDoc && hash === localStorage.getItem(HASH_KEY)) return result;

  const doc: RemoteTexturesDoc = {
    schemaVersion: 1,
    deviceId,
    updatedAt: Date.now(),
    textures: mergedIndex,
  };
  await provider.ensureDir(ancestorsOf(buildTexturesIndexPath(provider.rootPath)));
  await provider.writeText(buildTexturesIndexPath(provider.rootPath), JSON.stringify(doc));
  localStorage.setItem(HASH_KEY, hash);
  result.pushedIndex = true;
  return result;
};

// ── Character image galleries ──────────────────────────────────────────────

export interface CharacterImagesSyncResult {
  uploaded: number;
  downloaded: number;
}

/**
 * Mirror character gallery binaries against the settings doc's
 * aiCharacters (records themselves sync via settingsFileSync). Missing
 * local binaries are fetched best-effort; a device without a binary
 * degrades to "no avatar" exactly like the replica placeholder flow.
 */
export const syncCharacterImages = async (
  envConfig: EnvConfigType,
  provider: FileSyncProvider,
  options: { strategy: 'silent' | 'send' | 'receive' },
): Promise<CharacterImagesSyncResult> => {
  const result: CharacterImagesSyncResult = { uploaded: 0, downloaded: 0 };
  const canPull = options.strategy !== 'send';
  const canPush = options.strategy !== 'receive';
  const appService = await envConfig.getAppService();
  const settings: SystemSettings | undefined = useSettingsStore.getState().settings;
  const characters = settings?.aiCharacters ?? [];

  for (const character of characters) {
    if (character.deletedAt) {
      // Tombstoned character → GC its remote gallery (best-effort).
      if (canPush) {
        try {
          await provider.deleteDir(buildCharacterBinaryDirPath(provider.rootPath, character.id));
        } catch {
          // Missing dir is success; anything else is non-fatal here.
        }
      }
      continue;
    }
    for (const image of character.images ?? []) {
      const localRef = characterImagePath(character.id, image.filename);
      const remotePath = buildCharacterBinaryPath(provider.rootPath, character.id, image.filename);
      let hasLocal = false;
      try {
        hasLocal = await appService.exists(localRef, 'Images');
      } catch {
        hasLocal = false;
      }
      if (hasLocal && canPush) {
        try {
          const file = await appService.openFile(localRef, 'Images');
          const bytes = await file.arrayBuffer();
          if (
            await putBinaryIfChanged(provider, remotePath, bytes, guessImageType(image.filename))
          ) {
            result.uploaded += 1;
          }
        } catch (err) {
          console.warn('[file-config] character image upload failed', character.id, err);
        }
      } else if (!hasLocal && canPull) {
        try {
          const bytes = await provider.readBinary(remotePath);
          if (bytes) {
            await appService.createDir(`Characters/${character.id}`, 'Images', true);
            await appService.writeFile(localRef, 'Images', bytes);
            result.downloaded += 1;
          }
        } catch (err) {
          console.warn('[file-config] character image download failed', character.id, err);
        }
      }
    }
  }
  return result;
};
