'use client';

import clsx from 'clsx';
import React, { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { LuPencil, LuPlus, LuTrash2, LuPlug, LuRefreshCw } from 'react-icons/lu';

import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { testMcpServer } from '@/services/mcp/mcpClient';
import type { AIMcpServer } from '@/services/ai/types';
import SubPageHeader from './SubPageHeader';

interface AIMcpServersManagerProps {
  onBack: () => void;
}

const AIMcpServersManager: React.FC<AIMcpServersManagerProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const servers = settings?.aiMcpServers ?? [];
  const [editor, setEditor] = useState<AIMcpServer | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [testing, setTesting] = useState(false);

  const persist = useCallback(
    async (list: AIMcpServer[]) => {
      if (!settings) return;
      const next = { ...settings, aiMcpServers: list };
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
      url: '',
      headers: [],
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }, []);

  const handleEdit = useCallback((server: AIMcpServer) => {
    setIsNew(false);
    setNameError(false);
    setEditor({ ...server });
  }, []);

  const handleSave = useCallback(async () => {
    if (!editor) return;
    if (!editor.name.trim() || !editor.url.trim()) {
      setNameError(true);
      return;
    }
    const saved = {
      ...editor,
      name: editor.name.trim(),
      url: editor.url.trim(),
      updatedAt: Date.now(),
    };
    const list = servers.some((s) => s.id === saved.id)
      ? servers.map((s) => (s.id === saved.id ? saved : s))
      : [...servers, saved];
    await persist(list);
    setEditor(null);
    setIsNew(false);
  }, [editor, servers, persist]);

  const handleDelete = useCallback(
    async (server: AIMcpServer) => {
      if (await appService?.ask(_('Delete this MCP server?'))) {
        await persist(servers.filter((s) => s.id !== server.id));
      }
    },
    [appService, servers, persist, _],
  );

  const handleTest = useCallback(async () => {
    if (!editor?.url.trim()) return;
    setTesting(true);
    const result = await testMcpServer({ ...editor, url: editor.url.trim() });
    setTesting(false);
    eventDispatcher.dispatch('toast', {
      message: result.ok
        ? _('Connected — {{count}} tools', { count: result.toolCount ?? 0 })
        : `${_('Connection failed')}: ${result.error ?? ''}`.slice(0, 120),
      type: result.ok ? 'success' : 'error',
      timeout: 4000,
    });
  }, [editor, _]);

  return (
    <div className='my-2 w-full'>
      <SubPageHeader
        parentLabel={_('AI')}
        currentLabel={_('MCP Servers')}
        description={_(
          'Tool servers the AI can call while chatting (web search, lookups…). Direct connections only in v1.',
        )}
        onBack={onBack}
        rightSlot={
          <button type='button' className='btn btn-outline btn-sm' onClick={handleNew}>
            <LuPlus size={14} />
            {_('New Server')}
          </button>
        }
      />

      {servers.length === 0 ? (
        <div className='flex flex-col items-center justify-center gap-3 p-8 text-center'>
          <div className='bg-base-300/50 rounded-full p-3'>
            <LuPlug className='text-base-content/50 size-6' />
          </div>
          <div>
            <p className='text-base-content/70 text-sm'>{_('No MCP servers yet')}</p>
            <p className='text-base-content/50 text-xs'>
              {_('Add a Streamable-HTTP endpoint and the AI can use its tools.')}
            </p>
          </div>
        </div>
      ) : (
        <ul className='divide-base-300/30 divide-y'>
          {servers.map((server) => (
            <li
              key={server.id}
              className='group hover:bg-base-300/50 flex items-center gap-3 px-4 py-3 transition-colors duration-150'
            >
              <div className='min-w-0 flex-1'>
                <p className='text-base-content line-clamp-1 text-sm font-medium'>
                  {server.name}
                  {!server.enabled && (
                    <span className='text-base-content/40 ms-2 text-xs'>({_('Disabled')})</span>
                  )}
                </p>
                <p className='text-base-content/50 line-clamp-1 text-xs'>{server.url}</p>
              </div>
              <div className='flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100'>
                <button
                  type='button'
                  onClick={() => handleEdit(server)}
                  className='btn btn-ghost btn-xs'
                  aria-label={_('Edit')}
                >
                  <LuPencil size={12} />
                </button>
                <button
                  type='button'
                  onClick={() => void handleDelete(server)}
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
        title={isNew ? _('New Server') : (editor?.name ?? _('MCP Server'))}
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
                placeholder={_('e.g. Web Search')}
              />
            </div>

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>{_('Server URL')}</span>
              <input
                type='text'
                className={clsx('input input-sm w-full', nameError && 'input-error')}
                value={editor.url}
                onChange={(e) => {
                  setNameError(false);
                  setEditor({ ...editor, url: e.target.value });
                }}
                placeholder='https://example.com/mcp'
              />
              {nameError && (
                <span className='text-error text-xs'>{_('Name and URL are required')}</span>
              )}
              <span className='text-base-content/60 text-xs'>
                {_('Streamable-HTTP endpoint; legacy SSE is tried automatically.')}
              </span>
            </div>

            <div className='flex flex-col gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>
                {_('Headers (optional, one Key: Value per line)')}
              </span>
              <textarea
                className='textarea eink-bordered w-full font-mono text-sm placeholder:text-xs'
                rows={3}
                spellCheck={false}
                value={(editor.headers ?? []).join('\n')}
                onChange={(e) => setEditor({ ...editor, headers: e.target.value.split('\n') })}
                placeholder={'Authorization: Bearer …'}
              />
            </div>

            <label className='flex cursor-pointer items-center justify-between gap-2'>
              <span className='text-base-content/70 text-sm font-medium'>{_('Enabled')}</span>
              <input
                type='checkbox'
                className='toggle toggle-sm'
                checked={editor.enabled}
                onChange={(e) => setEditor({ ...editor, enabled: e.target.checked })}
              />
            </label>

            <div className='flex items-center justify-between gap-2'>
              <button
                type='button'
                className='btn btn-outline btn-sm'
                onClick={() => void handleTest()}
                disabled={testing || !editor.url.trim()}
              >
                {testing ? (
                  <LuRefreshCw className='animate-spin' size={14} />
                ) : (
                  <LuPlug size={14} />
                )}
                {testing ? _('Testing…') : _('Test Connection')}
              </button>
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
          </div>
        )}
      </Dialog>
    </div>
  );
};

export default AIMcpServersManager;
