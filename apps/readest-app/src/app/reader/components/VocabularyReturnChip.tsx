'use client';

import React, { useEffect } from 'react';
import { LuUndo2 } from 'react-icons/lu';

import { useTranslation } from '@/hooks/useTranslation';
import { useReaderStore } from '@/store/readerStore';
import { useVocabularyStore } from '@/store/vocabularyStore';
import { eventDispatcher } from '@/utils/event';

/** How long the chip stays before fading out. */
const AUTO_DISMISS_MS = 60_000;

/**
 * Floating "back to reading position" chip shown after a vocabulary context
 * jump displaced the reader. One slot — the latest jump wins; a new jump
 * refreshes the timer. Auto-dismisses so it never lingers stale.
 */
const VocabularyReturnChip: React.FC = () => {
  const _ = useTranslation();
  const getView = useReaderStore((s) => s.getView);
  const jumpedFrom = useVocabularyStore((s) => s.jumpedFrom);
  const clearJumpedFrom = useVocabularyStore((s) => s.clearJumpedFrom);

  useEffect(() => {
    if (!jumpedFrom) return;
    const timer = setTimeout(() => clearJumpedFrom(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [jumpedFrom, clearJumpedFrom]);

  if (!jumpedFrom) return null;

  const handleReturn = () => {
    const { bookKey, cfi } = jumpedFrom;
    clearJumpedFrom();
    eventDispatcher.dispatch('navigate', { bookKey, cfi });
    getView(bookKey)?.goTo(cfi);
  };

  return (
    <div
      className='pointer-events-none fixed end-4 z-40'
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 4.5rem)' }}
    >
      <button
        type='button'
        onClick={handleReturn}
        className='btn btn-neutral btn-sm pointer-events-auto flex items-center gap-2 rounded-full border border-base-content/10 opacity-90 shadow-lg'
        title={_('Back to reading position')}
      >
        <LuUndo2 size={14} />
        <span className='text-xs font-medium'>{_('Back to reading position')}</span>
      </button>
    </div>
  );
};

export default VocabularyReturnChip;
