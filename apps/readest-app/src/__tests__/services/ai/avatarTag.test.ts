import { describe, it, expect } from 'vitest';
import { parseAvatarTag } from '@/services/ai/avatarTag';

describe('parseAvatarTag', () => {
  it('returns null label when there is no tag', () => {
    expect(parseAvatarTag('Hello there!')).toEqual({
      label: null,
      displayText: 'Hello there!',
    });
  });

  it('strips a leading tag and following whitespace', () => {
    expect(parseAvatarTag('[avatar: happy] Hello!')).toEqual({
      label: 'happy',
      displayText: 'Hello!',
    });
  });

  it('tolerates extra spaces inside the tag', () => {
    expect(parseAvatarTag('[avatar:   smiling slightly  ] text').label).toBe('smiling slightly');
  });

  it('ignores tags that are not at the start', () => {
    const result = parseAvatarTag('Great! [avatar: happy]');
    expect(result.label).toBeNull();
    expect(result.displayText).toBe('Great! [avatar: happy]');
  });

  it('keeps text intact when brackets never close', () => {
    expect(parseAvatarTag('[avatar: happ').label).toBeNull();
    expect(parseAvatarTag('[avatar: happ').displayText).toBe('[avatar: happ');
  });

  it('handles empty input', () => {
    expect(parseAvatarTag('')).toEqual({ label: null, displayText: '' });
  });
});
