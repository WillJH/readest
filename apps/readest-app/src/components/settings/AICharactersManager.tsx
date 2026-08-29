'use client';

import clsx from 'clsx';
import React, { useCallback, useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { LuPencil, LuPlus, LuStar, LuTrash2, LuUserRound } from 'react-icons/lu';

import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { useCharacterStore } from '@/store/characterStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useFileSelector } from '@/hooks/useFileSelector';
import type { AICharacter } from '@/services/ai/types';
import SubPageHeader from './SubPageHeader';

interface AICharactersManagerProps {
  onBack: () => void;
}

const AICharactersManager: React.FC<AICharactersManagerProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings } = useSettingsStore();
  const connections = settings?.aiConnections ?? [];
  const {
    characters,
    imageUrls,
    loadCharacters,
    upsertCharacter,
    removeCharacter,
    addImage,
    removeImage,
    setDefaultImage,
    renameImageLabel,
  } = useCharacterStore();
  const { selectFiles } = useFileSelector(appService, _);

  const [editor, setEditor] = useState<AICharacter | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    if (envConfig) void loadCharacters(envConfig);
  }, [envConfig, loadCharacters]);

  const handleNew = useCallback(() => {
    setIsNew(true);
    setNameError(false);
    setEditor({
      id: uuidv4(),
      name: '',
      prompt: '',
      images: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }, []);

  const handleEdit = useCallback((character: AICharacter) => {
    setIsNew(false);
    setNameError(false);
    setEditor({ ...character });
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditor(null);
    setIsNew(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editor) return;
    if (!editor.name.trim()) {
      setNameError(true);
      return;
    }
    await upsertCharacter(envConfig, { ...editor, name: editor.name.trim() });
    if (isNew) {
      // Keep the editor open so the gallery (which needs the saved id) is
      // immediately usable.
      setIsNew(false);
    } else {
      handleCloseEditor();
    }
  }, [editor, envConfig, upsertCharacter, isNew, handleCloseEditor]);

  const handleDelete = useCallback(
    async (character: AICharacter) => {
      if (await appService?.ask(_('Delete this character?'))) {
        await removeCharacter(envConfig, character.id);
      }
    },
    [appService, envConfig, removeCharacter, _],
  );

  const handleAddImage = useCallback(async () => {
    if (!editor) return;
    const { files } = await selectFiles({ type: 'images', multiple: true });
    for (const selected of files) {
      const file = selected.path ?? selected.file;
      if (!file) continue;
      const image = await addImage(envConfig, editor.id, file);
      if (image) {
        setEditor((prev) =>
          prev
            ? {
                ...prev,
                images: [...prev.images, image],
                defaultImageId: prev.defaultImageId ?? image.id,
              }
            : prev,
        );
      }
    }
  }, [editor, envConfig, addImage, selectFiles]);

  const handleRemoveImage = useCallback(
    async (imageId: string) => {
      if (!editor) return;
      setEditor((prev) =>
        prev
          ? {
              ...prev,
              images: prev.images.filter((i) => i.id !== imageId),
              defaultImageId:
                prev.defaultImageId === imageId
                  ? (prev.images.find((i) => i.id !== imageId)?.id ?? undefined)
                  : prev.defaultImageId,
            }
          : prev,
      );
      await removeImage(envConfig, editor.id, imageId);
    },
    [editor, envConfig, removeImage],
  );

  const handleSetDefault = useCallback(
    async (imageId: string) => {
      if (!editor) return;
      setEditor((prev) => (prev ? { ...prev, defaultImageId: imageId } : prev));
      await setDefaultImage(envConfig, editor.id, imageId);
    },
    [editor, envConfig, setDefaultImage],
  );

  const handleRenameLabel = useCallback(
    async (imageId: string, label: string) => {
      if (!editor) return;
      setEditor((prev) =>
        prev
          ? { ...prev, images: prev.images.map((i) => (i.id === imageId ? { ...i, label } : i)) }
          : prev,
      );
      if (label.trim()) await renameImageLabel(envConfig, editor.id, imageId, label);
    },
    [editor, envConfig, renameImageLabel],
  );

  const avatarUrlFor = useCallback(
    (character: AICharacter) =>
      imageUrls[character.defaultImageId ?? character.images[0]?.id ?? ''] ?? '',
    [imageUrls],
  );

  return (
    <div className='my-2 w-full'>
      <SubPageHeader
        parentLabel={_('AI')}
        currentLabel={_('Characters')}
        description={_(
          'Personas with their own prompt and an avatar gallery the AI picks from while chatting.',
        )}
        onBack={onBack}
        rightSlot={
          <button type='button' className='btn btn-outline btn-sm' onClick={handleNew}>
            <LuPlus size={14} />
            {_('New Character')}
          </button>
        }
      />

      {characters.length === 0 ? (
        <div className='flex flex-col items-center justify-center gap-3 p-8 text-center'>
          <div className='bg-base-300/50 rounded-full p-3'>
            <LuUserRound className='text-base-content/50 size-6' />
          </div>
          <div>
            <p className='text-base-content/70 text-sm'>{_('No characters yet')}</p>
            <p className='text-base-content/50 text-xs'>
              {_('Create one to give the AI a custom persona and avatars.')}
            </p>
          </div>
        </div>
      ) : (
        <ul className='divide-base-300/30 divide-y'>
          {characters.map((character) => (
            <li
              key={character.id}
              className='group hover:bg-base-300/50 flex items-center gap-3 px-4 py-3 transition-colors duration-150'
            >
              <div className='bg-base-300/60 flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full'>
                {avatarUrlFor(character) ? (
                  <img
                    src={avatarUrlFor(character)}
                    alt={character.name}
                    className='size-full object-cover'
                  />
                ) : (
                  <LuUserRound className='text-base-content/40 size-5' />
                )}
              </div>
              <div className='min-w-0 flex-1'>
                <p className='text-base-content line-clamp-1 text-sm font-medium'>
                  {character.name}
                </p>
                <p className='text-base-content/50 line-clamp-1 text-xs'>
                  {character.prompt || _('No persona prompt')}
                  {character.images.length > 0 && ` · ${character.images.length} ${_('images')}`}
                </p>
              </div>
              <div className='flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100'>
                <button
                  type='button'
                  onClick={() => handleEdit(character)}
                  className='btn btn-ghost btn-xs'
                  aria-label={_('Edit')}
                >
                  <LuPencil size={12} />
                </button>
                <button
                  type='button'
                  onClick={() => void handleDelete(character)}
                  className='btn btn-ghost btn-xs text-error'
                  aria-label={_('Delete')}
                >
                  <LuTrash2 size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        isOpen={!!editor}
        onClose={handleCloseEditor}
        title={isNew ? _('New Character') : (editor?.name ?? _('Character'))}
        boxClassName='sm:min-w-[480px]!'
      >
        {editor && (
          <div className='flex flex-col gap-4'>
            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>{_('Name')}</span>
              <input
                type='text'
                className={clsx('input input-sm w-full', nameError && 'input-error')}
                value={editor.name}
                onChange={(e) => {
                  setNameError(false);
                  setEditor({ ...editor, name: e.target.value });
                }}
                placeholder={_('e.g. Alice')}
              />
              {nameError && <span className='text-error text-xs'>{_('Name is required')}</span>}
            </div>

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>
                {_('Persona Prompt')}
              </span>
              <textarea
                className='textarea eink-bordered w-full text-sm'
                rows={6}
                spellCheck={false}
                value={editor.prompt}
                onChange={(e) => setEditor({ ...editor, prompt: e.target.value })}
                placeholder={_(
                  'Describe the personality, speaking style, and role. Anti-spoiler rules always apply on top of this.',
                )}
              />
            </div>

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>{_('AI Connection')}</span>
              <select
                value={editor.connectionId ?? ''}
                onChange={(e) =>
                  setEditor({ ...editor, connectionId: e.target.value || undefined })
                }
                className='select select-sm w-full bg-base-100'
              >
                <option value=''>{_('Global Settings')}</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className='text-base-content/60 text-xs'>
                {_('The model this character chats through; embeddings stay global.')}
              </span>
            </div>

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>{_('Mode')}</span>
              <select
                value={editor.mode ?? 'response'}
                onChange={(e) =>
                  setEditor({ ...editor, mode: e.target.value as AICharacter['mode'] })
                }
                className='select select-sm w-full bg-base-100'
              >
                <option value='response'>{_('Response Mode — speaks when asked')}</option>
                <option value='companion'>{_('Companion Mode — speaks up on its own')}</option>
              </select>
              <span className='text-base-content/60 text-xs'>
                {_('Companion mode arrives in a later update; stored per character.')}
              </span>
            </div>

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>
                {_('Avatar Gallery')}
              </span>
              {isNew ? (
                <p className='text-base-content/50 text-xs'>
                  {_('Create the character first to add images.')}
                </p>
              ) : (
                <>
                  <div className='grid grid-cols-3 gap-2'>
                    {editor.images.map((image) => (
                      <div
                        key={image.id}
                        className={clsx(
                          'relative flex flex-col gap-1 rounded-lg border p-1.5',
                          image.id === editor.defaultImageId
                            ? 'border-primary/50 bg-primary/5'
                            : 'border-base-content/10',
                        )}
                      >
                        <div className='bg-base-300/60 relative aspect-square overflow-hidden rounded-md'>
                          {imageUrls[image.id] ? (
                            <img
                              src={imageUrls[image.id]}
                              alt={image.label}
                              className='size-full object-cover'
                            />
                          ) : (
                            <div className='text-base-content/30 flex size-full items-center justify-center text-xs'>
                              N/A
                            </div>
                          )}
                          <button
                            type='button'
                            onClick={() => void handleRemoveImage(image.id)}
                            className='btn btn-circle btn-ghost btn-xs absolute end-0.5 top-0.5 text-error'
                            aria-label={_('Delete')}
                          >
                            <LuTrash2 size={11} />
                          </button>
                          {image.id !== editor.defaultImageId && (
                            <button
                              type='button'
                              onClick={() => void handleSetDefault(image.id)}
                              className='btn btn-circle btn-ghost btn-xs absolute start-0.5 top-0.5'
                              aria-label={_('Set as default')}
                              title={_('Set as default')}
                            >
                              <LuStar className='text-base-content/50' size={11} />
                            </button>
                          )}
                        </div>
                        <input
                          type='text'
                          className='input input-xs w-full bg-transparent px-1'
                          value={image.label}
                          onChange={(e) => void handleRenameLabel(image.id, e.target.value)}
                          aria-label={_('Image label')}
                          title={_('The AI uses this label to pick the avatar')}
                        />
                        {image.id === editor.defaultImageId && (
                          <span className='badge badge-primary badge-xs absolute -start-1 -top-1'>
                            {_('Default')}
                          </span>
                        )}
                      </div>
                    ))}
                    <button
                      type='button'
                      onClick={() => void handleAddImage()}
                      className='border-base-content/20 hover:bg-base-200/50 flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs'
                    >
                      <LuPlus className='text-base-content/50' size={18} />
                      {_('Add Image')}
                    </button>
                  </div>
                  <p className='text-base-content/50 text-xs'>
                    {_(
                      'The AI starts each reply with an avatar tag matching its mood; labels name the choices.',
                    )}
                  </p>
                </>
              )}
            </div>

            <div className='flex justify-end gap-2'>
              <button type='button' className='btn btn-ghost btn-sm' onClick={handleCloseEditor}>
                {_('Cancel')}
              </button>
              <button
                type='button'
                className='btn btn-primary btn-sm'
                onClick={() => void handleSave()}
              >
                {isNew ? _('Create') : _('Save')}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
};

export default AICharactersManager;
