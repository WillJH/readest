'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useAssistantRuntime,
  type ThreadMessage,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react';

import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCharacterStore } from '@/store/characterStore';
import { aiLogger, createTauriAdapter } from '@/services/ai';
import {
  liveConnections,
  resolveChatSettings,
  resolveCharacterConnection,
  resolveCharacterMcpServers,
  resolveRagSettings,
} from '@/services/ai/connectionSettings';
import {
  LegacyIdbBackend,
  ReedyBackend,
  ReedySourceStore,
  selectBackend,
  type RetrievalBackend,
  type SourceItem,
} from '@/services/ai/adapters';
import type { EmbeddingProgress, AIMessage } from '@/services/ai/types';
import type { RetrievedChunk } from '@/services/reedy/retrieval/BookRetriever';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { isTauriAppPlatform } from '@/services/environment';
import type { AppService } from '@/types/system';
import { ReedyAssistant } from '@/services/reedy/ui/ReedyAssistant';
import type { ReadingContextSnapshot } from '@/services/reedy/tools/builtins/types';

import { Loader2Icon, BookOpenIcon } from 'lucide-react';
import clsx from 'clsx';
import CharacterAvatar from '@/components/CharacterAvatar';
import { Thread } from '@/components/assistant/Thread';

// Helper function to convert AIMessage array to ExportedMessageRepository format
// Each message needs to be wrapped with { message, parentId } structure
function convertToExportedMessages(
  aiMessages: AIMessage[],
): { message: ThreadMessage; parentId: string | null }[] {
  return aiMessages.map((msg, idx) => {
    const baseMessage = {
      id: msg.id,
      content: [{ type: 'text' as const, text: msg.content }],
      createdAt: new Date(msg.createdAt),
      metadata: { custom: {} },
    };

    // Build role-specific message to satisfy ThreadMessage union type
    const threadMessage: ThreadMessage =
      msg.role === 'user'
        ? ({
            ...baseMessage,
            role: 'user' as const,
            attachments: [] as const,
          } as unknown as ThreadMessage)
        : ({
            ...baseMessage,
            role: 'assistant' as const,
            status: { type: 'complete' as const, reason: 'stop' as const },
          } as unknown as ThreadMessage);

    return {
      message: threadMessage,
      parentId: idx > 0 ? (aiMessages[idx - 1]?.id ?? null) : null,
    };
  });
}

// An Ask AI payload that arrived while the chat thread wasn't mounted (e.g.
// notebook hidden); consumed by ThreadWrapper on mount.
let pendingAskAi: { bookHash: string; text: string } | null = null;

interface AIAssistantProps {
  bookKey: string;
}

