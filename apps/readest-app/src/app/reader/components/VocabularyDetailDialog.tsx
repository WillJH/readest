'use client';

import clsx from 'clsx';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useState } from 'react';
import { LuLocateFixed, LuTrash2 } from 'react-icons/lu';
import { MdVolumeUp } from 'react-icons/md';

import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { getBookProgress } from '@/store/readerProgressStore';
import { useVocabularyStore } from '@/store/vocabularyStore';
import { VocabularyDb } from '@/services/vocabulary/vocabularyDb';
import { DEFAULT_TTS_CONFIG } from '@/services/constants';
import { cancelWordPronounce, pronounceWord, warmWordAudio } from '@/services/tts/wordPronouncer';
import type { VocabularyContext, VocabularyWordDetail } from '@/types/vocabulary';
import { eventDispatcher } from '@/utils/event';
import { inferLangFromScript } from '@/utils/lang';

interface VocabularyDetailDialogProps {
  wordId: string;
  onClose: () => void;
}

const VocabularyDetailDialog: React.FC<VocabularyDetailDialogProps> = ({ wordId, onClose }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const getView = useReaderStore((s) => s.getView);
  const bookKeys = useReaderStore((s) => s.bookKeys);
  const { removeWord } = useVocabularyStore();

  const [detail, setDetail] = useState<VocabularyWordDetail | null>(null);
  // 'word' or a context id — whichever pronunciation is currently playing.
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!appService) return;
    setDetail(null);
    void VocabularyDb.open(appService)
      .then((db) => db.getWord(wordId))
      .then((word) => {
        if (!cancelled) setDetail(word);
      })
      .catch((err) => console.warn('Failed to load vocabulary word:', err));
    return () => {
      cancelled = true;
    };
  }, [appService, wordId]);

  // All pronunciations in this dialog mirror the read-aloud configuration:
  // same engine (the reader's preferred client), same preferred voice per
  // language, and the reader's global rate.
  const readerRate = () =>
    useSettingsStore.getState().settings?.globalViewSettings?.ttsRate ?? DEFAULT_TTS_CONFIG.ttsRate;

  // Auto-pronounce once when a word's detail arrives: firing as the dialog
  // opens overlaps the synth latency. Keyed on the word identity — not
  // `detail` — so switching the primary definition doesn't re-trigger it.
  // The audio context was already unlocked by the opening click (see
  // warmWordAudio at the Annotator/VocabularyView call sites).
  const detailWordId = detail?.id;
  const detailWord = detail?.word;
  const detailLang = detail?.lang;
  useEffect(() => {
    if (!detailWordId || !detailWord || !appService) return;
    setSpeakingKey('word');
    void pronounceWord(
      detailWord,
      detailLang ?? undefined,
      { appService, rate: readerRate() },
      (status) => {
        if (status !== 'playing') setSpeakingKey(null);
      },
    );
  }, [appService, detailWordId, detailWord, detailLang]);

  // Stop any in-flight pronunciation when the dialog closes or switches words.
  useEffect(() => {
    return () => cancelWordPronounce();
  }, []);
  useEffect(() => {
    cancelWordPronounce();
    setSpeakingKey(null);
  }, [wordId]);

  const speakWord = useCallback(() => {
    if (!detail || !appService) return;
    // Warm the audio context synchronously inside the click gesture; the
    // Edge synth/play happens after a network await, outside the window.
    warmWordAudio();
    setSpeakingKey('word');
    void pronounceWord(
      detail.word,
      detail.lang ?? undefined,
      { appService, rate: readerRate() },
      (status) => {
        if (status !== 'playing') setSpeakingKey(null);
      },
    );
  }, [appService, detail]);

  const speakContext = useCallback(
    (context: VocabularyContext) => {
      if (!appService) return;
      warmWordAudio();
      setSpeakingKey(context.id);
      // A context can come from a book written in another script than the
      // headword's language; let the sentence itself decide zh/ja/ko.
      const lang = inferLangFromScript(context.sentence, detail?.lang ?? 'en');
      void pronounceWord(context.sentence, lang, { appService, rate: readerRate() }, (status) => {
        if (status !== 'playing') setSpeakingKey(null);
      });
    },
    [appService, detail?.lang],
  );

  const handleSetPrimary = useCallback(
    async (index: number) => {
      if (!appService || !detail || detail.primaryIndex === index) return;
      setDetail({ ...detail, primaryIndex: index });
      await useVocabularyStore.getState().setPrimaryAndPublish(appService, detail.id, index);
    },
    [appService, detail],
  );

  const handleDelete = useCallback(async () => {
    if (!appService || !detail) return;
    if (await appService.ask(_('Delete this word?'))) {
      await removeWord(appService, detail.id);
      onClose();
    }
  }, [appService, detail, _, removeWord, onClose]);

  // Jumping back needs the book open in this reader session (parallel view or
  // the current book); otherwise the context is read-only.
  const openBookKeyFor = useCallback(
    (context: VocabularyContext): string | null => {
      if (!context.cfi) return null;
      return bookKeys.find((key) => key.split('-')[0] === context.bookHash) ?? null;
    },
    [bookKeys],
  );

  const handleJumpToContext = useCallback(
    (context: VocabularyContext) => {
      const bookKey = openBookKeyFor(context);
      if (!bookKey || !context.cfi) return;
      // Remember where the reader was, so the return chip can restore it —
      // in a long foreign-language novel a lost position is hard to refind.
      const previous = getBookProgress(bookKey)?.location;
      if (previous && previous !== context.cfi) {
        useVocabularyStore.getState().setJumpedFrom({ bookKey, cfi: previous });
      }
      eventDispatcher.dispatch('navigate', { bookKey, cfi: context.cfi });
      getView(bookKey)?.goTo(context.cfi);
      onClose();
    },
    [openBookKeyFor, getView, onClose],
  );

  const primary = detail
    ? (detail.definitions[detail.primaryIndex] ?? detail.definitions[0] ?? null)
    : null;

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={detail?.word ?? ''}
      titleExtra={
        detail ? (
          <button
            type='button'
            aria-label={_('Speak')}
            title={_('Speak')}
            aria-pressed={speakingKey === 'word'}
            onClick={speakWord}
            className={clsx(
              'btn btn-ghost btn-square btn-xs shrink-0',
              speakingKey === 'word'
                ? 'text-base-content not-eink:animate-pulse'
                : 'text-base-content/60 hover:text-base-content not-eink:hover:bg-base-200/60',
            )}
          >
            <MdVolumeUp size={18} />
          </button>
        ) : undefined
      }
      snapHeight={0.7}
      boxClassName='sm:min-w-[460px]!'
    >
      {detail && (
        <div className='flex flex-col gap-4'>
          {detail.surfaceForms.length > 0 && (
            <p className='text-base-content/50 flex flex-wrap items-center gap-1.5 text-xs'>
              <span>{_('Encountered forms')}</span>
              {detail.surfaceForms.map((form) => (
                <span key={form} className='border-base-content/15 rounded-full border px-2 py-0.5'>
                  {form}
                </span>
              ))}
            </p>
          )}
          {detail.definitions.length === 0 ? (
            <p className='text-base-content/50 text-sm'>
              {_('No definition was captured for this word')}
            </p>
          ) : (
            <section>
              <h3 className='not-eink:opacity-60 mb-2 text-xs font-medium uppercase tracking-wide'>
                {_('Definitions')}
              </h3>
              <ul className='flex flex-col gap-2'>
                {detail.definitions.map((def, index) => (
                  <li key={`${def.source}-${index}`}>
                    <div
                      role={index === detail.primaryIndex ? undefined : 'button'}
                      tabIndex={index === detail.primaryIndex ? undefined : 0}
                      aria-label={_('Use this definition')}
                      title={index === detail.primaryIndex ? undefined : _('Use this definition')}
                      onClick={() => void handleSetPrimary(index)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          void handleSetPrimary(index);
                        }
                      }}
                      className={clsx(
                        'rounded-lg border p-2 text-sm',
                        def === primary
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-base-content/10 cursor-pointer hover:bg-base-200/50',
                      )}
                    >
                      <div className='not-eink:opacity-60 mb-1 flex items-center justify-between gap-2 text-xs'>
                        <span className='line-clamp-1'>{def.source}</span>
                        {def === primary && (
                          <span className='badge badge-primary badge-xs shrink-0'>
                            {_('Primary')}
                          </span>
                        )}
                      </div>
                      {def.html ? (
                        <div
                          className='text-base-content/80 max-h-64 overflow-y-auto text-sm'
                          // Dictionary snapshots may carry anchors; block
                          // navigation so following one can't leave the app.
                          onClick={(e) => {
                            if ((e.target as Element | null)?.closest?.('a')) {
                              e.preventDefault();
                            }
                          }}
                          dangerouslySetInnerHTML={{ __html: def.html }}
                        />
                      ) : (
                        <p className='text-base-content/80 max-h-64 overflow-y-auto whitespace-pre-line text-sm'>
                          {def.content}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.contexts.length > 0 && (
            <section>
              <h3 className='not-eink:opacity-60 mb-2 text-xs font-medium uppercase tracking-wide'>
                {_('Contexts')}
              </h3>
              <ul className='flex flex-col gap-2'>
                {detail.contexts.map((context) => {
                  const jumpable = !!openBookKeyFor(context);
                  return (
                    <li key={context.id}>
                      <div
                        role={jumpable ? 'button' : undefined}
                        tabIndex={jumpable ? 0 : undefined}
                        title={jumpable ? _('Jump to context') : undefined}
                        onClick={() => jumpable && handleJumpToContext(context)}
                        onKeyDown={(e) => {
                          if (jumpable && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault();
                            handleJumpToContext(context);
                          }
                        }}
                        className={clsx(
                          'rounded-lg border border-base-content/10 p-2',
                          jumpable && 'cursor-pointer hover:bg-base-200/50',
                        )}
                      >
                        <p className='text-base-content/80 text-sm'>{context.sentence}</p>
                        <p className='text-base-content/40 mt-1 flex items-center gap-1.5 text-xs'>
                          <span className='line-clamp-1'>{context.bookTitle}</span>
                          <span>·</span>
                          <span className='shrink-0'>{dayjs(context.createdAt).fromNow()}</span>
                          {jumpable && (
                            <LuLocateFixed className='text-primary/60 ms-auto shrink-0' size={13} />
                          )}
                          <button
                            type='button'
                            aria-label={_('Speak')}
                            title={_('Speak')}
                            aria-pressed={speakingKey === context.id}
                            onClick={(e) => {
                              // Keep the tap on the card itself (jump to
                              // context) from also firing.
                              e.stopPropagation();
                              speakContext(context);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                speakContext(context);
                              }
                            }}
                            className={clsx(
                              'btn btn-ghost btn-square btn-xs shrink-0',
                              !jumpable && 'ms-auto',
                              speakingKey === context.id
                                ? 'text-primary not-eink:animate-pulse'
                                : 'text-base-content/50 hover:text-base-content not-eink:hover:bg-base-200/60',
                            )}
                          >
                            <MdVolumeUp size={15} />
                          </button>
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <div className='flex justify-end'>
            <button
              type='button'
              onClick={() => void handleDelete()}
              className='btn btn-ghost btn-sm text-error'
            >
              <LuTrash2 size={14} />
              {_('Delete')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
};

export default VocabularyDetailDialog;
