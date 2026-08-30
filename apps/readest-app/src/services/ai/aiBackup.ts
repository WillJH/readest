import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import type { AICharacter, AICharacterImage, AIConnection, AIMcpServer, AISettings } from './types';
import { characterImagePath } from './characterImageService';

export const AI_BACKUP_TYPE = 'readest-ai-backup';
export const AI_BACKUP_VERSION = 1;

/** Character image payload cap — a normalized ≤512px avatar is well under this. */
const MAX_IMAGE_BASE64_LENGTH = 4 * 1024 * 1024;
const MAX_CHARACTERS = 200;
const MAX_IMAGES_PER_CHARACTER = 30;

export interface AiBackupImage extends AICharacterImage {
  /** Base64 of the image bytes; absent for records whose file was unreadable. */
  data?: string;
}

export type AiBackupCharacter = Omit<AICharacter, 'images'> & { images: AiBackupImage[] };

export interface AiBackupData {
  type: string;
  version: number;
  exportedAt: number;
  /** Whitelisted aiSettings keys (secrets only present when requested). */
  aiSettings: Partial<AISettings>;
  connections: AIConnection[];
  mcpServers: AIMcpServer[];
  characters: AiBackupCharacter[];
}

/** aiSettings keys that carry provider secrets — stripped unless requested. */
// The global provider/key config is retired — connections carry it now.
const SECRET_AI_SETTING_KEYS = [] as const;

const NON_SECRET_AI_SETTING_KEYS = [
  'ragConnectionId',
  'spoilerProtection',
  'maxContextChunks',
  'indexingMode',
  'userInstructions',
  'systemPromptTemplate',
] as const;

function abToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToAb(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Assemble the backup document; unreadable avatar files degrade to metadata-only. */
export async function buildAiBackup(
  appService: AppService,
  settings: SystemSettings,
  options: { includeSecrets: boolean },
): Promise<AiBackupData> {
  const aiSettings: Partial<AISettings> = {};
  for (const key of NON_SECRET_AI_SETTING_KEYS) {
    const value = settings.aiSettings?.[key];
    if (value !== undefined) (aiSettings as Record<string, unknown>)[key] = value;
  }
  if (options.includeSecrets) {
    for (const key of SECRET_AI_SETTING_KEYS) {
      const value = settings.aiSettings?.[key];
      if (value !== undefined) (aiSettings as Record<string, unknown>)[key] = value;
    }
  }

  const connections = (settings.aiConnections ?? [])
    .filter((c) => !c.deletedAt)
    .map((c) => ({
      ...c,
      apiKey: options.includeSecrets ? c.apiKey : undefined,
    }));

  const mcpServers = (settings.aiMcpServers ?? [])
    .filter((s) => !s.deletedAt)
    .map((s) => ({
      ...s,
      headers: options.includeSecrets ? s.headers : undefined,
    }));

  const characters: AiBackupCharacter[] = [];
  for (const character of (settings.aiCharacters ?? []).filter((c) => !c.deletedAt)) {
    const images: AiBackupImage[] = [];
    for (const image of character.images) {
      const backupImage: AiBackupImage = { ...image };
      try {
        const file = await appService.openFile(
          characterImagePath(character.id, image.filename),
          'Images',
        );
        backupImage.data = abToBase64(await file.arrayBuffer());
      } catch (err) {
        console.warn(`[ai-backup] image unreadable, exporting metadata only:`, image.filename, err);
      }
      images.push(backupImage);
    }
    characters.push({ ...character, images });
  }

  return {
    type: AI_BACKUP_TYPE,
    version: AI_BACKUP_VERSION,
    exportedAt: Date.now(),
    aiSettings,
    connections,
    mcpServers,
    characters,
  };
}

/**
 * Parse + validate an import document. Throws with a readable message on
 * shape mismatches; unknown fields inside records are dropped by the
 * per-kind pickers below so a hostile file can't smuggle extra settings.
 */
export function parseAiBackup(raw: string): AiBackupData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Not a backup file');
  const data = parsed as Record<string, unknown>;
  if (data['type'] !== AI_BACKUP_TYPE) throw new Error('Not a Readest AI backup file');
  const version = Number(data['version'] ?? 0);
  if (version < 1 || version > AI_BACKUP_VERSION)
    throw new Error(`Unsupported backup version: ${version}`);

  const aiSettingsRaw = (data['aiSettings'] ?? {}) as Record<string, unknown>;
  const aiSettings: Partial<AISettings> = {};
  const allowedSettings = new Set<string>([
    ...NON_SECRET_AI_SETTING_KEYS,
    ...SECRET_AI_SETTING_KEYS,
  ]);
  for (const [key, value] of Object.entries(aiSettingsRaw)) {
    if (allowedSettings.has(key) && value !== undefined) {
      (aiSettings as Record<string, unknown>)[key] = value;
    }
  }

  const pickConnection = (c: Record<string, unknown>): AIConnection | null => {
    const id = typeof c['id'] === 'string' ? c['id'] : '';
    const name = typeof c['name'] === 'string' ? c['name'] : '';
    if (!id || !name) return null;
    return {
      id,
      name,
      provider: (['ollama', 'ai-gateway', 'openrouter'] as const).includes(
        c['provider'] as AIConnection['provider'],
      )
        ? (c['provider'] as AIConnection['provider'])
        : 'openrouter',
      baseUrl: typeof c['baseUrl'] === 'string' ? c['baseUrl'] : undefined,
      apiKey: typeof c['apiKey'] === 'string' ? c['apiKey'] : undefined,
      model: typeof c['model'] === 'string' ? c['model'] : undefined,
      systemPrompt: typeof c['systemPrompt'] === 'string' ? c['systemPrompt'] : undefined,
      embeddingModel: typeof c['embeddingModel'] === 'string' ? c['embeddingModel'] : undefined,
      isDefault: c['isDefault'] === true ? true : undefined,
      createdAt: Number(c['createdAt'] ?? Date.now()),
      updatedAt: Number(c['updatedAt'] ?? Date.now()),
    };
  };

  const pickMcp = (m: Record<string, unknown>): AIMcpServer | null => {
    const id = typeof m['id'] === 'string' ? m['id'] : '';
    const name = typeof m['name'] === 'string' ? m['name'] : '';
    const url = typeof m['url'] === 'string' ? m['url'] : '';
    if (!id || !name || !url) return null;
    return {
      id,
      name,
      url,
      headers: Array.isArray(m['headers'])
        ? m['headers'].filter((h): h is string => typeof h === 'string')
        : undefined,
      enabled: m['enabled'] !== false,
      createdAt: Number(m['createdAt'] ?? Date.now()),
      updatedAt: Number(m['updatedAt'] ?? Date.now()),
    };
  };

  const pickCharacter = (c: Record<string, unknown>): AiBackupCharacter | null => {
    const id = typeof c['id'] === 'string' ? c['id'] : '';
    const name = typeof c['name'] === 'string' ? c['name'] : '';
    if (!id || !name) return null;
    const images: AiBackupImage[] = [];
    const rawImages = Array.isArray(c['images'])
      ? c['images'].slice(0, MAX_IMAGES_PER_CHARACTER)
      : [];
    for (const ri of rawImages) {
      if (typeof ri !== 'object' || ri === null) continue;
      const img = ri as Record<string, unknown>;
      const imgId = typeof img['id'] === 'string' ? img['id'] : '';
      const filename = typeof img['filename'] === 'string' ? img['filename'] : '';
      if (!imgId || !filename) continue;
      const data = typeof img['data'] === 'string' ? img['data'] : undefined;
      if (data && (data.length > MAX_IMAGE_BASE64_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(data))) {
        continue;
      }
      images.push({
        id: imgId,
        contentId: typeof img['contentId'] === 'string' ? img['contentId'] : '',
        filename,
        byteSize: Number(img['byteSize'] ?? 0),
        label: typeof img['label'] === 'string' ? img['label'] : filename,
        ...(data ? { data } : {}),
      });
    }
    return {
      id,
      name,
      prompt: typeof c['prompt'] === 'string' ? c['prompt'] : '',
      images,
      defaultImageId: typeof c['defaultImageId'] === 'string' ? c['defaultImageId'] : undefined,
      connectionId: typeof c['connectionId'] === 'string' ? c['connectionId'] : undefined,
      createdAt: Number(c['createdAt'] ?? Date.now()),
      updatedAt: Number(c['updatedAt'] ?? Date.now()),
    };
  };

  const mapPicking = <T>(rawList: unknown, picker: (r: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(rawList) ? rawList : [])
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map(picker)
      .filter((x): x is T => x !== null);

  return {
    type: AI_BACKUP_TYPE,
    version,
    exportedAt: Number(data['exportedAt'] ?? Date.now()),
    aiSettings,
    connections: mapPicking(data['connections'], pickConnection),
    mcpServers: mapPicking(data['mcpServers'], pickMcp),
    characters: mapPicking(data['characters'], pickCharacter).slice(0, MAX_CHARACTERS),
  };
}

export interface AiBackupApplyResult {
  connections: number;
  mcpServers: number;
  characters: number;
  images: number;
}

/**
 * Apply a parsed backup: write embedded avatar files back to disk, upsert
 * every record by id (re-importing the same file is idempotent), merge the
 * whitelisted aiSettings keys, persist, and refresh the character store.
 */
export async function applyAiBackup(
  appService: AppService,
  envConfig: { getAppService(): Promise<AppService> },
  settings: SystemSettings,
  data: AiBackupData,
): Promise<AiBackupApplyResult> {
  let imagesWritten = 0;
  const characters: AICharacter[] = [];
  for (const character of data.characters) {
    for (const image of character.images) {
      if (!image.data) continue;
      try {
        await appService.createDir(`Characters/${character.id}`, 'Images', true);
        await appService.writeFile(
          characterImagePath(character.id, image.filename),
          'Images',
          base64ToAb(image.data),
        );
        imagesWritten++;
      } catch (err) {
        console.warn('[ai-backup] failed to write image:', image.filename, err);
      }
    }
    characters.push({
      ...character,
      images: character.images.map(({ data: _dropped, ...meta }) => {
        void _dropped;
        return meta;
      }),
    });
  }

  const upsertById = <T extends { id: string }>(list: T[], incoming: T[]): T[] => {
    const next = [...list];
    for (const item of incoming) {
      const at = next.findIndex((x) => x.id === item.id);
      if (at >= 0) next[at] = item;
      else next.push(item);
    }
    return next;
  };

  const nextSettings: SystemSettings = {
    ...settings,
    aiConnections: upsertById(settings.aiConnections ?? [], data.connections),
    aiMcpServers: upsertById(settings.aiMcpServers ?? [], data.mcpServers),
    aiCharacters: upsertById(settings.aiCharacters ?? [], characters),
    aiSettings: { ...settings.aiSettings, ...data.aiSettings },
  };

  const { useSettingsStore } = await import('@/store/settingsStore');
  const store = useSettingsStore.getState();
  store.setSettings(nextSettings);
  await store.saveSettings(envConfig as never, nextSettings);
  const { useCharacterStore } = await import('@/store/characterStore');
  await useCharacterStore.getState().loadCharacters(envConfig as never);

  return {
    connections: data.connections.length,
    mcpServers: data.mcpServers.length,
    characters: characters.length,
    images: imagesWritten,
  };
}
