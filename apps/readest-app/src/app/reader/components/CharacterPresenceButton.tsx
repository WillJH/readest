'use client';

import React, { useMemo } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCharacterStore } from '@/store/characterStore';
import { useNotebookStore } from '@/store/notebookStore';
import CharacterAvatar from '@/components/CharacterAvatar';

/**
 * Persistent corner entry to the character's chat — presence without
 * interruption (the shelved companion's most valuable idea, minus the
 * autonomy). Shows the character you last talked with; tapping opens the
 * notebook AI tab. Hidden when AI is off or no character exists.
 */
const CharacterPresenceButton: React.FC = () => {
  const _ = useTranslation();
  const aiEnabled = useSettingsStore((s) => s.settings?.aiSettings?.enabled === true);
  const conversations = useAIChatStore((s) => s.conversations);
  const draftCharacterId = useAIChatStore((s) => s.draftCharacterId);
  const characters = useCharacterStore((s) => s.characters);
  const imageUrls = useCharacterStore((s) => s.imageUrls);

  const character = useMemo(() => {
    const id =
      [...conversations].filter((c) => c.characterId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
        ?.characterId ?? draftCharacterId;
    return characters.find((c) => c.id === id && !c.deletedAt);
  }, [conversations, draftCharacterId, characters]);

  if (!aiEnabled || !character) return null;

  const avatarUrl =
    imageUrls[
      (character.images.find((i) => i.id === character.defaultImageId) ?? character.images[0])
        ?.id ?? ''
    ];

  const handleOpen = () => {
    const notebook = useNotebookStore.getState();
    notebook.setNotebookActiveTab('ai');
    notebook.setNotebookVisible(true);
  };

  return (
    <div
      className='pointer-events-none fixed start-4 z-40'
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 4.5rem)' }}
    >
      <button
        type='button'
        onClick={handleOpen}
        title={_('{{name}} — open chat', { name: character.name })}
        aria-label={_('{{name}} — open chat', { name: character.name })}
        className='pointer-events-auto rounded-full border border-base-content/15 opacity-85 shadow-lg transition-all hover:scale-105 hover:opacity-100 active:scale-95'
      >
        <CharacterAvatar name={character.name} url={avatarUrl} size={44} />
      </button>
    </div>
  );
};

export default CharacterPresenceButton;
