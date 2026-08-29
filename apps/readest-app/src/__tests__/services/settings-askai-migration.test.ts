import { describe, it, expect, vi } from 'vitest';
import type { ViewSettings } from '@/types/book';

// The settingsService import chain pulls in the auth-gated utils, whose
// module-eval crashes in this environment (no Supabase env). Stub them so
// the migration logic itself is testable.
vi.mock('@/utils/supabase', () => ({ supabase: {} }));
vi.mock('@/utils/access', () => ({
  CLOUD_SYNC_PLANS: [],
  CLOUD_SYNC_REQUIRES_PREMIUM: false,
  EMAIL_IN_PLANS: [],
  TTS_CACHE_PLANS: [],
  getSubscriptionPlan: () => 'free',
  getUserProfilePlan: () => 'free',
  isEmailInPlan: () => false,
  isCloudSyncInPlan: () => false,
  isCloudSyncAllowed: () => true,
  isTTSCacheInPlan: () => false,
  isTTSCacheAllowed: () => true,
  getStoragePlanData: vi.fn(),
}));

import { migrateAnnotationToolbarAskAi } from '@/services/settingsService';

const viewWith = (items: ViewSettings['annotationToolbarItems']): ViewSettings =>
  ({ annotationToolbarItems: items }) as unknown as ViewSettings;

describe('migrateAnnotationToolbarAskAi', () => {
  it('inserts askAi after translate in pre-askAi lists', () => {
    const view = viewWith(['copy', 'highlight', 'translate', 'tts', 'proofread']);
    migrateAnnotationToolbarAskAi(view);
    expect(view.annotationToolbarItems).toEqual([
      'copy',
      'highlight',
      'translate',
      'askAi',
      'tts',
      'proofread',
    ]);
    expect(view.annotationToolbarAskAiMigrated).toBe(true);
  });

  it('is a no-op for lists that already include askAi (still marks migrated)', () => {
    const view = viewWith(['copy', 'askAi']);
    migrateAnnotationToolbarAskAi(view);
    expect(view.annotationToolbarItems).toEqual(['copy', 'askAi']);
  });

  it('appends at the end when translate is absent', () => {
    const view = viewWith(['copy']);
    migrateAnnotationToolbarAskAi(view);
    expect(view.annotationToolbarItems).toEqual(['copy', 'askAi']);
  });

  it('never re-adds after the first run — deliberate removals stick', () => {
    const view = viewWith(['copy', 'translate', 'tts']);
    migrateAnnotationToolbarAskAi(view);
    view.annotationToolbarItems = ['copy', 'tts']; // user removed askAi (and translate)
    migrateAnnotationToolbarAskAi(view);
    expect(view.annotationToolbarItems).toEqual(['copy', 'tts']);
  });

  it('tolerates a missing list', () => {
    const view = {} as ViewSettings;
    migrateAnnotationToolbarAskAi(view);
    expect(view.annotationToolbarAskAiMigrated).toBe(true);
    expect(view.annotationToolbarItems).toBeUndefined();
  });
});
