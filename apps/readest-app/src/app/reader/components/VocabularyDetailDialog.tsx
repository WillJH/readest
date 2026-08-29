'use client';

import clsx from 'clsx';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useState } from 'react';
import { LuLocateFixed, LuTrash2 } from 'react-icons/lu';

import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { getBookProgress } from '@/store/readerProgressStore';
import { useVocabularyStore } from '@/store/vocabularyStore';
import { VocabularyDb } from '@/services/vocabulary/vocabularyDb';
import type { VocabularyContext, VocabularyWordDetail } from '@/types/vocabulary';
import { eventDispatcher } from '@/utils/event';

interface VocabularyDetailDialogProps {
  wordId: string;
  onClose: () => void;
}

const VocabularyDetailDialog: React.FC<VocabularyDetailDialogProps> = ({ wordId, onClose }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const getView = useReaderStore((s) => s.getView);
  const bookKeys = useReaderStore((s) => s.bookKeys);
  const { removeWord, refreshIfLoaded } = useVocabularyStore();

  const [detail, setDetail] = useState<VocabularyWordDetail | null>(null);

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

  const handleSetPrimary = useCallback(
    async (index: number) => {
      if (!appService || !detail || detail.primaryIndex === index) return;
      setDetail({ ...detail, primaryIndex: index });
      const db = await VocabularyDb.open(appService);
      await db.setPrimaryDefinition(detail.id, index);
      void refreshIfLoaded();
    },
    [appService, detail, refreshIfLoaded],
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
      snapHeight={0.7}
      boxClassName='sm:min-w-[460px]!'
    >
      {detail && (
        <div className='flex flex-col gap-4'>
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
