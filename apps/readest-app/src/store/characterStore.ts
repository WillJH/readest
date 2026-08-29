import { create } from 'zustand';
import { EnvConfigType } from '@/services/environment';
import { v4 as uuidv4 } from 'uuid';
import { useSettingsStore } from './settingsStore';
import { characterImagePath } from '@/services/ai/characterImageService';
import type { AICharacter, AICharacterImage } from '@/services/ai/types';

interface CharacterState {
  characters: AICharacter[];
  /** imageId → blob URL for rendering (built during load/refresh). */
  imageUrls: Record<string, string>;
  isLoaded: boolean;

  /** Hydrate from settings and materialize every gallery image as a blob URL. */
  loadCharacters: (envConfig: EnvConfigType) => Promise<void>;
  getCharacter: (id?: string) => AICharacter | undefined;
  upsertCharacter: (envConfig: EnvConfigType, character: AICharacter) => Promise<void>;
  /** Hard delete: settings row + gallery files on disk. */
  removeCharacter: (envConfig: EnvConfigType, id: string) => Promise<void>;
  addImage: (
    envConfig: EnvConfigType,
    characterId: string,
    file: string | File,
    label?: string,
  ) => Promise<AICharacterImage | null>;
  removeImage: (envConfig: EnvConfigType, characterId: string, imageId: string) => Promise<void>;
  setDefaultImage: (
    envConfig: EnvConfigType,
    characterId: string,
    imageId: string | undefined,
  ) => Promise<void>;
  renameImageLabel: (
    envConfig: EnvConfigType,
    characterId: string,
    imageId: string,
    label: string,
  ) => Promise<void>;
  getImageUrl: (imageId: string) => string | undefined;
}

function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  return map[ext ?? ''] ?? 'image/png';
}

async function loadImageUrls(envConfig: EnvConfigType, characters: AICharacter[]) {
  const urls: Record<string, string> = {};
  const appService = await envConfig.getAppService();
  await Promise.all(
    characters.flatMap((character) =>
      character.images.map(async (image) => {
        try {
          const file = await appService.openFile(
            characterImagePath(character.id, image.filename),
            'Images',
          );
          const blob = file.type ? file : new Blob([file], { type: mimeFor(image.filename) });
          urls[image.id] = URL.createObjectURL(blob);
        } catch (err) {
          console.warn('Failed to load character image', image.filename, err);
        }
      }),
    ),
  );
  return urls;
}

async function persist(envConfig: EnvConfigType, characters: AICharacter[]) {
  const { settings, setSettings, saveSettings } = useSettingsStore.getState();
  const next = { ...settings, aiCharacters: characters };
  setSettings(next);
  await saveSettings(envConfig, next);
}

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  imageUrls: {},
  isLoaded: false,

  loadCharacters: async (envConfig) => {
    const characters = useSettingsStore.getState().settings?.aiCharacters ?? [];
    const imageUrls = await loadImageUrls(envConfig, characters);
    set({ characters, imageUrls, isLoaded: true });
  },

  getCharacter: (id) =>
    id ? get().characters.find((c) => c.id === id && !c.deletedAt) : undefined,

  upsertCharacter: async (envConfig, character) => {
    const characters = [...get().characters];
    const at = characters.findIndex((c) => c.id === character.id);
    const updated = { ...character, updatedAt: Date.now() };
    if (at >= 0) characters[at] = updated;
    else characters.push(updated);
    set({ characters });
    await persist(envConfig, characters);
  },

  removeCharacter: async (envConfig, id) => {
    const characters = get().characters.filter((c) => c.id !== id);
    set({ characters });
    await persist(envConfig, characters);
    try {
      const appService = await envConfig.getAppService();
      await appService.deleteCharacterFiles(id);
    } catch (err) {
      console.warn('Failed to clean up character files', id, err);
    }
  },

  addImage: async (envConfig, characterId, file, label) => {
    const character = get().characters.find((c) => c.id === characterId);
    if (!character) return null;
    const appService = await envConfig.getAppService();
    const imported = await appService.importCharacterImage(characterId, file);
    if (!imported) return null;
    const stem = imported.filename.replace(/^[^-]+-/, '').replace(/\.[^.]+$/, '');
    const image: AICharacterImage = {
      id: uuidv4(),
      contentId: imported.contentId,
      filename: imported.filename,
      byteSize: imported.byteSize,
      label: (label?.trim() || stem).slice(0, 40),
    };
    const characters = get().characters.map((c) =>
      c.id === characterId
        ? {
            ...c,
            images: [...c.images, image],
            defaultImageId: c.defaultImageId ?? image.id,
            updatedAt: Date.now(),
          }
        : c,
    );
    set({ characters });
    await persist(envConfig, characters);
    // Refresh just this image's blob URL.
    const urls = await loadImageUrls(envConfig, characters);
    set({ imageUrls: urls });
    return image;
  },

  removeImage: async (envConfig, characterId, imageId) => {
    const character = get().characters.find((c) => c.id === characterId);
    const image = character?.images.find((i) => i.id === imageId);
    const characters = get().characters.map((c) =>
      c.id === characterId
        ? {
            ...c,
            images: c.images.filter((i) => i.id !== imageId),
            defaultImageId:
              c.defaultImageId === imageId
                ? (c.images.find((i) => i.id !== imageId)?.id ?? undefined)
                : c.defaultImageId,
            updatedAt: Date.now(),
          }
        : c,
    );
    set({ characters });
    await persist(envConfig, characters);
    const url = get().imageUrls[imageId];
    if (url) {
      URL.revokeObjectURL(url);
      const { [imageId]: _removed, ...rest } = get().imageUrls;
      set({ imageUrls: rest });
    }
    if (image) {
      try {
        const appService = await envConfig.getAppService();
        await appService.deleteCharacterImage(characterId, image.filename);
      } catch (err) {
        console.warn('Failed to delete character image file', image.filename, err);
      }
    }
  },

  setDefaultImage: async (envConfig, characterId, imageId) => {
    const characters = get().characters.map((c) =>
      c.id === characterId ? { ...c, defaultImageId: imageId, updatedAt: Date.now() } : c,
    );
    set({ characters });
    await persist(envConfig, characters);
  },

  renameImageLabel: async (envConfig, characterId, imageId, label) => {
    const trimmed = label.trim().slice(0, 40);
    if (!trimmed) return;
    const characters = get().characters.map((c) =>
      c.id === characterId
        ? {
            ...c,
            images: c.images.map((i) => (i.id === imageId ? { ...i, label: trimmed } : i)),
            updatedAt: Date.now(),
          }
        : c,
    );
    set({ characters });
    await persist(envConfig, characters);
  },

  getImageUrl: (imageId) => get().imageUrls[imageId],
}));
