import { describe, it, expect } from 'vitest';

import { getBaseFormCandidates, getLemmaCandidates } from '@/services/dictionaries/lemmatize';

describe('getLemmaCandidates', () => {
  it('lemmatizes words for an English language code', () => {
    expect(getLemmaCandidates('ran', 'en')).toContain('run');
  });

  it('normalizes regional/script English subtags to the en lemmatizer', () => {
    expect(getLemmaCandidates('mice', 'en-US')).toContain('mouse');
    expect(getLemmaCandidates('mice', 'en-GB')).toContain('mouse');
  });

  it('defaults to English when the language is missing or empty', () => {
    expect(getLemmaCandidates('ran')).toContain('run');
    expect(getLemmaCandidates('ran', undefined)).toContain('run');
    expect(getLemmaCandidates('ran', '')).toContain('run');
    expect(getLemmaCandidates('ran', null)).toContain('run');
  });

  it('returns [] for an explicit language with no registered lemmatizer', () => {
    expect(getLemmaCandidates('mange', 'fr')).toEqual([]);
    expect(getLemmaCandidates('rennt', 'de')).toEqual([]);
    expect(getLemmaCandidates('mice', 'zh')).toEqual([]);
  });
});

describe('getBaseFormCandidates', () => {
  it('returns the ordered base-form guesses without frequency-list validation', () => {
    // Lookup reordering is validated by the dictionary itself: a miss falls
    // through to the surface form, so long-tail words still get their guess.
    expect(getBaseFormCandidates('chattering', 'en')).toEqual(['chatter', 'chattere']);
    expect(getBaseFormCandidates('hoping', 'en')).toEqual(['hope', 'hop']);
    expect(getBaseFormCandidates('cats', 'en')).toEqual(['cat']);
    expect(getBaseFormCandidates('went', 'en')).toEqual(['go']);
  });

  it('returns nothing for lexicalized forms, bare words, and non-English', () => {
    expect(getBaseFormCandidates('interesting', 'en')).toEqual([]);
    expect(getBaseFormCandidates('something', 'en')).toEqual([]);
    expect(getBaseFormCandidates('run', 'en')).toEqual([]);
    expect(getBaseFormCandidates('butter', 'en')).toEqual([]);
    expect(getBaseFormCandidates('chats', 'fr')).toEqual([]);
  });

  it('strips the possessive clitic before guessing', () => {
    expect(getBaseFormCandidates("cats'", 'en')).toEqual(['cat']);
  });
});
