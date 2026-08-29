'use client';

import clsx from 'clsx';
import React, { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { LuPencil, LuPlus, LuTrash2, LuPlugZap } from 'react-icons/lu';

import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import type { AIConnection, AIProviderName } from '@/services/ai/types';
import SubPageHeader from './SubPageHeader';

interface AIConnectionsManagerProps {
  onBack: () => void;
}

const PROVIDERS: AIProviderName[] = ['openrouter', 'ai-gateway', 'ollama'];

/** Friendly labels — 'openrouter' is the generic OpenAI-compatible type. */
const PROVIDER_LABELS: Record<AIProviderName, string> = {
  openrouter: 'OpenAI-Compatible (OpenRouter / coding plans / vLLM…)',
  'ai-gateway': 'Readest AI Gateway',
  ollama: 'Ollama (local)',
};

const AIConnectionsManager: React.FC<AIConnectionsManagerProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const connections = settings?.aiConnections ?? [];
  const [editor, setEditor] = useState<AIConnection | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [nameError, setNameError] = useState(false);

  const persist = useCallback(
    async (list: AIConnection[]) => {
      if (!settings) return;
      const next = { ...settings, aiConnections: list };
      setSettings(next);
      await saveSettings(envConfig, next);
    },
    [settings, setSettings, saveSettings, envConfig],
  );

  const handleNew = useCallback(() => {
    setIsNew(true);
    setNameError(false);
    setEditor({
      id: uuidv4(),
      name: '',
      provider: 'openrouter',
      baseUrl: '',
      apiKey: '',
      model: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }, []);

  const handleEdit = useCallback((connection: AIConnection) => {
    setIsNew(false);
    setNameError(false);
    setEditor({ ...connection });
  }, []);

  const handleSave = useCallback(async () => {
    if (!editor) return;
    if (!editor.name.trim()) {
      setNameError(true);
      return;
    }
    const saved = { ...editor, name: editor.name.trim(), updatedAt: Date.now() };
    const list = connections.some((c) => c.id === saved.id)
      ? connections.map((c) => (c.id === saved.id ? saved : c))
      : [...connections, saved];
    await persist(list);
    setEditor(null);
    setIsNew(false);
  }, [editor, connections, persist]);

  const handleDelete = useCallback(
    async (connection: AIConnection) => {
      if (await appService?.ask(_('Delete this connection?'))) {
        await persist(connections.filter((c) => c.id !== connection.id));
      }
    },
    [appService, connections, persist, _],
  );

  const baseUrlLabel =
    editor?.provider === 'ollama' ? _('Server URL') : _('Base URL (OpenAI-compatible)');

  return (
    <div className='my-2 w-full'>
      <SubPageHeader
        parentLabel={_('AI')}
        currentLabel={_('Connections')}
        description={_(
          'Saved provider endpoints. Bind one to a character so it chats through its own model.',
        )}
        onBack={onBack}
        rightSlot={
          <button type='button' className='btn btn-outline btn-sm' onClick={handleNew}>
            <LuPlus size={14} />
            {_('New Connection')}
          </button>
        }
      />

      {connections.length === 0 ? (
        <div className='flex flex-col items-center justify-center gap-3 p-8 text-center'>
          <div className='bg-base-300/50 rounded-full p-3'>
            <LuPlugZap className='text-base-content/50 size-6' />
          </div>
          <div>
            <p className='text-base-content/70 text-sm'>{_('No connections yet')}</p>
            <p className='text-base-content/50 text-xs'>
              {_('Save multiple endpoints and bind them per character.')}
            </p>
          </div>
        </div>
      ) : (
        <ul className='divide-base-300/30 divide-y'>
          {connections.map((connection) => (
            <li
              key={connection.id}
              className='group hover:bg-base-300/50 flex items-center gap-3 px-4 py-3 transition-colors duration-150'
            >
              <div className='min-w-0 flex-1'>
                <p className='text-base-content line-clamp-1 text-sm font-medium'>
                  {connection.name}
                </p>
                <p className='text-base-content/50 line-clamp-1 text-xs'>
                  <span className='badge badge-ghost badge-xs me-1'>
                    {_(PROVIDER_LABELS[connection.provider])}
                  </span>
                  {[connection.baseUrl, connection.model].filter(Boolean).join(' · ') ||
                    _('No endpoint configured')}
                </p>
              </div>
              <div className='flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100'>
                <button
                  type='button'
                  onClick={() => handleEdit(connection)}
                  className='btn btn-ghost btn-xs'
                  aria-label={_('Edit')}
                >
                  <LuPencil size={12} />
                </button>
                <button
                  type='button'
                  onClick={() => void handleDelete(connection)}
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
        onClose={() => {
          setEditor(null);
          setIsNew(false);
        }}
        title={isNew ? _('New Connection') : (editor?.name ?? _('Connection'))}
        boxClassName='sm:min-w-[460px]!'
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
                placeholder={_('e.g. Coding Plan')}
              />
              {nameError && <span className='text-error text-xs'>{_('Name is required')}</span>}
            </div>

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>{_('Provider')}</span>
              <select
                value={editor.provider}
                onChange={(e) =>
                  setEditor({ ...editor, provider: e.target.value as AIProviderName })
                }
                className='select select-sm w-full bg-base-100'
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {_(PROVIDER_LABELS[p])}
                  </option>
                ))}
              </select>
              <span className='text-base-content/60 text-xs'>
                {_(
                  'OpenAI-compatible covers OpenRouter, Together, Groq, vLLM, and coding-plan endpoints.',
                )}
              </span>
            </div>

            {editor.provider !== 'ai-gateway' && (
              <div className='flex flex-col gap-2'>
                <span className='text-base-content/70 text-sm font-medium'>{baseUrlLabel}</span>
                <input
                  type='text'
                  className='input input-sm w-full'
                  value={editor.baseUrl ?? ''}
                  onChange={(e) => setEditor({ ...editor, baseUrl: e.target.value })}
                  placeholder={
                    editor.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://.../v1'
                  }
                />
              </div>
            )}

            {editor.provider !== 'ollama' && (
              <div className='flex flex-col gap-2'>
                <span className='text-base-content/70 text-sm font-medium'>{_('API Key')}</span>
                <input
                  type='password'
                  className='input input-sm w-full'
                  value={editor.apiKey ?? ''}
                  onChange={(e) => setEditor({ ...editor, apiKey: e.target.value })}
                  placeholder='sk-...'
                  autoComplete='off'
                />
              </div>
            )}

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>{_('Model')}</span>
              <input
                type='text'
                className='input input-sm w-full'
                value={editor.model ?? ''}
                onChange={(e) => setEditor({ ...editor, model: e.target.value })}
                placeholder={_('Chat model id')}
              />
              <span className='text-base-content/60 text-xs'>
                {_('Embedding models stay on the global AI settings.')}
              </span>
            </div>

            <div className='flex justify-end gap-2'>
              <button
                type='button'
                className='btn btn-ghost btn-sm'
                onClick={() => {
                  setEditor(null);
                  setIsNew(false);
                }}
              >
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

export default AIConnectionsManager;
