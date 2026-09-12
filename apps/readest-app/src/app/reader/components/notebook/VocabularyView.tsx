'use client';

import clsx from 'clsx';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LuBookMarked, LuSearch, LuTrash2, LuX } from 'react-icons/lu';

import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { useVocabularyStore } from '@/store/vocabularyStore';
import { VocabularyDb, type VocabularySourceBook } from '@/services/vocabulary/vocabularyDb';
import { warmWordAudio } from '@/services/tts/wordPronouncer';
import EmptyState from '../EmptyState';
import VocabularyDetailDialog from '../VocabularyDetailDialog';

const VocabularyView: React.FC = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { words, isLoading, loadWords, removeWord } = useVocabularyStore();

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [bookFilter, setBookFilter] = useState('all');
  const [sourceBooks, setSourceBooks] = useState<VocabularySourceBook[]>([]);
  const [detailWordId, setDetailWordId] = useState<string | null>(null);

  useEffect(() => {
    if (appService) void loadWords(appService);
  }, [appService, loadWords]);

  // Debounced search, mirroring BooknoteView's 300ms query effect.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Source books power the filter dropdown; recompute as captures land.
  useEffect(() => {
    let cancelled = false;
    if (!appService) return;
    void VocabularyDb.open(appService)
      .then((db) => db.listSourceBooks())
      .then((books) => {
        if (!cancelled) setSourceBooks(books);
      })
      .catch((err) => console.warn('Failed to list vocabulary source books:', err));
    return () => {
      cancelled = true;
    };
  }, [appService, words]);

  const visibleWords = useMemo(() => {
    const needle = query.toLowerCase();
    return words.filter((w) => {
      if (bookFilter !== 'all' && !w.bookHashes.includes(bookFilter)) return false;
      if (!needle) return true;
      return (
        w.word.toLowerCase().includes(needle) ||
        w.definitions.some((d) => d.content.toLowerCase().includes(needle))
      );
    });
  }, [words, query, bookFilter]);

  const handleDeleteWord = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (!appService) return;
      if (await appService.ask(_('Delete this word?'))) {
        await removeWord(appService, id);
      }
    },
    [appService, _, removeWord],
  );

  if (isLoading) {
    return (
      <div className='flex h-full items-center justify-center p-4'>
        <div className='border-primary size-5 animate-spin rounded-full border-2 border-t-transparent' />
      </div>
    );
  }

  return (
    <div className='flex h-full flex-col'>
      {/* Search + book filter row */}
      <div className='flex items-center gap-1 px-3 py-2'>
        <div className='relative flex-1'>
          <LuSearch
            className='text-base-content/50 pointer-events-none absolute start-2 top-1/2 -translate-y-1/2'
            size={13}
          />
          <input
            type='text'
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={_('Search words')}
            aria-label={_('Search words')}
            className='input input-xs h-8 w-full bg-base-100 ps-7 pe-7'
          />
          {searchInput && (
            <button
              type='button'
              onClick={() => setSearchInput('')}
              className='text-base-content/50 hover:text-base-content absolute end-1 top-1/2 -translate-y-1/2'
              aria-label={_('Clear')}
            >
              <LuX size={13} />
            </button>
          )}
        </div>
        {sourceBooks.length > 1 && (
          <select
            value={bookFilter}
            onChange={(e) => setBookFilter(e.target.value)}
            aria-label={_('Filter by book')}
            className='select select-xs h-8 max-w-[45%] bg-base-100'
          >
            <option value='all'>{_('All Books')}</option>
            {sourceBooks.map((b) => (
              <option key={b.bookHash} value={b.bookHash}>
                {b.bookTitle} ({b.count})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Word list */}
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {words.length === 0 ? (
          <EmptyState
            Icon={LuBookMarked}
            label={_('No saved words yet')}
            hint={_('Look up a word in the dictionary to save it here')}
          />
        ) : visibleWords.length === 0 ? (
          <EmptyState Icon={LuBookMarked} label={_('No matching words')} />
        ) : (
          <ul className='divide-base-300/30 divide-y pb-16'>
            {visibleWords.map((word) => (
              <li
                key={word.id}
                className={clsx(
                  'group flex cursor-pointer items-start gap-2 px-3 py-2.5',
                  'hover:bg-base-300/50 transition-colors duration-150',
                )}
                tabIndex={0}
                role='button'
                onClick={() => {
                  // Unlock the audio context inside this click gesture: the
                  // detail dialog auto-pronounces once its word loads (after
                  // an async db read), outside any user-gesture window.
                  warmWordAudio();
                  setDetailWordId(word.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    warmWordAudio();
                    setDetailWordId(word.id);
                  }
                }}
              >
                <div className='min-w-0 flex-1'>
                  <p className='text-base-content line-clamp-1 text-sm font-medium'>{word.word}</p>
                  {primaryDefinition(word) && (
                    <p className='text-base-content/50 line-clamp-1 text-xs'>
                      {primaryDefinition(word)}
                    </p>
                  )}
                  <p className='text-base-content/40 mt-0.5 flex items-center gap-1.5 text-xs'>
                    {word.lastBookTitle && (
                      <span className='line-clamp-1'>{word.lastBookTitle}</span>
                    )}
                    {word.lastBookTitle && word.contextCount > 0 && <span>·</span>}
                    {word.contextCount > 0 && (
                      <span className='shrink-0'>
                        {word.contextCount === 1
                          ? _('1 context')
                          : _('{{count}} contexts', { count: word.contextCount })}
                      </span>
                    )}
                    <span>·</span>
                    <span className='shrink-0'>{dayjs(word.updatedAt).fromNow()}</span>
                  </p>
                </div>
                <button
                  onClick={(e) => handleDeleteWord(e, word.id)}
                  className='btn btn-ghost btn-xs shrink-0 text-error opacity-0 transition-opacity group-hover:opacity-100'
                  aria-label={_('Delete')}
                >
                  <LuTrash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {detailWordId && (
        <VocabularyDetailDialog wordId={detailWordId} onClose={() => setDetailWordId(null)} />
      )}
    </div>
  );
};

function primaryDefinition(word: { definitions: { content: string }[]; primaryIndex: number }) {
  return word.definitions[word.primaryIndex]?.content ?? word.definitions[0]?.content ?? '';
}

export default VocabularyView;
