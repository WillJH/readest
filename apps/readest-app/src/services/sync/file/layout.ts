import { Book } from '@/types/book';
import { EXTS } from '@/libs/document';
import { makeSafeFilename } from '@/utils/misc';

/**
 * Layout convention for the "Readest" subtree under the user's configured
 * rootPath, shared by every file-based sync provider (WebDAV today; Google
 * Drive / Dropbox / FTP / SFTP in future). The whole sync feature is scoped
 * to this subtree so we never touch unrelated files in the user's storage.
 *
 * Tree:
 *   <rootPath>/
 *     Readest/
 *       library.json                                 ← shared index
 *       books/
 *         <hash>/
 *           <safe-title>.<ext>                       ← the book file
 *           cover.png                                ← optional
 *           config.json                              ← progress + booknotes
 *
 * Why hash directories: avoids title collisions and makes title edits a
 * pure metadata operation (no remote rename). The friendly file name
 * inside the directory keeps the remote browse experience readable.
 *
 * These builders are pure functions of `rootPath` — no transport knowledge.
 * The directory/file names below are a FROZEN wire layout: changing them
 * would orphan every existing remote tree, so they must stay byte-stable.
 */

export const SYNC_BASE_DIR = 'Readest';
export const SYNC_BOOKS_DIR = 'books';
export const SYNC_LIBRARY_FILE = 'library.json';
export const SYNC_BOOK_CONFIG_FILE = 'config.json';
export const SYNC_BOOK_COVER_FILE = 'cover.png';
// TTS section packs (<section>-<keysfp>.mp3 + .json sidecars) live in a
// per-book subdirectory. Additive to the frozen layout above: older clients
// simply never look inside it.
export const SYNC_BOOK_TTS_DIR = 'tts';

// ── Account-level config artifacts (settings / vocabulary / stats / AI
// chats / textures index / crypto salt registry). These are the kinds this
// fork moved off the native replica channel onto the file channel; each is
// a single root-level JSON document inside Readest/config/, synced with its
// own merge policy. Like the book layout above, names are FROZEN wire
// contract — renaming orphans every existing remote tree.
export const SYNC_CONFIG_DIR = 'config';
export const SYNC_CONFIG_SETTINGS_FILE = 'settings.json';
export const SYNC_CONFIG_VOCABULARY_FILE = 'vocabulary.json';
export const SYNC_CONFIG_STATS_FILE = 'stats.json';
export const SYNC_CONFIG_CHATS_FILE = 'chats.json';
export const SYNC_CONFIG_TEXTURES_FILE = 'textures.json';
export const SYNC_CONFIG_KEYS_FILE = 'keys.json';

// Binary trees for the file channel's non-book assets. Keyed by the
// cross-device content id (md5(partialMD5|byteSize|filename)) so two
// devices importing the same file converge on the same remote path —
// the same idleness contract the replica binary layout provides.
export const SYNC_TEXTURES_DIR = 'textures';
export const SYNC_CHARACTERS_DIR = 'characters';

/**
 * Normalise the user-entered rootPath so the rest of the code can rely on
 * a leading slash and no trailing slash (root = "/").
 */
export const normalizeRoot = (rootPath: string | undefined): string => {
  if (!rootPath) return '/';
  let p = rootPath.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
};

/** Join normalised path segments with single slashes, leading-slash kept. */
const join = (...parts: string[]): string => {
  const cleaned = parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return `/${cleaned.join('/')}`;
};

/** Absolute path of the Readest base directory (where library.json lives). */
export const buildBasePath = (rootPath: string): string =>
  join(normalizeRoot(rootPath), SYNC_BASE_DIR);

/** Absolute path of the per-book directory keyed by hash. */
export const buildBookDirPath = (rootPath: string, bookHash: string): string =>
  join(buildBasePath(rootPath), SYNC_BOOKS_DIR, bookHash);

/** Absolute path of the per-book TTS pack directory. */
export const buildBookTTSDirPath = (rootPath: string, bookHash: string): string =>
  join(buildBookDirPath(rootPath, bookHash), SYNC_BOOK_TTS_DIR);

/** Absolute path of one TTS pack file (or sidecar) inside the tts dir. */
export const buildBookTTSFilePath = (rootPath: string, bookHash: string, name: string): string =>
  join(buildBookTTSDirPath(rootPath, bookHash), name);