// inner component that uses the runtime hook
const AIAssistantChat = ({
  bookHash,
  bookTitle,
  authorName,
  bookLang,
  currentPage,
  backend,
  sourceStore,
  currentTurnId,
  setCurrentTurnId,
  onSourceClick,
  onResetIndex,
}: {
  bookHash: string;
  bookTitle: string;
  authorName: string;
  bookLang?: string;
  currentPage: number;
  backend: RetrievalBackend;
  sourceStore: ReedySourceStore;
  currentTurnId: string | null;
  setCurrentTurnId: (id: string) => void;
  onSourceClick?: (source: SourceItem) => void;
  onResetIndex: () => void;
}) => {
  const _ = useTranslation();
  const {
    activeConversationId,
    conversations,
    draftCharacterId,
    messages: storedMessages,
    addMessage,
    isLoadingHistory,
    setConversationCharacter,
    setDraftCharacter,
  } = useAIChatStore();
  const { envConfig } = useEnv();
  const { settings: systemSettings } = useSettingsStore();
  const { characters, imageUrls, loadCharacters } = useCharacterStore();
  const [avatarLabel, setAvatarLabel] = useState<string | null>(null);

  useEffect(() => {
    if (envConfig) void loadCharacters(envConfig);
  }, [envConfig, loadCharacters]);

  // The conversation's bound character, or the draft pick for the next one.
  const characterId =
    conversations.find((c) => c.id === activeConversationId)?.characterId ?? draftCharacterId;
  const character = characters.find((c) => c.id === characterId && !c.deletedAt);

  // Character model: the character's bound connection, else the default
  // connection — the global provider config is retired.
  const connection = resolveCharacterConnection(systemSettings, character);
  const chatSettings = resolveChatSettings(systemSettings, character);

  const resolveAvatarUrl = useCallback(
    (label: string | null | undefined): string | undefined => {
      if (!character) return undefined;
      if (label) {
        const byLabel = character.images.find((i) => i.label.toLowerCase() === label.toLowerCase());
        if (byLabel && imageUrls[byLabel.id]) return imageUrls[byLabel.id];
      }
      const fallback =
        character.images.find((i) => i.id === character.defaultImageId) ?? character.images[0];
      return fallback ? imageUrls[fallback.id] : undefined;
    },
    [character, imageUrls],
  );
  const avatarUrl = resolveAvatarUrl(avatarLabel);

  // use a ref to keep up-to-date options without triggering re-renders of the runtime
  const optionsRef = useRef({
    settings: chatSettings,
    missingKeyMessage: `${_('Configure the AI provider API key in Settings')} (${_('API keys stay on this device and are never synced')})`,
    bookHash,
    bookTitle,
    authorName,
    currentPage,
    backend,
    sourceStore,
    onTurnStart: setCurrentTurnId,
    character: character
      ? {
          name: character.name,
          prompt: character.prompt,
          imageLabels: character.images.map((i) => i.label),
        }
      : null,
    onAvatarPick: setAvatarLabel,
    mcpServers: resolveCharacterMcpServers(systemSettings?.aiMcpServers ?? [], character),
    connectionSystemPrompt: connection?.systemPrompt,
  });

  // update ref on every render with latest values
  useEffect(() => {
    optionsRef.current = {
      settings: chatSettings,
      missingKeyMessage: `${_('Configure the AI provider API key in Settings')} (${_('API keys stay on this device and are never synced')})`,
      bookHash,
      bookTitle,
      authorName,
      currentPage,
      backend,
      sourceStore,
      onTurnStart: setCurrentTurnId,
      character: character
        ? {
            name: character.name,
            prompt: character.prompt,
            imageLabels: character.images.map((i) => i.label),
          }
        : null,
      onAvatarPick: setAvatarLabel,
      mcpServers: resolveCharacterMcpServers(systemSettings?.aiMcpServers ?? [], character),
      connectionSystemPrompt: connection?.systemPrompt,
    };
  });

  // create adapter ONCE and keep it stable
  const adapter = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs -- intentional: we read optionsRef inside a deferred callback, not during render
    return createTauriAdapter(() => optionsRef.current);
  }, []);

  // Create history adapter to load/persist messages
  const historyAdapter = useMemo<ThreadHistoryAdapter | undefined>(() => {
    if (!activeConversationId) return undefined;

    return {
      async load() {
        // storedMessages are already loaded by aiChatStore when conversation is selected
        return {
          messages: convertToExportedMessages(storedMessages),
        };
      },
      async append(item) {
        // item is ExportedMessageRepositoryItem - access the actual message via .message
        const msg = item.message;
        // Persist new messages to our store
        if (activeConversationId && msg.role !== 'system') {
          const textContent = msg.content
            .filter(
              (part): part is { type: 'text'; text: string } =>
                'type' in part && part.type === 'text',
            )
            .map((part) => part.text)
            .join('\n');

          if (textContent) {
            await addMessage({
              conversationId: activeConversationId,
              role: msg.role as 'user' | 'assistant',
              content: textContent,
            });
          }
        }
      },
    };
  }, [activeConversationId, storedMessages, addMessage]);

  const selectCharacter = useCallback(
    (next: string | null) => {
      setAvatarLabel(null);
      if (activeConversationId) {
        void setConversationCharacter(activeConversationId, next ?? undefined);
      } else {
        setDraftCharacter(next);
      }
    },
    [activeConversationId, setConversationCharacter, setDraftCharacter],
  );

  const defaultImageIdFor = (c: (typeof characters)[number]) =>
    (c.images.find((i) => i.id === c.defaultImageId) ?? c.images[0])?.id ?? '';
  const connectionLabel = connection
    ? `${connection.name}${connection.model ? ` · ${connection.model}` : ''}`
    : _('Global Settings');
  // The character's default gallery image doubles as the chat backdrop.
  const characterBackgroundUrl = character ? imageUrls[defaultImageIdFor(character)] : undefined;
  // Book language drives message speech (same source the dictionary popup uses).

  return (
    <div className='relative flex h-full min-h-0 flex-col'>
      {/* The assistant's own image as the chat backdrop, with a scrim for
          readability. The thread turns transparent when this is active. */}
      {characterBackgroundUrl && (
        <div aria-hidden='true' className='pointer-events-none absolute inset-0 overflow-hidden'>
          <img src={characterBackgroundUrl} alt='' className='size-full scale-105 object-cover' />
          <div className='from-base-100/85 via-base-100/70 to-base-100/90 absolute inset-0 bg-gradient-to-b' />
        </div>
      )}

      <div className='relative z-10 flex h-full min-h-0 flex-1 flex-col'>
        {/* Character rail — the assistant always has a face, one tap to switch. */}
        <div className='border-base-300/40 flex items-center gap-1.5 border-b px-3 pt-2 pb-2'>
          <button
            type='button'
            onClick={() => selectCharacter(null)}
            title={_('Default Companion')}
            aria-label={_('Default Companion')}
            aria-pressed={characterId == null}
            className={clsx(
              'flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
              characterId == null
                ? 'bg-primary/15 text-primary'
                : 'text-base-content/50 hover:bg-base-200/60',
            )}
          >
            <BookOpenIcon className='size-4' />
          </button>
          <div className='flex min-w-0 flex-1 items-center gap-2 overflow-x-auto'>
            {characters.map((c) => {
              const selected = c.id === characterId;
              return (
                <button
                  key={c.id}
                  type='button'
                  onClick={() => selectCharacter(c.id)}
                  title={c.name}
                  aria-label={c.name}
                  aria-pressed={selected}
                  className={clsx(
                    'shrink-0 rounded-full transition-all',
                    selected
                      ? 'ring-primary ring-2 ring-offset-base-100 ring-offset-2'
                      : 'opacity-70 hover:opacity-100',
                  )}
                >
                  <CharacterAvatar name={c.name} url={imageUrls[defaultImageIdFor(c)]} size={32} />
                </button>
              );
            })}
          </div>
        </div>

        {/* Identity card — who is on the other side, through which model. */}
        {character && (
          <div className='flex items-center gap-2.5 px-3 pt-2 pb-1'>
            <CharacterAvatar
              name={character.name}
              url={imageUrls[defaultImageIdFor(character)]}
              size={36}
            />
            <div className='min-w-0 flex-1'>
              <div className='text-base-content truncate text-sm font-semibold'>
                {character.name}
              </div>
              <div className='text-base-content/55 truncate text-xs'>{connectionLabel}</div>
            </div>
          </div>
        )}
      </div>

      <AIAssistantWithRuntime
        adapter={adapter}
        historyAdapter={historyAdapter}
        onResetIndex={onResetIndex}
        isLoadingHistory={isLoadingHistory}
        hasActiveConversation={!!activeConversationId}
        sourceStore={sourceStore}
        currentTurnId={currentTurnId}
        onSourceClick={onSourceClick}
        avatarUrl={avatarUrl}
        bookHash={bookHash}
        bookTitle={bookTitle}
        transparentThread={!!characterBackgroundUrl}
        speakLang={bookLang}
      />
    </div>
  );
};

