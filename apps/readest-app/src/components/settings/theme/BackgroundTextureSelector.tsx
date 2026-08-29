import clsx from 'clsx';
import React from 'react';
import { MdClose, MdPlayCircleOutline } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { saveSysSettings } from '@/helpers/settings';
import {
  BoxedList,
  SectionTitle,
  SettingsRow,
  SettingsSelect,
  SettingsSwitchRow,
} from '../primitives';
import { PiPlus } from 'react-icons/pi';
import type { BackgroundTextureScope } from '@/helpers/settings';
import type { SystemSettings } from '@/types/settings';

type BackgroundTextureRotation = NonNullable<SystemSettings['backgroundTextureRotation']>;

interface Texture {
  id: string;
  url?: string;
  blobUrl?: string;
  animated?: boolean;
  loaded?: boolean;
}

interface BackgroundTextureSelectorProps {
  predefinedTextures: Texture[];
  customTextures: Texture[];
  /** Which page's background is being edited (issue #5306). */
  scope: BackgroundTextureScope;
  onScopeChange: (scope: BackgroundTextureScope) => void;
  selectedTextureId: string;
  backgroundOpacity: number;
  backgroundSize: string;
  onTextureSelect: (id: string) => void;
  onOpacityChange: (opacity: number) => void;
  onSizeChange: (size: string) => void;
  onImportImage: () => void;
  onDeleteTexture: (id: string) => void;
}

