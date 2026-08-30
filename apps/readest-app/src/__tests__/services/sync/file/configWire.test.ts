import { describe, expect, test } from 'vitest';
import {
  buildChatsPath,
  buildCharacterBinaryDirPath,
  buildCharacterBinaryPath,
  buildKeysPath,
  buildSettingsPath,
  buildStatsPath,
  buildTextureBinaryPath,
  buildTexturesIndexPath,
  buildVocabularyPath,
} from '@/services/sync/file/layout';
import {
  FILE_EXCLUSIVE_CATEGORIES,
  isNativeSyncCategoryEnabled,
} from '@/services/sync/channelRouting';
import {
  mergeSettingsDoc,
  mergeStatEvents,
  mergeTextureIndexes,
  serializeConfigValue,
} from '@/services/sync/file/configWire';
import { buildRemotePayload, parseRemotePayload } from '@/services/sync/file/wire';
import { mergeBookConfig } from '@/services/sync/file/merge';
import type { PageStatEvent } from '@/types/statistics';
import type { Book, BookConfig } from '@/types/book';

describe('per-book view settings (device-local: font size and layout differ per screen)', () => {
  const book = { hash: 'h1', title: 'T', format: 'EPUB', updatedAt: 1 } as unknown as Book;
  const config = {
    progress: 0.5,
    updatedAt: 100,
    booknotes: [],
    viewSettings: { fontSize: 18, referencePageCount: 350 },
  } as unknown as BookConfig;

  test('viewSettings never travels — only referencePageCount crosses devices', () => {
    const raw = JSON.stringify(buildRemotePayload(book, config, 'dev-1'));
    const p = parseRemotePayload(raw)!;
    expect('viewSettings' in p.config).toBe(false);
    expect('viewSettings' in p).toBe(false);
    expect(p.referencePageCount).toBe(350);
  });

  test('a peer viewSettings key (legacy newer-wire doc) is ignored, local object survives', () => {
    const newer = parseRemotePayload(
      JSON.stringify({
        schemaVersion: 1,
        bookHash: 'h1',
        config: { progress: 0.6, updatedAt: 200 },
        booknotes: [],
        viewSettings: { fontSize: 22 },
        writerDeviceId: 'peer',
        writerVersion: 'readest-webdav-1',
        updatedAt: 200,
      }),
    )!;
    const merged = mergeBookConfig(config, newer);
    // Progress adopts the newer remote, but the local typography stays.
    expect(merged.config.progress).toBe(0.6);
    expect(merged.config.viewSettings).toEqual({ fontSize: 18, referencePageCount: 350 });
  });
});

describe('config artifact layout', () => {
  test('all artifacts live under <root>/Readest/config', () => {
    expect(buildSettingsPath('/dav')).toBe('/dav/Readest/config/settings.json');
    expect(buildVocabularyPath('/')).toBe('/Readest/config/vocabulary.json');
    expect(buildStatsPath('/dav/sub')).toBe('/dav/sub/Readest/config/stats.json');
    expect(buildChatsPath('/')).toBe('/Readest/config/chats.json');
    expect(buildTexturesIndexPath('/')).toBe('/Readest/config/textures.json');
    expect(buildKeysPath('/')).toBe('/Readest/config/keys.json');
  });

  test('binary trees are keyed by cross-device ids', () => {
    expect(buildTextureBinaryPath('/', 'cid-1', 'bg.jpg')).toBe('/Readest/textures/cid-1/bg.jpg');
    expect(buildCharacterBinaryPath('/', 'char-9', 'a-1.webp')).toBe(
      '/Readest/characters/char-9/a-1.webp',
    );
    expect(buildCharacterBinaryDirPath('/', 'char-9')).toBe('/Readest/characters/char-9');
  });
});

describe('channel routing', () => {
  test('file-exclusive kinds never pass the native gate', () => {
    for (const kind of [
      'settings',
      'texture',
      'opds_catalog',
      'abs_server',
      'vocabulary',
      'stats',
    ]) {
      expect(FILE_EXCLUSIVE_CATEGORIES.has(kind as never)).toBe(true);
      expect(isNativeSyncCategoryEnabled(kind)).toBe(false);
    }
  });

  test('fonts and dictionaries stay native', () => {
    expect(isNativeSyncCategoryEnabled('font')).toBe(true);
    expect(isNativeSyncCategoryEnabled('dictionary')).toBe(true);
  });
});