const AIAssistantWithRuntime = ({
  adapter,
  historyAdapter,
  onResetIndex,
  isLoadingHistory,
  hasActiveConversation,
  sourceStore,
  currentTurnId,
  onSourceClick,
  avatarUrl,
  bookHash,
  bookTitle,
  transparentThread,
  speakLang,
}: {
  adapter: NonNullable<ReturnType<typeof createTauriAdapter>>;
  historyAdapter?: ThreadHistoryAdapter;
  onResetIndex: () => void;
  isLoadingHistory: boolean;
  hasActiveConversation: boolean;
  sourceStore: ReedySourceStore;
  currentTurnId: string | null;
  onSourceClick?: (source: SourceItem) => void;
  avatarUrl?: string;
  bookHash: string;
  bookTitle: string;
  transparentThread?: boolean;
  speakLang?: string;
}) => {
  const runtime = useLocalRuntime(adapter, {
    adapters: historyAdapter ? { history: historyAdapter } : undefined,
  });

  if (!runtime) return null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadWrapper
        onResetIndex={onResetIndex}
        isLoadingHistory={isLoadingHistory}
        hasActiveConversation={hasActiveConversation}
        sourceStore={sourceStore}
        currentTurnId={currentTurnId}
        onSourceClick={onSourceClick}
        avatarUrl={avatarUrl}
        bookHash={bookHash}
        bookTitle={bookTitle}
        transparentThread={transparentThread}
        speakLang={speakLang}
      />
    </AssistantRuntimeProvider>
  );
};

