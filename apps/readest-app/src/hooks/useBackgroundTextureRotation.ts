import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomTextureStore } from '@/store/customTextureStore';

/** Coarse tick that checks whether the rotation interval has elapsed. */
const TICK_MS = 30_000;

/**
 * Auto-rotate the background texture per settings.backgroundTextureRotation.
 * Mounted once at the app root (Providers) so both the reader and the
 * library rotate; the store's rotate action no-ops on pages that set the
 * background to 'none'. A navigation re-applying a page's static choice is
 * simply re-rotated on the next due tick.
 */
export function useBackgroundTextureRotation() {
  const { envConfig } = useEnv();
  const rotation = useSettingsStore((s) => s.settings?.backgroundTextureRotation);
  const enabled = rotation?.enabled ?? false;
  const intervalMin = rotation?.intervalMin ?? 30;

  useEffect(() => {
    if (!envConfig || !enabled) return;
    // Start "overdue" so enabling rotation shows the first change within a
    // tick instead of after a full interval.
    let lastRotatedAt = Date.now() - Math.max(1, intervalMin) * 60_000;
    const tick = () => {
      if (Date.now() - lastRotatedAt < Math.max(1, intervalMin) * 60_000) return;
      lastRotatedAt = Date.now();
      void useCustomTextureStore.getState().rotateBackgroundTexture(envConfig);
    };
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [envConfig, enabled, intervalMin]);
}
