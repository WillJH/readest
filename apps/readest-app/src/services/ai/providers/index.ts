import { OllamaProvider } from './OllamaProvider';
import { AIGatewayProvider } from './AIGatewayProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { AIProvider, AISettings } from '../types';

export { OllamaProvider, AIGatewayProvider, OpenRouterProvider };

/**
 * Whether the ACTIVE provider has what it needs to run — i.e. a key is
 * present for the key-requiring providers. "Not configured yet" is a
 * perfectly normal state (fresh device, key deliberately device-local),
 * so UI gates use this predicate to render a configure prompt instead of
 * letting {@link getAIProvider}'s precondition throw at render time.
 */
export function isAIProviderConfigured(settings: AISettings): boolean {
  switch (settings.provider) {
    case 'ai-gateway':
      return !!settings.aiGatewayApiKey;
    case 'openrouter':
      return !!settings.openrouterApiKey;
    default:
      return true; // ollama: local server, no key
  }
}

export function getAIProvider(settings: AISettings): AIProvider {
  switch (settings.provider) {
    case 'ollama':
      return new OllamaProvider(settings);
    case 'ai-gateway':
      if (!settings.aiGatewayApiKey) {
        throw new Error('API key required for AI Gateway');
      }
      return new AIGatewayProvider(settings);
    case 'openrouter':
      if (!settings.openrouterApiKey) {
        throw new Error('API key required for OpenRouter');
      }
      return new OpenRouterProvider(settings);
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }
}