const ThreadWrapper = ({
  onResetIndex,
  isLoadingHistory,
  hasActiveConversation,
  sourceStore,
  currentTurnId,
  onSourceClick,
  avatarUrl,
  bookHash,
  bookTitle,
  transparentThread,
  speakLang,
}: {
  onResetIndex: () => void;
  isLoadingHistory: boolean;
  hasActiveConversation: boolean;
  sourceStore: ReedySourceStore;
  currentTurnId: string | null;
  onSourceClick?: (source: SourceItem) => void;
  avatarUrl?: string;
  bookHash: string;
  bookTitle: string;
  transparentThread?: boolean;
  speakLang?: string;
}) => {
  const [sources, setSources] = useState<RetrievedChunk[]>(
    currentTurnId ? sourceStore.get(currentTurnId) : [],
  );
  const assistantRuntime = useAssistantRuntime();
  const { setActiveConversation } = useAIChatStore();

  // Ask AI (selection toolbar): quote the selected text into the chat as a
  // user message and let the active character's persona respond. When no
  // conversation is active, create one first so the exchange persists —
  // the short delay lets the runtime pick up the new history adapter.
  const appendQuote = useCallback(
    (quote: string) => {
      const append = () => {
        pendingAskAi = null;
        assistantRuntime.thread.append(`> ${quote}`);
      };
      const { activeConversationId, createConversation } = useAIChatStore.getState();
      if (activeConversationId) {
        append();
      } else {
        void createConversation(bookHash, `AI · ${bookTitle}`).then(() => {
          setTimeout(append, 120);
        });
      }
    },
    [assistantRuntime, bookHash, bookTitle],
  );

  useEffect(() => {
    const handleAskAi = (event: CustomEvent) => {
      const { text } = event.detail as { text?: string };
      const quote = (text ?? '').trim();
      if (quote) appendQuote(quote);
    };
    eventDispatcher.on('ask-ai', handleAskAi);
    return () => {
      eventDispatcher.off('ask-ai', handleAskAi);
    };
  }, [appendQuote]);

  // A tap that arrived while this thread wasn't mounted (index-choice
  // screen) left its payload stashed — consume it now.
  useEffect(() => {
    if (pendingAskAi) {
      const { text } = pendingAskAi;
      pendingAskAi = null;
      appendQuote(text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendQuote]);

  // Subscribe to the active turn's slot in the source store. Replaces the
  // pre-Reedy 500ms poll over a module-global lastSources (per plan §M1.7).
  useEffect(() => {
    if (!currentTurnId) {
      setSources([]);
      return;
    }
    setSources(sourceStore.get(currentTurnId));
    return sourceStore.subscribe(currentTurnId, setSources);
  }, [currentTurnId, sourceStore]);

  const handleClear = useCallback(() => {
    sourceStore.clear();
    setSources([]);
    setActiveConversation(null);
    assistantRuntime.switchToNewThread();
  }, [assistantRuntime, setActiveConversation, sourceStore]);

  return (
    <Thread
      sources={sources}
      onSourceClick={onSourceClick}
      onClear={handleClear}
      onResetIndex={onResetIndex}
      isLoadingHistory={isLoadingHistory}
      hasActiveConversation={hasActiveConversation}
      avatarUrl={avatarUrl}
      transparentThread={transparentThread}
      speakLang={speakLang}
    />
  );
};

/**
 * Phase 4.3 router. Switches between the legacy / Reedy-MVP path
 * (LegacyAIAssistant) and the Phase 4 agent-runtime path
 * (ReedyAgentAssistantBridge) based on aiSettings.reedy.runtime.
 *
 * The split is at component boundary rather than inside one component
 * so hooks always run in stable order on whichever path is rendered.
 */
const AIAssistant = ({ bookKey }: AIAssistantProps) => {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const bookData = getBookData(bookKey);

  const reedyRuntime = settings?.aiSettings?.reedy?.runtime ?? 'mvp';
  const useAgentRuntime =
    settings?.aiSettings?.enabled === true &&
    settings?.aiSettings?.reedy?.enabled === true &&
    reedyRuntime === 'agent' &&
    !!appService &&
    isTauriAppPlatform() &&
    !!bookData?.bookDoc;

  if (useAgentRuntime) return <ReedyAgentAssistantBridge bookKey={bookKey} />;
  return <LegacyAIAssistant bookKey={bookKey} />;
};

const LegacyAIAssistant = ({ bookKey }: AIAssistantProps) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getView = useReaderStore((s) => s.getView);
  const bookData = getBookData(bookKey);
  // Reactive: chat context follows the user's current reading position.
  const progress = useBookProgress(bookKey);

  const [isLoading, setIsLoading] = useState(true);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexProgress, setIndexProgress] = useState<EmbeddingProgress | null>(null);
  const [indexed, setIndexed] = useState(false);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);

  // An Ask AI tap can arrive while the chat thread isn't mounted (notebook
  // hidden): stash the payload — ThreadWrapper consumes it when it mounts.
  useEffect(() => {
    const handleAskAi = (event: CustomEvent) => {
      const { text } = event.detail as { text?: string };
      if (!text?.trim()) return;
      pendingAskAi = { bookHash: bookKey.split('-')[0] || '', text: text.trim() };
    };
    eventDispatcher.on('ask-ai', handleAskAi);
    return () => {
      eventDispatcher.off('ask-ai', handleAskAi);
    };
  }, [bookKey]);

  const bookHash = bookKey.split('-')[0] || '';
  const bookTitle = bookData?.book?.title || 'Unknown';
  const authorName = bookData?.book?.author || '';
  const langRaw = bookData?.bookDoc?.metadata.language;
  const bookLang = (Array.isArray(langRaw) ? langRaw[0] : langRaw) ?? undefined;
  const currentPage = progress?.pageinfo?.current ?? 0;
  const aiSettings = settings?.aiSettings;
  // Retrieval/embedding runs on the RAG connection (dedicated, else default).
  const ragSettings = useMemo(() => resolveRagSettings(settings), [settings]);

  // Per-instance source store, plus the active backend chosen via the same
  // selectBackend gate the chat adapter will hit (Reedy on Tauri when
  // enabled; legacy IDB otherwise).
  const sourceStore = useMemo(() => new ReedySourceStore(), []);
  const backend = useMemo<RetrievalBackend | null>(() => {
    if (!aiSettings) return null;
    // Retrieval backends embed with the RAG connection's model — the index
    // is only retrievable with the model that built it.
    const legacy = new LegacyIdbBackend(ragSettings);
    const reedy: RetrievalBackend | null =
      appService && isTauriAppPlatform()
        ? new ReedyBackend(appService as AppService, ragSettings)
        : null;
    return selectBackend({ settings: ragSettings, isTauri: isTauriAppPlatform(), legacy, reedy });
  }, [aiSettings, ragSettings, appService]);

  // check if book is indexed on mount
  useEffect(() => {
    if (bookHash && backend) {
      backend.isIndexed(bookHash).then((result) => {
        setIndexed(result);
        setIsLoading(false);
      });
    } else if (!backend) {
      setIsLoading(false);
    } else {
      setIsLoading(false);
    }
  }, [bookHash, backend]);

  const handleIndex = useCallback(async () => {
    if (!bookData?.bookDoc || !aiSettings || !backend) return;
    setIsIndexing(true);
    setIndexError(null);
    try {
      await backend.indexBook(bookData.bookDoc, bookHash, { onProgress: setIndexProgress });
      setIndexed(true);
    } catch (e) {
      aiLogger.rag.indexError(bookHash, (e as Error).message);
      // Request-time failure surfaces inline (rule: a missing key is
      // prompted when the user actually asks for an AI action, not before).
      const message = (e as Error).message;
      setIndexError(
        message.includes('API key required')
          ? _('Configure the AI provider API key in Settings')
          : message,
      );
    } finally {
      setIsIndexing(false);
      setIndexProgress(null);
    }
  }, [bookData?.bookDoc, bookHash, aiSettings, _]);

  const handleResetIndex = useCallback(async () => {
    if (!appService || !backend) return;
    if (!(await appService.ask(_('Are you sure you want to re-index this book?')))) return;
    await backend.clearBook(bookHash);
    setIndexed(false);
  }, [bookHash, appService, backend, _]);

  // Navigate the reader to a clicked source's CFI. Legacy backend chunks have
  // no CFI so the Thread component renders them as static rows — only Reedy
  // sources are clickable in M1.10.
  const handleSourceClick = useCallback(
    (source: SourceItem) => {
      if (!source.cfi) return;
      getView(bookKey)?.goTo(source.cfi);
    },
    [bookKey, getView],
  );

  if (!aiSettings?.enabled) {
    return (
      <div className='flex h-full items-center justify-center p-4'>
        <p className='text-muted-foreground text-sm'>{_('Enable AI in Settings')}</p>
      </div>
    );
  }

  // Rule: an empty connections list means no AI connection exists yet —
  // prompt instead of ever issuing a request.
  if (liveConnections(settings).length === 0) {
    return (
      <div className='flex h-full items-center justify-center p-4'>
        <p className='text-muted-foreground text-sm'>
          {_('No available connection. Create one in Settings → AI → Manage Connections')}
        </p>
      </div>
    );
  }

  // show nothing while checking index status to prevent flicker
  if (isLoading) {
    return null;
  }

  const progressPercent =
    indexProgress?.phase === 'embedding' && indexProgress.total > 0
      ? Math.round((indexProgress.current / indexProgress.total) * 100)
      : 0;

  // No gate for the un-indexed book: the chat is always available (grammar
  // questions, general knowledge, pasted passages need no book context at
  // all), and the banner keeps Start Indexing one tap away.

  if (isIndexing) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-center'>
        <Loader2Icon className='text-primary size-6 animate-spin' />
        <div>
          <p className='text-foreground mb-1 text-sm font-medium'>{_('Indexing book...')}</p>
          <p className='text-muted-foreground text-xs'>
            {indexProgress?.phase === 'embedding'
              ? `${indexProgress.current} / ${indexProgress.total} chunks`
              : _('Preparing...')}
          </p>
        </div>
        <div className='bg-muted h-1.5 w-32 overflow-hidden rounded-full'>
          <div
            className='bg-primary h-full transition-all duration-300'
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    );
  }

  if (!backend) return null;

  return (
    <div className='flex h-full min-h-0 flex-col'>
      {!indexed && (
        <div className='border-base-300/40 flex items-center justify-between gap-2 border-b px-3 py-1.5'>
          <span className='text-base-content/60 text-xs'>
            {indexError
              ? `${_('Not indexed — answers lack full-book context.')} · ${indexError}`
              : _('Not indexed — answers lack full-book context.')}
          </span>
          <button
            type='button'
            onClick={() => void handleIndex()}
            className='btn btn-ghost btn-xs shrink-0'
          >
            {_('Start Indexing')}
          </button>
        </div>
      )}
      <AIAssistantChat
        bookHash={bookHash}
        bookTitle={bookTitle}
        authorName={authorName}
        bookLang={bookLang}
        currentPage={currentPage}
        backend={backend}
        sourceStore={sourceStore}
        currentTurnId={currentTurnId}
        setCurrentTurnId={setCurrentTurnId}
        onSourceClick={handleSourceClick}
        onResetIndex={handleResetIndex}
      />
    </div>
  );
};

