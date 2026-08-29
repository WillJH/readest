import { FileSystem } from '@/types/system';
import { getFilename } from '@/utils/path';
import { md5, partialMD5 } from '@/utils/md5';
import { uniqueId } from '@/utils/misc';
import { ensureNoMediaMarker } from '@/services/imageService';
import type { AICharacterImage } from './types';

/** Avatars render at ~28–64 px; anything larger is wasted bytes in settings-bound storage. */
const MAX_DIMENSION = 512;

export const CHARACTER_IMAGES_DIR = 'Characters';

/** What importCharacterImage returns — the caller mints the id/label. */
export type CharacterImageFile = Omit<AICharacterImage, 'id' | 'label'>;

export function characterImagePath(characterId: string, filename: string): string {
  return `${CHARACTER_IMAGES_DIR}/${characterId}/${filename}`;
}

/**
 * Downscale an image to ≤512 px on its longest side (canvas round-trip), so
 * phone photos don't bloat the gallery. Best-effort: when the runtime lacks
 * the image APIs (Node, old webviews) the original bytes pass through.
 */
async function normalizeImage(
  bytes: ArrayBuffer,
  type: string,
): Promise<{ bytes: ArrayBuffer; type: string }> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
      return { bytes, type };
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_DIMENSION && bytes.byteLength < 256 * 1024) {
      bitmap.close();
      return { bytes, type };
    }
    const scale = Math.min(1, MAX_DIMENSION / longest);
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { bytes, type };
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    return { bytes: await blob.arrayBuffer(), type: blob.type };
  } catch (err) {
    console.warn('Character image normalization skipped:', err);
    return { bytes, type };
  }
}

/**
 * Import an image into a character's gallery dir
 * (`Images/Characters/<characterId>/<uniqueId>-<filename>`). Unique prefix
 * keeps same-named files from overwriting each other. Mirrors
 * imageService.importImage (content id = md5(partialMD5|byteSize|filename)).
 */
export async function importCharacterImage(
  fs: FileSystem,
  characterId: string,
  file?: string | File,
): Promise<CharacterImageFile | null> {
  let filename: string;
  let bytes: ArrayBuffer;
  let type: string;

  if (typeof file === 'string') {
    const fileobj = await fs.openFile(file, 'None');
    filename = fileobj.name || getFilename(file);
    type = fileobj.type || 'image/png';
    bytes = await fileobj.arrayBuffer();
  } else if (file) {
    filename = getFilename(file.name);
    type = file.type || 'image/png';
    bytes = await file.arrayBuffer();
  } else {
    return null;
  }

  const normalized = await normalizeImage(bytes, type);
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = normalized.type.includes('webp') ? '.webp' : dot > 0 ? filename.slice(dot) : '.png';
  const storedName = `${uniqueId()}-${stem}${ext}`;
  const path = characterImagePath(characterId, storedName);

  await fs.createDir(`${CHARACTER_IMAGES_DIR}/${characterId}`, 'Images', true);
  await ensureNoMediaMarker(fs);
  await fs.writeFile(path, 'Images', normalized.bytes);

  const stored = await fs.openFile(path, 'Images');
  const partialMd5 = await partialMD5(stored);
  const byteSize = normalized.bytes.byteLength;
  const contentId = md5(`${partialMd5}|${byteSize}|${storedName}`);

  return { filename: storedName, byteSize, contentId };
}

export async function deleteCharacterImage(
  fs: FileSystem,
  characterId: string,
  filename: string,
): Promise<void> {
  try {
    await fs.removeFile(characterImagePath(characterId, filename), 'Images');
  } catch (err) {
    console.warn('Failed to remove character image', filename, err);
  }
}

/** Remove a character's whole gallery dir (character deletion). */
export async function deleteCharacterFiles(fs: FileSystem, characterId: string): Promise<void> {
  try {
    await fs.removeDir(`${CHARACTER_IMAGES_DIR}/${characterId}`, 'Images', true);
  } catch (err) {
    console.warn('Failed to remove character files', characterId, err);
  }
}
