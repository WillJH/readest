import { describe, it, expect } from 'vitest';
import {
  getDefaultConnection,
  liveConnections,
  resolveChatSettings,
  resolveCharacterConnection,
  resolveCharacterMcpServers,
  resolveConnectionSettings,
  resolveRagConnection,
  resolveRagSettings,
  userLevelBase,
} from '@/services/ai/connectionSettings';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import type { AICharacter, AIConnection } from '@/services/ai/types';
import type { SystemSettings } from '@/types/settings';

const conn = (over: Partial<AIConnection>): AIConnection => ({
  id: 'c1',
  name: 'Coding Plan',
  provider: 'openrouter',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'big-model',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const sys = (over: {
  connections?: AIConnection[];
  ragConnectionId?: string;
  character?: AICharacter | null;
}): SystemSettings =>
  ({
    aiSettings: {
      ...DEFAULT_AI_SETTINGS,
      ...(over.ragConnectionId ? { ragConnectionId: over.ragConnectionId } : {}),
      // Retired global config must never leak into effective settings.
      openrouterApiKey: 'stale-global-key',
      provider: 'ai-gateway',
    },
    aiConnections: over.connections ?? [],
  }) as unknown as SystemSettings;

describe('connection resolution', () => {
  it('no connections anywhere → everything resolves to null', () => {
    const settings = sys({});
    expect(liveConnections(settings)).toEqual([]);
    expect(getDefaultConnection(settings)).toBeNull();
    expect(resolveCharacterConnection(settings, null)).toBeNull();
    expect(resolveRagConnection(settings)).toBeNull();
  });

  it('the first live connection is the implicit default', () => {
    const a = conn({ id: 'a', name: 'A' });
    const b = conn({ id: 'b', name: 'B' });
    expect(getDefaultConnection(sys({ connections: [a, b] }))?.id).toBe('a');
  });

  it('an explicit isDefault flag wins over list order', () => {
    const a = conn({ id: 'a', name: 'A' });
    const b = conn({ id: 'b', name: 'B', isDefault: true });
    expect(getDefaultConnection(sys({ connections: [a, b] }))?.id).toBe('b');
  });

  it('deleted connections are invisible to every resolver', () => {
    const dead = conn({ id: 'dead', isDefault: true, deletedAt: 5 });
    const live = conn({ id: 'live' });
    expect(getDefaultConnection(sys({ connections: [dead, live] }))?.id).toBe('live');
  });

  it('a character binding wins; unbound or stale falls back to default', () => {
    const a = conn({ id: 'a', name: 'A' });
    const b = conn({ id: 'b', name: 'B' });
    const settings = sys({ connections: [a, b] });
    const bound = { connectionId: 'b' } as AICharacter;
    expect(resolveCharacterConnection(settings, bound)?.id).toBe('b');
    expect(resolveCharacterConnection(settings, null)?.id).toBe('a');
    expect(resolveCharacterConnection(settings, { connectionId: 'gone' } as AICharacter)?.id).toBe(
      'a',
    );
  });

  it('the RAG connection is the dedicated one, else the default', () => {
    const a = conn({ id: 'a', name: 'A', isDefault: true });
    const rag = conn({ id: 'rag', name: 'Cheap embeddings', embeddingModel: 'emb-1' });
    expect(resolveRagConnection(sys({ connections: [a] }))?.id).toBe('a');
    expect(resolveRagConnection(sys({ connections: [a, rag], ragConnectionId: 'rag' }))?.id).toBe(
      'rag',
    );
    // A stale ragConnectionId falls back rather than breaking.
    expect(resolveRagConnection(sys({ connections: [a, rag], ragConnectionId: 'gone' }))?.id).toBe(
      'a',
    );
  });
});

describe('effective settings', () => {
  it('userLevelBase strips the retired global provider config', () => {
    const base = userLevelBase(sys({}).aiSettings!);
    expect(base.provider).toBe(DEFAULT_AI_SETTINGS.provider);
    expect(base.openrouterApiKey).toBeUndefined();
    // User-level preferences survive.
    expect(base.spoilerProtection).toBe(true);
  });

  it('resolveConnectionSettings overlays a connection', () => {
    const merged = resolveConnectionSettings(DEFAULT_AI_SETTINGS, conn({}));
    expect(merged.provider).toBe('openrouter');
    expect(merged.openrouterBaseUrl).toBe('https://api.example.com/v1');
    expect(merged.openrouterApiKey).toBe('sk-test');
    expect(merged.openrouterModel).toBe('big-model');
  });

  it('an ollama connection maps onto the ollama fields', () => {
    const merged = resolveConnectionSettings(
      DEFAULT_AI_SETTINGS,
      conn({ provider: 'ollama', baseUrl: 'http://192.168.1.5:11434', model: 'qwen3' }),
    );
    expect(merged.provider).toBe('ollama');
    expect(merged.ollamaBaseUrl).toBe('http://192.168.1.5:11434');
    expect(merged.ollamaModel).toBe('qwen3');
  });

  it('a connection embeddingModel maps onto the provider embedding field', () => {
    const merged = resolveConnectionSettings(
      DEFAULT_AI_SETTINGS,
      conn({ embeddingModel: 'nomic-embed-text' }),
    );
    expect(merged.openrouterEmbeddingModel).toBe('nomic-embed-text');
  });

  it('chat settings follow the character binding and never leak stale globals', () => {
    const a = conn({ id: 'a', name: 'A', apiKey: '' });
    const chat = resolveChatSettings(sys({ connections: [a] }), {
      connectionId: 'a',
    } as AICharacter);
    expect(chat.provider).toBe('openrouter');
    expect(chat.openrouterApiKey).toBe(''); // connection has no key — NOT the stale global one
  });

  it('rag settings come from the RAG connection with its embedding model', () => {
    const a = conn({ id: 'a', name: 'A', isDefault: true });
    const rag = conn({ id: 'rag', name: 'R', embeddingModel: 'emb-1', provider: 'ollama' });
    const ragSettings = resolveRagSettings(sys({ connections: [a, rag], ragConnectionId: 'rag' }));
    expect(ragSettings.provider).toBe('ollama');
    expect(ragSettings.ollamaEmbeddingModel).toBe('emb-1');
  });
});

describe('resolveCharacterMcpServers', () => {
  const servers = [
    { id: 'a', name: 'A', deletedAt: 1 },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ] as never[];

  it('no character (or no binding) means NO tools — MCP is strictly opt-in', () => {
    expect(resolveCharacterMcpServers(servers)).toEqual([]);
    expect(resolveCharacterMcpServers(servers, { mcpServerIds: undefined } as never)).toEqual([]);
  });

  it('a defined binding restricts to exactly those ids, skipping stale and deleted ones', () => {
    expect(
      resolveCharacterMcpServers(servers, { mcpServerIds: ['a', 'c', 'gone'] } as never),
    ).toEqual([servers[2]]); // 'a' deleted, 'gone' stale — only 'c' survives
  });

  it('an explicitly empty binding means no tools', () => {
    expect(resolveCharacterMcpServers(servers, { mcpServerIds: [] } as never)).toEqual([]);
  });
});
