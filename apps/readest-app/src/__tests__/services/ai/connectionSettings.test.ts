import { describe, it, expect } from 'vitest';
import { resolveConnectionSettings } from '@/services/ai/connectionSettings';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import type { AIConnection } from '@/services/ai/types';

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

describe('resolveConnectionSettings', () => {
  it('returns the base settings unchanged without a connection', () => {
    expect(resolveConnectionSettings(DEFAULT_AI_SETTINGS, null)).toBe(DEFAULT_AI_SETTINGS);
    expect(resolveConnectionSettings(DEFAULT_AI_SETTINGS, undefined)).toBe(DEFAULT_AI_SETTINGS);
  });

  it('maps an openrouter connection onto the provider fields', () => {
    const merged = resolveConnectionSettings(DEFAULT_AI_SETTINGS, conn({}));
    expect(merged.provider).toBe('openrouter');
    expect(merged.openrouterBaseUrl).toBe('https://api.example.com/v1');
    expect(merged.openrouterApiKey).toBe('sk-test');
    expect(merged.openrouterModel).toBe('big-model');
    // Embedding fields stay on the global settings.
    expect(merged.openrouterEmbeddingModel).toBe(DEFAULT_AI_SETTINGS.openrouterEmbeddingModel);
  });

  it('maps an ollama connection onto the ollama fields', () => {
    const merged = resolveConnectionSettings(DEFAULT_AI_SETTINGS, {
      ...conn({ provider: 'ollama', baseUrl: 'http://192.168.1.5:11434', model: 'qwen3' }),
    });
    expect(merged.provider).toBe('ollama');
    expect(merged.ollamaBaseUrl).toBe('http://192.168.1.5:11434');
    expect(merged.ollamaModel).toBe('qwen3');
  });

  it('maps a gateway connection and clears the custom-model override', () => {
    const base = { ...DEFAULT_AI_SETTINGS, aiGatewayCustomModel: 'old-custom' };
    const merged = resolveConnectionSettings(
      base,
      conn({ provider: 'ai-gateway', model: 'gpt-x' }),
    );
    expect(merged.provider).toBe('ai-gateway');
    expect(merged.aiGatewayModel).toBe('gpt-x');
    expect(merged.aiGatewayCustomModel).toBe('');
  });

  it('falls back to global fields when the connection leaves them blank', () => {
    const base = { ...DEFAULT_AI_SETTINGS, openrouterBaseUrl: 'https://global/v1' };
    const merged = resolveConnectionSettings(base, conn({ baseUrl: undefined }));
    expect(merged.openrouterBaseUrl).toBe('https://global/v1');
  });
});

describe('resolveConnectionMcpServers', () => {
  it('inherits all live servers without a connection or without a binding', async () => {
    const { resolveConnectionMcpServers } = await import('@/services/ai/connectionSettings');
    const servers = [
      { id: 'a', name: 'A', deletedAt: 1 } as never,
      { id: 'b', name: 'B' } as never,
      { id: 'c', name: 'C' } as never,
    ];
    expect(resolveConnectionMcpServers(servers)).toEqual([servers[1], servers[2]]);
    expect(resolveConnectionMcpServers(servers, { mcpServerIds: undefined } as never)).toEqual([
      servers[1],
      servers[2],
    ]);
  });

  it('a defined binding restricts to exactly those ids, skipping stale ones', async () => {
    const { resolveConnectionMcpServers } = await import('@/services/ai/connectionSettings');
    const servers = [
      { id: 'b', name: 'B' } as never,
      { id: 'c', name: 'C' } as never,
      { id: 'd', name: 'D' } as never,
    ];
    expect(resolveConnectionMcpServers(servers, { mcpServerIds: ['c', 'gone'] } as never)).toEqual([
      servers[1],
    ]);
  });

  it('an explicitly empty binding means no tools', async () => {
    const { resolveConnectionMcpServers } = await import('@/services/ai/connectionSettings');
    const servers = [{ id: 'b', name: 'B' }] as never[];
    expect(resolveConnectionMcpServers(servers, { mcpServerIds: [] } as never)).toEqual([]);
  });
});
