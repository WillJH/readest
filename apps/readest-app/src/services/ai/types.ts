import type { LanguageModel, EmbeddingModel } from 'ai';

export type AIProviderName = 'ollama' | 'ai-gateway' | 'openrouter';

export interface AIProvider {
  id: AIProviderName;
  name: string;
  requiresAuth: boolean;

  getModel(): LanguageModel;
  getEmbeddingModel(): EmbeddingModel;

  isAvailable(): Promise<boolean>;
  healthCheck(): Promise<boolean>;
}

export interface AISettings {
  enabled: boolean;
  provider: AIProviderName;

  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaEmbeddingModel: string;

  aiGatewayApiKey?: string;
  aiGatewayModel?: string;
  aiGatewayCustomModel?: string;
  aiGatewayEmbeddingModel?: string;

  // OpenAI-compatible provider (OpenRouter, Together, Groq, vLLM, ...).
  // Default base URL is OpenRouter's, but any compatible endpoint works.
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openrouterModel?: string;
  openrouterEmbeddingModel?: string;

  /**
   * @deprecated System prompts now live on the connection
   * (`AIConnection.systemPrompt`) — models take different prompting, so the
   * prompt follows the connection. Legacy field kept so old settings files
   * keep loading; no longer read anywhere.
   */
  systemPrompt?: string;

  /**
   * Standing user-level instructions, appended (LLM-only — never shown in
   * the thread, never persisted with a message) to the latest user message
   * of every turn. E.g. "Answer in Chinese; attach phonetics to English
   * words." Independent of the active character's persona.
   */
  userInstructions?: string;

  spoilerProtection: boolean;
  maxContextChunks: number;
  indexingMode: 'on-demand' | 'background';

  /**
   * Reedy MVP retrieval (Turso vector + Tantivy FTS + CFI citations).
   * MVP is desktop-only — the runtime gate in `selectBackend()` enforces
   * isTauri() regardless of this flag. UI in M1.8 disables the toggle on web.
   */
  reedy?: {
    enabled: boolean;
    /**
     * 'mvp' (default) keeps the Phase 1B path: lookupPassage tool wired
     * through @assistant-ui/react's adapter. 'agent' switches the
     * notebook AI tab to the Phase 4 ReedyAssistant (custom AgentRuntime
     * + thread UI). Requires `reedy.enabled && isTauri() &&
     * runtime === 'agent'` to engage.
     */
    runtime?: 'mvp' | 'agent';
  };
}

export interface TextChunk {
  id: string;
  bookHash: string;
  sectionIndex: number;
  chapterTitle: string;
  text: string;
  embedding?: number[];
  pageNumber: number; // page number using Readest's 1500 chars/page formula
}

export interface ScoredChunk extends TextChunk {
  score: number;
  searchMethod: 'bm25' | 'vector' | 'hybrid';
}

export interface BookIndexMeta {
  bookHash: string;
  bookTitle: string;
  authorName: string;
  totalSections: number;
  totalChunks: number;
  embeddingModel: string;
  lastUpdated: number;
}

export interface IndexingState {
  bookHash: string;
  status: 'idle' | 'indexing' | 'complete' | 'error';
  progress: number;
  chunksProcessed: number;
  totalChunks: number;
  error?: string;
}

export interface EmbeddingProgress {
  current: number;
  total: number;
  phase: 'chunking' | 'embedding' | 'indexing';
}

// stored AI conversation for a book
export interface AIConversation {
  id: string;
  bookHash: string;
  title: string;
  /** Character this conversation talks to; unset = built-in companion. */
  characterId?: string;
  createdAt: number;
  updatedAt: number;
}

// single message in an AI conversation
export interface AIMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

/** One image in a character's gallery. Binaries live under Images/Characters/<characterId>/. */
export interface AICharacterImage {
  id: string;
  contentId: string;
  filename: string;
  byteSize: number;
  /** Short label the model uses to pick this image via [avatar: label]. */
  label: string;
}

/**
 * A saved AI provider connection (profile). Characters bind one via
 * `connectionId`; without a binding the global AISettings provider is used.
 */
export interface AIConnection {
  id: string;
  name: string;
  provider: AIProviderName;
  /** Server URL — the Ollama server or the OpenAI-compatible base URL. */
  baseUrl?: string;
  apiKey?: string;
  /** Chat model id. Embedding models stay on the global settings. */
  model?: string;
  /**
   * Model-specific system prompt applied when this connection is active —
   * different models take different prompting. Used when the active
   * character has no persona of its own; anti-spoiler constraints always
   * apply on top.
   */
  systemPrompt?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A configured MCP (Model Context Protocol) server. Transport is
 * Streamable-HTTP with an automatic legacy-SSE fallback; stdio servers are
 * desktop-only and not supported in v1. Headers are raw `Key: Value` lines
 * for UI simplicity, parsed at connect time.
 */
export interface AIMcpServer {
  id: string;
  name: string;
  /** Streamable-HTTP endpoint URL. */
  url: string;
  /** Extra request headers, one `Key: Value` per line. */
  headers?: string[];
  enabled: boolean;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A user-defined chat character: a persona prompt that replaces the built-in
 * reading-companion identity/style (anti-spoiler constraints always stay),
 * plus an image gallery the model picks its avatar from per reply.
 */
export interface AICharacter {
  id: string;
  name: string;
  /** Persona replacing the built-in identity/response-style sections. */
  prompt: string;
  images: AICharacterImage[];
  /** Shown when the model's [avatar: …] pick doesn't resolve. */
  defaultImageId?: string;
  /** Provider connection this character chats through; unset = global. */
  connectionId?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}
