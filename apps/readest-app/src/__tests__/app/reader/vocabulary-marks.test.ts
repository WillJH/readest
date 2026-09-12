import { describe, it, expect, afterEach } from 'vitest';

import {
  VOCAB_MARK_PREFIX,
  buildVocabularyMarkMatcher,
  matchVocabularyToken,
  refreshSectionVocabularyMarks,
  wordKeyFromMarkValue,
} from '@/app/reader/utils/vocabularyMarks';

afterEach(() => {
  document.body.innerHTML = '';
});

class MockOverlayer {
  added = new Map<string, Range>();
  removed: string[] = [];
  add(key: string, range: Range, _draw: unknown, _opts?: unknown): void {
    this.added.set(key, range);
  }
  remove(key: string): void {
    this.added.delete(key);
    this.removed.push(key);
  }
}

describe('vocabulary mark matcher', () => {
  it('matches the canonical word and its recorded surface forms', () => {
    const matcher = buildVocabularyMarkMatcher([{ word: 'run', surfaceForms: ['running'] }]);
    expect(matchVocabularyToken(matcher, 'run')).toBe('run');
    expect(matchVocabularyToken(matcher, 'running')).toBe('run');
  });

  it('resolves regular and irregular inflections back to the base', () => {
    const matcher = buildVocabularyMarkMatcher([{ word: 'run', surfaceForms: [] }]);
    expect(matchVocabularyToken(matcher, 'runs')).toBe('run');
    expect(matchVocabularyToken(matcher, 'running')).toBe('run');
    expect(matchVocabularyToken(matcher, 'ran')).toBe('run');
    expect(matchVocabularyToken(matcher, 'cats')).toBeNull(); // not in the book
  });

  it('marks inflections even when the base was saved with a surface form', () => {
    const matcher = buildVocabularyMarkMatcher([{ word: 'hope', surfaceForms: ['hoping'] }]);
    expect(matchVocabularyToken(matcher, 'hoping')).toBe('hope');
    expect(matchVocabularyToken(matcher, 'hoped')).toBe('hope');
    expect(matchVocabularyToken(matcher, 'hopping')).toBeNull(); // hop ≠ hope
  });

  it('does not resolve unrelated suffixed words (butter stays butter)', () => {
    const matcher = buildVocabularyMarkMatcher([{ word: 'butt', surfaceForms: [] }]);
    expect(matchVocabularyToken(matcher, 'butter')).toBeNull();
  });

  it('matches non-Latin entries by exact equality only', () => {
    const matcher = buildVocabularyMarkMatcher([{ word: '生词', surfaceForms: [] }]);
    expect(matchVocabularyToken(matcher, '生词')).toBe('生词');
    expect(matchVocabularyToken(matcher, '生词本')).toBeNull();
  });
});

describe('refreshSectionVocabularyMarks', () => {
  it('marks every occurrence including inflected shapes', () => {
    document.body.innerHTML = `<p id="p">She was running and the cats ran.</p>`;
    const overlayer = new MockOverlayer();
    const matcher = buildVocabularyMarkMatcher([
      { word: 'run', surfaceForms: [] },
      { word: 'cat', surfaceForms: [] },
    ]);
    const count = refreshSectionVocabularyMarks(document, overlayer, matcher, 'squiggly', {
      isDarkMode: false,
    });
    expect(count).toBe(3); // running, cats, ran
    const marked = [...overlayer.added.values()].map((r) => r.toString()).sort();
    expect(marked).toEqual(['cats', 'ran', 'running']);
    for (const key of overlayer.added.keys()) {
      expect(key.startsWith(VOCAB_MARK_PREFIX)).toBe(true);
    }
  });

  it('sees the base word inside a Word Lens ruby but skips the reading', () => {
    document.body.innerHTML = `<p>He <ruby>runs<rt>ran</rt></ruby> home.</p>`;
    const overlayer = new MockOverlayer();
    const matcher = buildVocabularyMarkMatcher([{ word: 'run', surfaceForms: [] }]);
    const count = refreshSectionVocabularyMarks(document, overlayer, matcher, 'underline', {
      isDarkMode: false,
    });
    expect(count).toBe(1);
    expect([...overlayer.added.values()][0]!.toString()).toBe('runs');
  });

  it('removes previous marks when the word set changes or the style is off', () => {
    document.body.innerHTML = `<p>She was running home.</p>`;
    const overlayer = new MockOverlayer();
    const withRun = buildVocabularyMarkMatcher([{ word: 'run', surfaceForms: [] }]);
    expect(
      refreshSectionVocabularyMarks(document, overlayer, withRun, 'squiggly', {
        isDarkMode: false,
      }),
    ).toBe(1);

    // Word removed → its mark goes away.
    const empty = buildVocabularyMarkMatcher([]);
    expect(
      refreshSectionVocabularyMarks(document, overlayer, empty, 'squiggly', { isDarkMode: false }),
    ).toBe(0);
    expect(overlayer.added.size).toBe(0);

    // Style off clears too.
    const again = buildVocabularyMarkMatcher([{ word: 'run', surfaceForms: [] }]);
    expect(
      refreshSectionVocabularyMarks(document, overlayer, again, 'squiggly', {
        isDarkMode: false,
      }),
    ).toBe(1);
    expect(
      refreshSectionVocabularyMarks(document, overlayer, again, 'off', { isDarkMode: false }),
    ).toBe(0);
    expect(overlayer.added.size).toBe(0);
  });

  it('parses mark keys back to word keys', () => {
    expect(wordKeyFromMarkValue(`${VOCAB_MARK_PREFIX}${encodeURIComponent('run')}#3`)).toBe('run');
    expect(wordKeyFromMarkValue('epubcfi(/6/4)')).toBeNull();
  });
});
