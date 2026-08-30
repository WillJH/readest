import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PiArrowCounterClockwise, PiPlugs, PiPlug, PiUserCircle } from 'react-icons/pi';

import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/services/ai/prompts';
import { buildAiBackup, parseAiBackup, applyAiBackup } from '@/services/ai/aiBackup';
import { liveConnections } from '@/services/ai/connectionSettings';
import { useFileSelector } from '@/hooks/useFileSelector';
import type { AISettings } from '@/services/ai/types';
import { exportReedyMetricsBundle } from '@/services/reedy/instrumentation';
import { isTauriAppPlatform } from '@/services/environment';
import { BoxedList, NavigationRow, SettingLabel, SettingsSwitchRow } from './primitives';
import AICharactersManager from './AICharactersManager';
import AIConnectionsManager from './AIConnectionsManager';
import AIMcpServersManager from './AIMcpServersManager';

/**
 * AI Assistant settings. Provider credentials live exclusively in
 * "Manage Connections" (bound per character, with a default-connection
 * fallback); this panel only carries user-level preferences: the prompt
 * template, standing instructions, retrieval behaviour, and the dedicated
 * RAG indexing connection.
 */
const AIPanel: React.FC = () => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const aiSettings: AISettings = settings?.aiSettings ?? DEFAULT_AI_SETTINGS;
  const connections = liveConnections(settings);

  const [enabled, setEnabled] = useState(aiSettings.enabled);
  const [reedyEnabled, setReedyEnabled] = useState(aiSettings.reedy?.enabled ?? false);
  const [reedyAgentRuntime, setReedyAgentRuntime] = useState(
    (aiSettings.reedy?.runtime ?? 'mvp') === 'agent',
  );
  const [showCharacters, setShowCharacters] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [showMcpServers, setShowMcpServers] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [backupBusy, setBackupBusy] = useState(false);
  const { selectFiles } = useFileSelector(appService, _);
  const [userInstructions, setUserInstructions] = useState(aiSettings.userInstructions ?? '');
  const [systemPromptTemplate, setSystemPromptTemplate] = useState(
    aiSettings.systemPromptTemplate ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  );

  const isMounted = useRef(false);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const saveAiSetting = useCallback(
    async (key: keyof AISettings, value: AISettings[keyof AISettings]) => {
      const currentSettings = settingsRef.current;
      if (!currentSettings) return;
      const currentAiSettings: AISettings = currentSettings.aiSettings ?? DEFAULT_AI_SETTINGS;
      const newAiSettings: AISettings = { ...currentAiSettings, [key]: value };
      const newSettings = { ...currentSettings, aiSettings: newAiSettings };

      setSettings(newSettings);
      await saveSettings(envConfig, newSettings);
    },
    [envConfig, setSettings, saveSettings],
  );

  useEffect(() => {
    if (!isMounted.current) return;
    if (enabled !== aiSettings.enabled) {
      saveAiSetting('enabled', enabled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Debounced: a multi-line prompt shouldn't write settings on every keystroke.
  useEffect(() => {
    if (!isMounted.current) return;
    const timer = setTimeout(() => {
      if (userInstructions !== (settingsRef.current?.aiSettings?.userInstructions ?? '')) {
        saveAiSetting('userInstructions', userInstructions);
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userInstructions]);

  // Storing the default text itself (rather than clearing) keeps the editor
  // and the prompt in sync after Restore Default.
  useEffect(() => {
    if (!isMounted.current) return;
    const timer = setTimeout(() => {
      if (systemPromptTemplate !== (settingsRef.current?.aiSettings?.systemPromptTemplate ?? '')) {
        saveAiSetting('systemPromptTemplate', systemPromptTemplate);
      }
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemPromptTemplate]);

  useEffect(() => {
    isMounted.current = true;
  }, []);

  const handleExport = async () => {
    if (!appService || !settings || !envConfig) return;
    setBackupBusy(true);
    try {
      const data = await buildAiBackup(appService, settings, { includeSecrets });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `readest-ai-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('[ai-backup] export failed:', err);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImport = async () => {
    if (!appService || !settings || !envConfig) return;
    const { files } = await selectFiles({ type: 'generic' });
    const file = files[0]?.file;
    if (!file) return;
    setBackupBusy(true);
    try {
      const text = await file.text();
      const data = parseAiBackup(text);
      const result = await applyAiBackup(appService, envConfig, settings, data);
      eventDispatcher.dispatch('toast', {
        message: _(
          'Imported {{connections}} connections, {{characters}} characters ({{images}} avatars), {{servers}} MCP servers',
          {
            connections: result.connections,
            characters: result.characters,
            images: result.images,
            servers: result.mcpServers,
          },
        ),
        type: 'success',
        timeout: 4000,
      });
    } catch (err) {
      eventDispatcher.dispatch('toast', {
        message: `${_('Import failed')}: ${err instanceof Error ? err.message : String(err)}`,
        type: 'error',
        timeout: 4000,
      });
    } finally {
      setBackupBusy(false);
    }
  };

  const disabledSection = !enabled ? 'opacity-50 pointer-events-none select-none' : '';

  if (showCharacters) {
    return <AICharactersManager onBack={() => setShowCharacters(false)} />;
  }

  if (showConnections) {
    return <AIConnectionsManager onBack={() => setShowConnections(false)} />;
  }

  if (showMcpServers) {
    return <AIMcpServersManager onBack={() => setShowMcpServers(false)} />;
  }

  return (
    <div className='my-4 w-full space-y-6'>
      <BoxedList title={_('AI Assistant')}>
        <SettingsSwitchRow
          label={_('Enable AI Assistant')}
          checked={enabled}
          onChange={() => setEnabled(!enabled)}
        />
      </BoxedList>

      <BoxedList
        title={_('Connections')}
        className={disabledSection}
        cardClassName='overflow-hidden'
      >
        <NavigationRow
          icon={PiPlugs}
          title={_('Manage Connections')}
          status={_('The only place providers and API keys are configured.')}
          onClick={() => setShowConnections(true)}
        />
        <div className='flex flex-col gap-2 px-4 py-3'>
          <SettingLabel>{_('RAG Indexing Connection')}</SettingLabel>
          <select
            className='select select-sm bg-base-100 text-base-content w-full'
            value={aiSettings.ragConnectionId ?? ''}
            onChange={(e) => void saveAiSetting('ragConnectionId', e.target.value || undefined)}
            disabled={!enabled}
          >
            <option value=''>{_('Same as the default connection')}</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className='text-base-content/60 text-xs'>
            {_(
              'Embeddings for book indexing and retrieval. Point it at a cheap embedding-capable endpoint — chat connections never need embeddings. Changing it requires re-indexing.',
            )}
          </span>
        </div>
      </BoxedList>

      <BoxedList
        title={_('MCP Servers')}
        className={disabledSection}
        cardClassName='overflow-hidden'
      >
        <NavigationRow
          icon={PiPlug}
          title={_('Manage MCP Servers')}
          status={_('Tool servers the AI can call while chatting.')}
          onClick={() => setShowMcpServers(true)}
        />
      </BoxedList>

      <BoxedList
        title={_('Characters')}
        className={disabledSection}
        cardClassName='overflow-hidden'
      >
        <NavigationRow
          icon={PiUserCircle}
          title={_('Manage Characters')}
          status={_('Personas bound to a connection, with the MCP tools they may use.')}
          onClick={() => setShowCharacters(true)}
        />
      </BoxedList>

      <BoxedList
        title={_('Backup & Restore')}
        className={disabledSection}
        description={_(
          'Export connections, characters (with avatars), MCP servers, and prompts to one file; import merges by id.',
        )}
      >
        <SettingsSwitchRow
          label={_('Include API keys and auth headers')}
          checked={includeSecrets}
          onChange={() => setIncludeSecrets(!includeSecrets)}
        />
        <div className='flex items-center justify-between gap-3 px-4 py-3'>
          <button
            type='button'
            className='btn btn-outline btn-sm'
            disabled={!enabled || backupBusy || !appService || !settings}
            onClick={() => void handleExport()}
          >
            {backupBusy ? _('Exporting…') : _('Export')}
          </button>
          <button
            type='button'
            className='btn btn-outline btn-sm'
            disabled={!enabled || backupBusy || !appService || !settings}
            onClick={() => void handleImport()}
          >
            {_('Import')}
          </button>
        </div>
      </BoxedList>

      <BoxedList title={_('Prompts')} className={disabledSection}>
        <div className='flex flex-col gap-2 px-4 py-3'>
          <div className='flex items-center justify-between gap-2'>
            <SettingLabel>{_('System Prompt Template')}</SettingLabel>
            <button
              type='button'
              className='btn btn-ghost btn-xs shrink-0'
              onClick={() => setSystemPromptTemplate(DEFAULT_SYSTEM_PROMPT_TEMPLATE)}
              disabled={!enabled}
            >
              <PiArrowCounterClockwise size={12} />
              {_('Restore Default')}
            </button>
          </div>
          <textarea
            className='textarea eink-bordered w-full font-mono text-xs'
            rows={14}
            spellCheck={false}
            value={systemPromptTemplate}
            onChange={(e) => setSystemPromptTemplate(e.target.value)}
            disabled={!enabled}
          />
          <span className='text-base-content/60 text-xs'>
            {_(
              'The full system prompt, rules included — edit anything. Placeholders: {{persona}} {{bookTitle}} {{authorName}} {{currentPage}} {{bookPassages}}.',
            )}
          </span>
          {!systemPromptTemplate.includes('{{persona}}') && (
            <span className='text-warning text-xs'>
              {_('No {{persona}} placeholder — the character persona is ignored.')}
            </span>
          )}
          {!systemPromptTemplate.includes('{{bookPassages}}') && (
            <span className='text-warning text-xs'>
              {_('No {{bookPassages}} placeholder — retrieved book context is not injected.')}
            </span>
          )}
        </div>
        <div className='flex flex-col gap-2 px-4 py-3'>
          <SettingLabel>{_('User Instructions (optional)')}</SettingLabel>
          <textarea
            className='textarea eink-bordered w-full font-mono text-sm placeholder:text-xs'
            rows={4}
            spellCheck={false}
            value={userInstructions}
            onChange={(e) => setUserInstructions(e.target.value)}
            placeholder={_('Answer in Chinese; attach phonetics to English words.')}
            disabled={!enabled}
          />
          <span className='text-base-content/60 text-xs'>
            {_(
              'Appended to every message you send. Never shown in the thread. Who the AI is comes from the character persona; these instructions are user-level.',
            )}
          </span>
        </div>
      </BoxedList>

      <BoxedList
        title={_('Reedy Retrieval (Beta)')}
        className={disabledSection}
        description={
          isTauriAppPlatform()
            ? _(
                'Uses Turso vector search + CFI-anchored citations. The model decides when to look up passages instead of getting them stuffed into the system prompt.',
              )
            : _('Reedy is desktop-only in this beta. Use the Readest desktop app to try it.')
        }
      >
        <SettingsSwitchRow
          label={_('Use Reedy retrieval')}
          checked={reedyEnabled}
          disabled={!enabled || !isTauriAppPlatform()}
          onChange={() => {
            const next = !reedyEnabled;
            setReedyEnabled(next);
            saveAiSetting('reedy', {
              enabled: next,
              runtime: reedyAgentRuntime ? 'agent' : 'mvp',
            });
          }}
        />
        <SettingsSwitchRow
          label={_('Use agent runtime (experimental)')}
          checked={reedyAgentRuntime}
          disabled={!enabled || !reedyEnabled || !isTauriAppPlatform()}
          onChange={() => {
            const next = !reedyAgentRuntime;
            setReedyAgentRuntime(next);
            saveAiSetting('reedy', {
              enabled: reedyEnabled,
              runtime: next ? 'agent' : 'mvp',
            });
          }}
        />
        <div className='flex min-h-14 items-center justify-between gap-3 pe-4'>
          <div className='flex min-w-0 flex-col gap-0.5'>
            <SettingLabel>{_('Send Reedy feedback')}</SettingLabel>
          </div>
          <button
            className='btn btn-outline btn-sm'
            disabled={!enabled || !isTauriAppPlatform() || !appService}
            onClick={async () => {
              if (!appService) return;
              try {
                const bundle = await exportReedyMetricsBundle(appService);
                const blob = new Blob([bundle], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `reedy-feedback-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              } catch (err) {
                console.error('[Reedy] feedback export failed', err);
              }
            }}
          >
            {_('Download')}
          </button>
        </div>
      </BoxedList>
    </div>
  );
};

export default AIPanel;