/** Absolute path of a book's config.json (progress + booknotes). */
export const buildBookConfigPath = (rootPath: string, bookHash: string): string =>
  join(buildBookDirPath(rootPath, bookHash), SYNC_BOOK_CONFIG_FILE);

/** Absolute path of the shared library.json index. */
export const buildLibraryPath = (rootPath: string): string =>
  join(buildBasePath(rootPath), SYNC_LIBRARY_FILE);

/** Absolute path of one JSON artifact inside Readest/config/. */
export const buildConfigArtifactPath = (rootPath: string, filename: string): string =>
  join(buildBasePath(rootPath), SYNC_CONFIG_DIR, filename);

/** Absolute path of the settings artifact (Readest/config/settings.json). */
export const buildSettingsPath = (rootPath: string): string =>
  buildConfigArtifactPath(rootPath, SYNC_CONFIG_SETTINGS_FILE);

/** Absolute path of the vocabulary artifact. */
export const buildVocabularyPath = (rootPath: string): string =>
  buildConfigArtifactPath(rootPath, SYNC_CONFIG_VOCABULARY_FILE);

/** Absolute path of the reading-stats artifact. */
export const buildStatsPath = (rootPath: string): string =>
  buildConfigArtifactPath(rootPath, SYNC_CONFIG_STATS_FILE);

/** Absolute path of the AI chat-history artifact. */
export const buildChatsPath = (rootPath: string): string =>
  buildConfigArtifactPath(rootPath, SYNC_CONFIG_CHATS_FILE);

/** Absolute path of the texture index artifact. */
export const buildTexturesIndexPath = (rootPath: string): string =>
  buildConfigArtifactPath(rootPath, SYNC_CONFIG_TEXTURES_FILE);

/** Absolute path of the crypto salt registry. */
export const buildKeysPath = (rootPath: string): string =>
  buildConfigArtifactPath(rootPath, SYNC_CONFIG_KEYS_FILE);

/** Absolute path of one texture binary (Readest/textures/<contentId>/<filename>). */
export const buildTextureBinaryPath = (rootPath: string, contentId: string, filename: string) =>
  join(buildBasePath(rootPath), SYNC_TEXTURES_DIR, contentId, filename);

/** Absolute path of one character-gallery binary (Readest/characters/<id>/<filename>). */
export const buildCharacterBinaryPath = (rootPath: string, characterId: string, filename: string) =>
  join(buildBasePath(rootPath), SYNC_CHARACTERS_DIR, characterId, filename);

/** Absolute path of one character's binary directory (for GC deletes). */
export const buildCharacterBinaryDirPath = (rootPath: string, characterId: string) =>
  join(buildBasePath(rootPath), SYNC_CHARACTERS_DIR, characterId);

/**
 * Friendly book file name "<sanitized title>.<ext>" used inside the
 * per-hash directory. Collisions across books are impossible because
 * each book lives in its own hash dir; collisions inside a single
 * hash dir are also impossible because there's only ever one book file.
 *
 * Re-uses readest's existing `makeSafeFilename` so naming rules are
 * consistent with the local on-disk layout (which is `<hash>/<title>.<ext>`).
 */
export const buildBookFileName = (book: Book): string => {
  const ext = EXTS[book.format] || 'bin';
  const baseName = book.sourceTitle || book.title || book.hash;
  return `${makeSafeFilename(baseName)}.${ext}`;
};

/** Absolute path of the book file, including the friendly file name. */
export const buildBookFilePath = (rootPath: string, book: Book): string =>
  join(buildBookDirPath(rootPath, book.hash), buildBookFileName(book));

/** Absolute path of the book cover image. */
export const buildBookCoverPath = (rootPath: string, bookHash: string): string =>
  join(buildBookDirPath(rootPath, bookHash), SYNC_BOOK_COVER_FILE);

/**
 * Walk the parents of an absolute path, top-down, so callers can
 * MKCOL each segment idempotently before writing a file. Excludes the
 * leaf itself.
 *
 * Example: ancestorsOf('/a/b/c/file.json') -> ['/a', '/a/b', '/a/b/c']
 */
export const ancestorsOf = (absolutePath: string): string[] => {
  const segments = absolutePath.split('/').filter(Boolean);
  if (segments.length <= 1) return [];
  const out: string[] = [];
  let acc = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    acc += `/${segments[i]}`;
    out.push(acc);
  }
  return out;
};
