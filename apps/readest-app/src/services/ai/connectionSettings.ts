import type { AIConnection, AIMcpServer, AISettings } from './types';

/**
 * Merge a character-bound connection into a copy of the global AISettings,
 * producing the effective settings the chat adapter builds its provider
 * from. Chat-model fields follow the connection; embedding models and
 * retrieval settings stay on the global provider (the book's RAG index is
 * embedding-bound — switching embeddings requires a re-index).
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
      break;
    case 'ai-gateway':
      merged.aiGatewayApiKey = connection.apiKey || base.aiGatewayApiKey;
      merged.aiGatewayModel = connection.model || base.aiGatewayModel;
      merged.aiGatewayCustomModel = '';
      break;
    case 'openrouter':
      merged.openrouterBaseUrl = connection.baseUrl || base.openrouterBaseUrl;
      merged.openrouterApiKey = connection.apiKey || base.openrouterApiKey;
      merged.openrouterModel = connection.model || base.openrouterModel;
      break;
  }
  return merged;
}

/**
 * The MCP servers a connection may use — only what was explicitly checked
 * in the connection editor. No binding (or no connection) means NO tools:
 * MCP is strictly opt-in per connection, never inherited by default.
 */
export function resolveConnectionMcpServers(
  servers: AIMcpServer[],
  connection?: AIConnection | null,
): AIMcpServer[] {
  const live = servers.filter((s) => !s.deletedAt);
  if (!connection?.mcpServerIds) return [];
  const ids = new Set(connection.mcpServerIds);
  return live.filter((s) => ids.has(s.id));
}