/**
 * Bridge from the notebook AI tab into the Phase 4 ReedyAssistant.
 *
 * Kept separate from AIAssistant so legacy props/state don't leak in
 * and we don't pay the cost of constructing the agent runtime when the
 * user is on the MVP path. The flag check in AIAssistant guarantees this
 * only renders when aiSettings.reedy.runtime === 'agent'.
 */
const ReedyAgentAssistantBridge = ({ bookKey }: AIAssistantProps) => {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getView = useReaderStore((s) => s.getView);
  const bookData = getBookData(bookKey);
  // Reactive: agent runtime needs the latest reading position to seed
  // tool calls.
  const progress = useBookProgress(bookKey);

  const bookHash = bookKey.split('-')[0] || '';
  const aiSettings = settings?.aiSettings;

  const readingContext = useMemo<ReadingContextSnapshot>(
    () => ({
      cfi: progress?.location ?? null,
      sectionIndex: progress?.section?.current ?? 0,
      chapterTitle: progress?.sectionLabel ?? null,
      pageNumber: progress?.pageinfo?.current ?? 0,
    }),
    [progress],
  );

  const handleNavigate = useCallback(
    (cfi: string) => {
      getView(bookKey)?.goTo(cfi);
    },
    [bookKey, getView],
  );

  if (!aiSettings || !appService || !bookData?.bookDoc) return null;

  return (
    <ReedyAssistant
      appService={appService as AppService}
      bookDoc={bookData.bookDoc}
      bookHash={bookHash}
      bookKey={bookKey}
      aiSettings={aiSettings}
      readingContext={readingContext}
      onNavigateToCfi={handleNavigate}
    />
  );
};

export default AIAssistant;
