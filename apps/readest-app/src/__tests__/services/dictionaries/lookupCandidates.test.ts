import { describe, it, expect } from 'vitest';

import { buildLookupCandidates } from '@/services/dictionaries/lookupCandidates';

describe('buildLookupCandidates', () => {
  it('returns the lowercase word for an already-lowercase selection', () => {
    expect(buildLookupCandidates('hello')).toEqual(['hello', 'Hello', 'HELLO']);
  });

  it('trims leading/trailing whitespace from a double-click selection', () => {
    // Non-inflecting words keep this focused on trimming + case folding.
    expect(buildLookupCandidates('world ')).toEqual(['world', 'World', 'WORLD']);
    expect(buildLookupCandidates('  planet  ')).toEqual(['planet', 'Planet', 'PLANET']);
  });

  it('offers a lowercase variant for a sentence-initial capitalized word', () => {
    expect(buildLookupCandidates('Hello')).toEqual(['Hello', 'hello', 'HELLO']);
  });

  it('offers lowercase and title-case variants for an all-caps selection', () => {
    expect(buildLookupCandidates('HELLO')).toEqual(['HELLO', 'hello', 'Hello']);
  });

  it('de-duplicates collapsed variants', () => {
    // A single lowercase letter collapses to one unique candidate.
    expect(buildLookupCandidates('a')).toEqual(['a', 'A']);
  });

  it('returns an empty list for a blank selection', () => {
    expect(buildLookupCandidates('')).toEqual([]);
    expect(buildLookupCandidates('   ')).toEqual([]);
  });

  describe('lemmatization fallback', () => {
    it('resolves the base form of an inflected selection ahead of its stub entry', () => {
      // Wiktionary-style dictionaries keep "plural of cat" / "past tense of
      // go" stub entries; the base candidate must be tried before the
      // surface form so the real entry wins.
      expect(buildLookupCandidates('cats', 'en')[0]).toBe('cat');
      expect(buildLookupCandidates('ran', 'en')[0]).toBe('run');
      expect(buildLookupCandidates('running', 'en')[0]).toBe('run');
      expect(buildLookupCandidates('stopped', 'en')[0]).toBe('stop');
      expect(buildLookupCandidates('Mice', 'en')[0]).toBe('mouse');
      expect(buildLookupCandidates('cities', 'en')[0]).toBe('city');
    });

    it('orders e-restoring guesses before the raw stem', () => {
      expect(buildLookupCandidates('hoping', 'en').slice(0, 2)).toEqual(['hope', 'hop']);
      expect(buildLookupCandidates('translating', 'en').slice(0, 2)).toEqual([
        'translat',
        'translate',
      ]);
    });

    it('guesses bases for long-tail words the frequency list does not know', () => {
      expect(buildLookupCandidates('chattering', 'en')[0]).toBe('chatter');
    });

    it('keeps lexicalized forms surface-first', () => {
      expect(buildLookupCandidates('interesting', 'en')[0]).toBe('interesting');
      expect(buildLookupCandidates('tired', 'en')[0]).toBe('tired');
      expect(buildLookupCandidates('news', 'en')[0]).toBe('news');
      expect(buildLookupCandidates('sometimes', 'en')[0]).toBe('sometimes');
    });

    it('still carries the surface and lemma variants behind the base forms', () => {
      const candidates = buildLookupCandidates('ran', 'en');
      expect(candidates[0]).toBe('run');
      expect(candidates).toContain('ran');
      expect(candidates.indexOf('ran')).toBeGreaterThan(0);
    });

    it('resolves the issue test cases to their expected lemma', () => {
      const cases: Array<[string, string]> = [
        ['ran', 'run'],
        ['went', 'go'],
        ['gone', 'go'],
        ['mice', 'mouse'],
        ['children', 'child'],
        ['better', 'good'],
        ['analyses', 'analysis'],
        ['realised', 'realise'],
      ];
      for (const [selection, lemma] of cases) {
        expect(buildLookupCandidates(selection, 'en')).toContain(lemma);
      }
    });

    it('defaults to English lemmatization when no language is given', () => {
      expect(buildLookupCandidates('ran')).toContain('run');
    });

    it('does not lemmatize for an explicit non-English language', () => {
      expect(buildLookupCandidates('ran', 'fr')).toEqual(['ran', 'Ran', 'RAN']);
    });
  });
});
