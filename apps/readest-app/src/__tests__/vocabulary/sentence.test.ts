import { describe, it, expect } from 'vitest';
import { splitSentences, pickSentenceFromText } from '@/services/vocabulary/sentence';

describe('splitSentences', () => {
  it('splits on sentence-final punctuation keeping quotes and brackets', () => {
    const text = 'He said "Stop!" Then he left. Did anyone run? Yes!';
    expect(splitSentences(text)).toEqual([
      'He said "Stop!"',
      'Then he left.',
      'Did anyone run?',
      'Yes!',
    ]);
  });

  it('keeps a trailing fragment without final punctuation', () => {
    expect(splitSentences('One. two three')).toEqual(['One.', 'two three']);
  });

  it('handles CJK sentence enders', () => {
    expect(splitSentences('天空是蓝色的。鸟在飞。')).toEqual(['天空是蓝色的。', '鸟在飞。']);
  });
});

describe('pickSentenceFromText', () => {
  it('picks the sentence containing the word', () => {
    const text = 'The morning was cold. She decided to run for the bus. It never came.';
    expect(pickSentenceFromText(text, 'run')).toBe('She decided to run for the bus.');
  });

  it('matches case-insensitively and collapses whitespace', () => {
    const text = 'Line one\nbreaks   here. The word  Elaborate appears now.';
    expect(pickSentenceFromText(text, 'elaborate')).toBe('The word Elaborate appears now.');
  });

  it('falls back to a window around the word when there is no sentence punctuation', () => {
    const text = `chapter heading without punctuation ${'word '.repeat(80)}somewhere in the middle`;
    const picked = pickSentenceFromText(text, 'somewhere');
    expect(picked).toContain('somewhere');
    expect(picked.length).toBeLessThanOrEqual(501);
  });

  it('falls back to the paragraph preview when the word is absent', () => {
    const text = 'A short paragraph.';
    expect(pickSentenceFromText(text, 'run')).toBe('A short paragraph.');
  });

  it('returns empty text as empty', () => {
    expect(pickSentenceFromText('   ', 'run')).toBe('');
  });

  it('truncates over-long sentences', () => {
    const long = `${'a'.repeat(600)}. tail`;
    expect(pickSentenceFromText(long, 'aaaa')).toHaveLength(501); // 500 + ellipsis
  });
});