const BackgroundTextureSelector: React.FC<BackgroundTextureSelectorProps> = ({
  predefinedTextures,
  customTextures,
  scope,
  onScopeChange,
  selectedTextureId,
  backgroundOpacity,
  backgroundSize,
  onTextureSelect,
  onOpacityChange,
  onSizeChange,
  onImportImage,
  onDeleteTexture,
}) => {
  const _ = useTranslation();
  const iconSize24 = useResponsiveSize(24);
  const { envConfig } = useEnv();
  const rotation = useSettingsStore((s) => s.settings?.backgroundTextureRotation);
  const rotationEnabled = rotation?.enabled ?? false;
  const intervalMin = rotation?.intervalMin ?? 30;
  const shuffle = rotation?.shuffle ?? false;
  const poolIds = rotation?.textureIds;

  const saveRotation = (patch: Partial<NonNullable<BackgroundTextureRotation>>) => {
    saveSysSettings(envConfig, 'backgroundTextureRotation', {
      enabled: rotationEnabled,
      intervalMin,
      shuffle,
      ...patch,
    });
  };

  // Toggle one image's pool membership. Absent textureIds means "all images"
  // (newly imported ones auto-join); once the user picks a subset it stays
  // explicit, collapsing back to "all" when everything is re-selected.
  const togglePool = (id: string) => {
    const effective = customTextures
      .filter((t) => !poolIds || poolIds.includes(t.id))
      .map((t) => t.id);
    const next = effective.includes(id) ? effective.filter((x) => x !== id) : [...effective, id];
    saveRotation({ textureIds: next.length === customTextures.length ? undefined : next });
  };

  const allTextures = [...predefinedTextures, ...customTextures];

  return (
    <div>
      <div className='mb-2 flex items-center justify-between gap-2'>
        <SectionTitle>{_('Background Image')}</SectionTitle>
        {/* Same segmented-control anatomy as ThemeModeSelector (44px targets,
            eink-bordered track + eink-inverted active thumb), with text labels:
            the visible Library|Reader pair is what tells users the two pages
            have separate backgrounds (issue #5306). */}
        <div
          role='radiogroup'
          aria-label={_('Background Image')}
          className='bg-base-200 eink-bordered inline-flex items-center rounded-full p-0.5'
        >
          {(
            [
              { scope: 'library', label: _('Library') },
              { scope: 'reader', label: _('Reader') },
            ] as const
          ).map(({ scope: segScope, label }) => {
            const active = scope === segScope;
            return (
              <button
                key={segScope}
                type='button'
                role='radio'
                aria-checked={active}
                onClick={() => onScopeChange(segScope)}
                className={clsx(
                  // em-based like SectionTitle, not rem-based text-sm — the
                  // settings-content wrapper scales 14/16px (DESIGN.md §5).
                  'flex h-9 items-center justify-center rounded-full px-3 text-[0.85em] font-medium transition-colors',
                  'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
                  active
                    ? 'bg-base-300 text-base-content eink-inverted shadow-xs'
                    : 'text-base-content/60 hover:text-base-content',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div className='mb-4 grid grid-cols-3 gap-4'>
        {allTextures.map((texture) => (
          // The swatch is a div (not a <button>) so the inner Delete
          // <button> can nest legally — interactive elements can't be
          // descendants of <button> per HTML, and React 18+ flags it
          // as a hydration error. Keyboard a11y is preserved via
          // role="button" + tabIndex + Enter/Space onKeyDown.
          <div
            key={texture.id}
            role='button'
            tabIndex={0}
            onClick={() => onTextureSelect(texture.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onTextureSelect(texture.id);
              }
            }}
            // Selected texture gets a 2px border in `base-content` (the
            // app's primary text color — white on dark mode, near-black on
            // light mode). Guaranteed contrast against any texture image.
            // Inactive cards keep `border-base-300` so the slot doesn't
            // shift on selection change.
            className={`bg-base-100 relative flex cursor-pointer flex-col items-start justify-between rounded-lg border-2 p-3 shadow-md transition-colors ${
              selectedTextureId === texture.id ? 'border-base-content' : 'border-base-300'
            }`}
            style={{
              backgroundImage: texture.loaded ? `url("${texture.blobUrl || texture.url}")` : 'none',
              backgroundSize: 'cover',
              backgroundPosition: 'top',
              minHeight: '80px',
            }}
          >
            {texture.animated && (
              <MdPlayCircleOutline
                size={iconSize24}
                className='absolute bottom-2 left-2 text-white drop-shadow-md'
              />
            )}
            {!predefinedTextures.find((t) => t.id === texture.id) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteTexture(texture.id);
                }}
                className='absolute left-2 top-2 rounded-full bg-red-500 p-1 text-white transition-colors hover:bg-red-600'
                title={_('Delete')}
              >
                <MdClose size={16} />
              </button>
            )}
          </div>
        ))}
        <button
          className='relative flex cursor-pointer flex-col gap-1 items-center justify-end rounded-lg border border-dashed p-3 shadow-md'
          onClick={onImportImage}
        >
          <PiPlus size={iconSize24} />
          <span className='max-w-full truncate font-semibold'>{_('Import Image')}</span>
        </button>
      </div>

      {/* Background Image Settings — boxed list once a texture is selected */}
      {selectedTextureId !== 'none' && (
        <BoxedList>
          <SettingsRow label={_('Opacity')}>
            <div className='flex items-center gap-2'>
              <input
                type='range'
                min='0'
                max='1'
                step='0.05'
                value={backgroundOpacity}
                onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
                className='range range-sm w-32'
              />
              <span className='text-base-content/70 w-12 text-end text-sm'>
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
          </SettingsRow>
          <SettingsRow label={_('Size')}>
            <SettingsSelect
              value={backgroundSize}
              onChange={(e) => onSizeChange(e.target.value)}
              ariaLabel={_('Size')}
              options={[
                { value: 'auto', label: _('Auto') },
                { value: 'cover', label: _('Cover') },
                { value: 'contain', label: _('Contain') },
              ]}
            />
          </SettingsRow>
        </BoxedList>
      )}

      {/* Auto rotation over the imported image pool */}
      <BoxedList title={_('Auto Rotate')}>
        <SettingsSwitchRow
          label={_('Rotate background automatically')}
          description={_('Cycles through your imported images wherever a background is set.')}
          checked={rotationEnabled}
          onChange={() => saveRotation({ enabled: !rotationEnabled })}
        />
        {rotationEnabled && (
          <>
            <SettingsRow label={_('Interval')}>
              <SettingsSelect
                value={String(intervalMin)}
                onChange={(e) => saveRotation({ intervalMin: Number(e.target.value) })}
                ariaLabel={_('Interval')}
                options={[
                  { value: '10', label: _('Every 10 minutes') },
                  { value: '30', label: _('Every 30 minutes') },
                  { value: '60', label: _('Every hour') },
                  { value: '360', label: _('Every 6 hours') },
                  { value: '1440', label: _('Every day') },
                ]}
              />
            </SettingsRow>
            <SettingsSwitchRow
              label={_('Shuffle')}
              checked={shuffle}
              onChange={() => saveRotation({ shuffle: !shuffle })}
            />
            {customTextures.length > 0 && (
              <div className='flex flex-col gap-2 px-4 py-3'>
                <span className='text-base-content/70 text-sm'>
                  {poolIds
                    ? _('Rotation pool: {{count}} selected', {
                        count: poolIds.filter((id) => customTextures.some((t) => t.id === id))
                          .length,
                      })
                    : _('Rotation pool: all images')}
                </span>
                <div className='flex flex-wrap gap-2'>
                  {customTextures.map((texture) => {
                    const selected = !poolIds || poolIds.includes(texture.id);
                    return (
                      <button
                        key={texture.id}
                        type='button'
                        onClick={() => togglePool(texture.id)}
                        aria-pressed={selected}
                        title={selected ? _('Exclude from rotation') : _('Include in rotation')}
                        className={clsx(
                          'relative size-12 overflow-hidden rounded-lg border-2 transition-colors',
                          selected ? 'border-primary' : 'border-base-300 opacity-50',
                        )}
                        style={{
                          backgroundImage: texture.loaded
                            ? `url("${texture.blobUrl || texture.url}")`
                            : 'none',
                          backgroundSize: 'cover',
                          backgroundPosition: 'top',
                        }}
                      >
                        <span
                          className={clsx(
                            'absolute right-0.5 bottom-0.5 flex size-4 items-center justify-center rounded-full text-[10px] font-bold text-white',
                            selected ? 'bg-primary' : 'bg-base-content/40',
                          )}
                        >
                          {selected ? '✓' : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </BoxedList>
    </div>
  );
};

export default BackgroundTextureSelector;
