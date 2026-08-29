'use client';

import React from 'react';

import Dialog from '@/components/Dialog';
import {
  useDictionaryResults,
  DictionaryResultsHeader,
  DictionaryResultsBody,
  vocabularyHeaderProps,
  UseDictionaryResultsArgs,
} from './DictionaryResultsView';

interface DictionarySheetProps {
  word: string;
  lang?: string;
  onDismiss: () => void;
  onManage?: () => void;
  /** Persist a word to the vocabulary book (manual + auto capture). */
  onVocabularyCapture?: UseDictionaryResultsArgs['onVocabularyCapture'];
}

const DictionarySheet: React.FC<DictionarySheetProps> = ({
  word,
  lang,
  onDismiss,
  onManage,
  onVocabularyCapture,
}) => {
  const state = useDictionaryResults({ word, lang, onVocabularyCapture });
  return (
    <Dialog
      isOpen
      snapHeight={0.75}
      dismissible
      header={
        <DictionaryResultsHeader
          // The -mt-4 compensates for Dialog's drag handle, which is `sm:hidden`
          // (shown only below sm). Mirror that breakpoint so on sm+ (no handle)
          // the header isn't pulled up into the top edge.
          headerClassName='-mt-4 sm:mt-0'
          currentWord={state.currentWord}
          canGoBack={state.canGoBack}
          goBack={state.goBack}
          onManage={onManage}
          onSpeak={state.speakWord}
          speaking={state.isSpeaking}
          {...vocabularyHeaderProps(state, onVocabularyCapture)}
        />
      }
      contentClassName='px-0! mt-0!'
      onClose={onDismiss}
    >
      <DictionaryResultsBody {...state} />
    </Dialog>
  );
};

export default DictionarySheet;
