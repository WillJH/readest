import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/supabase', () => ({ supabase: {} }));
vi.mock('@/utils/access', () => ({
  getAccessToken: vi.fn(),
  getUserID: vi.fn(),
}));

import { buildAiBackup, parseAiBackup } from '@/services/ai/aiBackup';
import type { SystemSettings } from '@/types/settings';
import type { AICharacter, AIConnection, AIMcpServer } from '@/services/ai/types';

const settings = {
  aiSettings: {
    ragConnectionId: 'c-emb',
    openrouterApiKey: 'sk-secret',
    openrouterBaseUrl: 'https://api.example.com/v1',
    userInstructions: 'Answer in Chinese',
    systemPromptTemplate: 'TPL {{persona}}',
    indexingMode: 'on-demand',
  },
  aiConnections: [
    {
      id: 'c1',
      name: 'Coding Plan',
      provider: 'openrouter',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-conn',
      model: 'big',
      systemPrompt: 'be terse',
      createdAt: 1,
      updatedAt: 1,
    },
  ] satisfies AIConnection[],
  aiMcpServers: [
    {
      id: 'm1',
      name: 'Web Search',
      url: 'https://mcp.example.com',
      headers: ['Authorization: Bearer tok'],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ] satisfies AIMcpServer[],
  aiCharacters: [
    {
      id: 'ch1',
      name: 'Alice',
      prompt: 'strict tutor',
      images: [{ id: 'i1', contentId: 'x', filename: 'a.webp', byteSize: 10, label: 'happy' }],
      defaultImageId: 'i1',
      connectionId: 'c1',
      createdAt: 1,
      updatedAt: 1,
    },
  ] satisfies AICharacter[],
} as unknown as SystemSettings;

const appService = {
  openFile: vi.fn(async () => new File([new Uint8Array([1, 2, 3])], 'a.webp')),
  createDir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
} as never;

describe('buildAiBackup', () => {
  it('embeds avatar bytes and carries prompts', async () => {
    const data = await buildAiBackup(appService, settings, { includeSecrets: true });
    expect(data.type).toBe('readest-ai-backup');
    expect(data.connections[0]!.apiKey).toBe('sk-conn');
    expect(data.mcpServers[0]!.headers).toEqual(['Authorization: Bearer tok']);
    expect(data.aiSettings.systemPromptTemplate).toBe('TPL {{persona}}');
    expect(data.characters[0]!.images[0]!.data).toBeTypeOf('string');
  });

  it('strips secrets when not included', async () => {
    const data = await buildAiBackup(appService, settings, { includeSecrets: false });
    expect(data.connections[0]!.apiKey).toBeUndefined();
    expect(data.mcpServers[0]!.headers).toBeUndefined();
    // The retired global provider config never travels — connections carry
    // it — while the RAG connection reference does survive.
    expect(data.aiSettings.openrouterApiKey).toBeUndefined();
    expect(data.aiSettings.openrouterBaseUrl).toBeUndefined();
    expect(data.aiSettings.ragConnectionId).toBe('c-emb');
  });

  it('round-trips through parseAiBackup', async () => {
    const data = await buildAiBackup(appService, settings, { includeSecrets: true });
    const parsed = parseAiBackup(JSON.stringify(data));
    expect(parsed.connections).toEqual(data.connections);
    expect(parsed.mcpServers).toEqual(data.mcpServers);
    expect(parsed.characters[0]!.images[0]!.data).toBe(data.characters[0]!.images[0]!.data);
    expect(parsed.aiSettings.userInstructions).toBe('Answer in Chinese');
  });
});

describe('parseAiBackup validation', () => {
  it('rejects non-backup payloads with readable messages', () => {
    expect(() => parseAiBackup('not json')).toThrow('Not valid JSON');
    expect(() => parseAiBackup('{}')).toThrow('Not a Readest AI backup file');
    expect(() => parseAiBackup(JSON.stringify({ type: 'readest-ai-backup', version: 99 }))).toThrow(
      /Unsupported backup version/,
    );
  });

  it('drops malformed records and smuggled settings keys instead of failing', () => {
    const parsed = parseAiBackup(
      JSON.stringify({
        type: 'readest-ai-backup',
        version: 1,
        aiSettings: { telemetryEnabled: true, userInstructions: 'keep me' },
        connections: [{ id: 'ok', name: 'Good', provider: 'ollama' }, { name: 'no id' }, 'junk'],
        mcpServers: [{ id: 'm', name: 'M', url: 'u' }],
        characters: [{ id: 'c', name: 'C', images: [{ id: 'i', filename: 'f' }, { id: 'bad' }] }],
      }),
    );
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.characters[0]!.images).toHaveLength(1);
    expect(parsed.aiSettings.userInstructions).toBe('keep me');
    expect(parsed.aiSettings).not.toHaveProperty('telemetryEnabled');
  });
});
