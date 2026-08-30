import { DEFAULT_AI_SETTINGS } from './constants';
import type { SystemSettings } from '@/types/settings';
import type { AICharacter, AIConnection, AIMcpServer, AISettings } from './types';

/**
 * Connection resolution under the character-based model:
 *
 *   - Characters are the permission unit. A conversation runs through the
 *     connection its character is bound to; MCP tools come from the
 *     character's own selection.
 *   - The DEFAULT connection is the fallback: it binds the seeded companion
 *     character and serves system-level calls.
 *   - The RAG connection owns indexing/retrieval embeddings (a dedicated
 *     embedding endpoint, falling back to the default connection), because
 *     an index is only retrievable with the model that built it.
 *
 * The legacy global provider/apiKey settings are retired as a config
 * surface: provider fields are stripped down to their defaults and every
 * effective setting is overlaid from a connection.
 */

/** Live (non-deleted) connections in settings order. */
export const liveConnections = (settings: SystemSettings | null | undefined): AIConnection[] =>
  (settings?.aiConnections ?? []).filter((c) => !c.deletedAt);

/** The default connection — explicit flag first, else the first live one. */
export function getDefaultConnection(
  settings: SystemSettings | null | undefined,
): AIConnection | null {
  const live = liveConnections(settings);
  return live.find((c) => c.isDefault) ?? live[0] ?? null;
}

/** The connection a character chats through: its binding, else the default. */
export function resolveCharacterConnection(
  settings: SystemSettings | null | undefined,
  character?: AICharacter | null,
): AIConnection | null {
  if (character?.connectionId) {
    const bound = liveConnections(settings).find((c) => c.id === character.connectionId);
    if (bound) return bound;
  }
  return getDefaultConnection(settings);
}

/** The connection that owns RAG embeddings: the dedicated one, else default. */
export function resolveRagConnection(
  settings: SystemSettings | null | undefined,
): AIConnection | null {
  const ragId = settings?.aiSettings?.ragConnectionId;
  if (ragId) {
    const dedicated = liveConnections(settings).find((c) => c.id === ragId);
    if (dedicated) return dedicated;
  }
  return getDefaultConnection(settings);
}

/**
 * User-level AI preferences (prompts, spoiler, indexing…) kept from the
 * stored settings, with the retired global provider/key/model fields reset
 * to defaults — the connection overlay is the only provider config now.
 */
export function userLevelBase(aiSettings: AISettings): AISettings {
  const {
    provider: _provider,
    ollamaBaseUrl: _ollamaBaseUrl,
    ollamaModel: _ollamaModel,
    ollamaEmbeddingModel: _ollamaEmbeddingModel,
    aiGatewayApiKey: _aiGatewayApiKey,
    aiGatewayModel: _aiGatewayModel,
    aiGatewayCustomModel: _aiGatewayCustomModel,
    aiGatewayEmbeddingModel: _aiGatewayEmbeddingModel,
    openrouterApiKey: _openrouterApiKey,
    openrouterBaseUrl: _openrouterBaseUrl,
    openrouterModel: _openrouterModel,
    openrouterEmbeddingModel: _openrouterEmbeddingModel,
    systemPrompt: _systemPrompt,
    ...userLevel
  } = aiSettings;
  return { ...DEFAULT_AI_SETTINGS, ...userLevel };
}

/**
 * Overlay a connection onto the user-level base, producing the effective
 * settings a provider is built from. Chat-model fields follow the
 * connection; a connection `embeddingModel` (only the RAG connection uses
 * it) maps onto the provider's embedding field.
 */
export function resolveConnectionSettings(
  base: AISettings,
  connection?: AIConnection | null,
): AISettings {
  if (!connection) return base;
  const merged: AISettings = { ...base, provider: connection.provider };
  switch (connection.provider) {
    case 'ollama':
      merged.ollamaBaseUrl = connection.baseUrl || base.ollamaBaseUrl;
      merged.ollamaModel = connection.model || base.ollamaModel;
      if (connection.embeddingModel) merged.ollamaEmbeddingModel = connection.embeddingModel;
      break;
    case 'ai-gateway':
      merged.aiGatewayApiKey = connection.apiKey || '';
      merged.aiGatewayModel = connection.model || base.aiGatewayModel;
      merged.aiGatewayCustomModel = '';
      if (connection.embeddingModel) merged.aiGatewayEmbeddingModel = connection.embeddingModel;
      break;
    case 'openrouter':
      merged.openrouterBaseUrl = connection.baseUrl || base.openrouterBaseUrl;
      merged.openrouterApiKey = connection.apiKey || '';
      merged.openrouterModel = connection.model || base.openrouterModel;
      merged.openrouterEmbeddingModel = connection.embeddingModel ?? '';
      break;
  }
  return merged;
}

/** Effective settings for a character-bound (or default) chat connection. */
export function resolveChatSettings(
  settings: SystemSettings | null | undefined,
  character?: AICharacter | null,
): AISettings {
  const base = userLevelBase(settings?.aiSettings ?? DEFAULT_AI_SETTINGS);
  return resolveConnectionSettings(base, resolveCharacterConnection(settings, character));
}

/** Effective settings for RAG indexing/retrieval (embedding connection). */
export function resolveRagSettings(settings: SystemSettings | null | undefined): AISettings {
  const base = userLevelBase(settings?.aiSettings ?? DEFAULT_AI_SETTINGS);
  return resolveConnectionSettings(base, resolveRagConnection(settings));
}

/**
 * The MCP servers a CHARACTER may use — only what was explicitly checked in
 * the character editor. No binding (or no character) means NO tools: MCP is
 * strictly opt-in per character, never inherited by default.
 */
export function resolveCharacterMcpServers(
  servers: AIMcpServer[],
  character?: AICharacter | null,
): AIMcpServer[] {
  const live = servers.filter((s) => !s.deletedAt);
  if (!character?.mcpServerIds) return [];
  const ids = new Set(character.mcpServerIds);
  return live.filter((s) => ids.has(s.id));
}