describe('mergeSettingsDoc (per-field LWW)', () => {
  const baseSnapshot = {
    v: {
      'aiSettings.systemPromptTemplate': '"You are helpful"',
      opdsCatalogs: '[]',
    },
    c: {
      'aiSettings.systemPromptTemplate': 100,
      opdsCatalogs: 100,
    },
  };

  test('steady state: unchanged fields keep snapshot clocks and adopt nothing', () => {
    const r = mergeSettingsDoc({
      local: {
        'aiSettings.systemPromptTemplate': 'You are helpful',
        opdsCatalogs: [],
      },
      remote: {
        fields: {
          'aiSettings.systemPromptTemplate': 'You are helpful',
          opdsCatalogs: [],
        },
        clocks: { 'aiSettings.systemPromptTemplate': 100, opdsCatalogs: 100 },
      },
      snapshot: baseSnapshot,
      now: 500,
    });
    expect(r.appliedFromRemote).toEqual({});
    expect(r.clocks['aiSettings.systemPromptTemplate']).toBe(100);
  });

  test('local edit wins locally and bumps the clock', () => {
    const r = mergeSettingsDoc({
      local: { 'aiSettings.systemPromptTemplate': 'New prompt' },
      remote: {
        fields: { 'aiSettings.systemPromptTemplate': 'You are helpful' },
        clocks: { 'aiSettings.systemPromptTemplate': 100 },
      },
      snapshot: baseSnapshot,
      now: 500,
    });
    expect(r.merged['aiSettings.systemPromptTemplate']).toBe('New prompt');
    expect(r.clocks['aiSettings.systemPromptTemplate']).toBe(500);
    expect(r.appliedFromRemote).toEqual({});
  });

  test('remote edit on an untouched field is adopted into the patch', () => {
    const r = mergeSettingsDoc({
      local: { opdsCatalogs: [] },
      remote: {
        fields: { opdsCatalogs: [{ id: 'cat-1', name: 'Gutenberg' }] },
        clocks: { opdsCatalogs: 300 },
      },
      snapshot: baseSnapshot,
      now: 500,
    });
    expect(r.appliedFromRemote['opdsCatalogs']).toEqual([{ id: 'cat-1', name: 'Gutenberg' }]);
    expect(r.clocks['opdsCatalogs']).toBe(300);
  });

  test('a field the remote dropped never deletes the local value', () => {
    const r = mergeSettingsDoc({
      local: { opdsCatalogs: [{ id: 'cat-1' }] },
      remote: { fields: {}, clocks: {} },
      snapshot: baseSnapshot,
      now: 500,
    });
    expect(r.merged['opdsCatalogs']).toEqual([{ id: 'cat-1' }]);
  });

  test('serializeConfigValue is stable for objects vs undefined', () => {
    expect(serializeConfigValue(undefined)).toBe('');
    expect(serializeConfigValue({ a: 1 })).toBe('{"a":1}');
    expect(serializeConfigValue([1, 2])).toBe('[1,2]');
  });
});

describe('mergeStatEvents', () => {
  const e = (
    bookMd5: string,
    page: number,
    startTime: number,
    duration: number,
  ): PageStatEvent => ({
    bookMd5,
    page,
    startTime,
    duration,
    totalPages: 300,
  });

  test('unions by (book, page, start) keeping max duration', () => {
    const a = [e('h1', 1, 100, 10), e('h1', 2, 200, 20)];
    const b = [e('h1', 1, 100, 30), e('h1', 3, 300, 5)];
    const merged = mergeStatEvents(a, b);
    expect(merged).toHaveLength(3);
    expect(merged.find((x) => x.page === 1)!.duration).toBe(30);
  });

  test('same events on both sides is idempotent', () => {
    const a = [e('h1', 1, 100, 10)];
    expect(mergeStatEvents(a, [...a])).toHaveLength(1);
  });
});

describe('mergeTextureIndexes', () => {
  test('unions by contentId with LWW on the per-row clock', () => {
    const local = [
      { contentId: 'c1', name: 'Paper', filename: 'p.jpg', byteSize: 10, downloadedAt: 100 },
    ];
    const remote = [
      { contentId: 'c1', name: 'Paper', filename: 'p.jpg', byteSize: 10, downloadedAt: 200 },
    ];
    expect(mergeTextureIndexes(local, remote)[0]!.downloadedAt).toBe(200);
  });

  test('a tombstone beats an older live row and loses to a newer one', () => {
    const local = [
      { contentId: 'c1', name: 'A', filename: 'a.jpg', byteSize: 1, downloadedAt: 100 },
    ];
    const tomb = [
      {
        contentId: 'c1',
        name: 'A',
        filename: 'a.jpg',
        byteSize: 1,
        downloadedAt: 100,
        deletedAt: 150,
      },
    ];
    expect(mergeTextureIndexes(local, tomb)[0]!.deletedAt).toBe(150);
    const revived = [
      { contentId: 'c1', name: 'A', filename: 'a.jpg', byteSize: 2, downloadedAt: 300 },
    ];
    expect(mergeTextureIndexes(tomb, revived)[0]!.deletedAt).toBeUndefined();
  });
});
