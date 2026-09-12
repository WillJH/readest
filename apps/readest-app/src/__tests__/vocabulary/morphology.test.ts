import { describe, it, expect } from 'vitest';

import { canonicalizeWord } from '@/services/vocabulary/morphology';

describe('canonicalizeWord', () => {
  describe('regular plurals', () => {
    it('strips -s / -es / -ies', () => {
      expect(canonicalizeWord('cats', 'en').canonical).toBe('cat');
      expect(canonicalizeWord('dogs', 'en').canonical).toBe('dog');
      expect(canonicalizeWord('boxes', 'en').canonical).toBe('box');
      expect(canonicalizeWord('dishes', 'en').canonical).toBe('dish');
      expect(canonicalizeWord('houses', 'en').canonical).toBe('house');
      expect(canonicalizeWord('watches', 'en').canonical).toBe('watch');
      expect(canonicalizeWord('cities', 'en').canonical).toBe('city');
      expect(canonicalizeWord('stories', 'en').canonical).toBe('story');
    });

    it('handles irregular plural spellings', () => {
      expect(canonicalizeWord('wolves', 'en').canonical).toBe('wolf');
      expect(canonicalizeWord('knives', 'en').canonical).toBe('knife');
      expect(canonicalizeWord('analyses', 'en').canonical).toBe('analysis');
      expect(canonicalizeWord('theses', 'en').canonical).toBe('thesis');
    });

    it('keeps singular-looking and false plurals', () => {
      expect(canonicalizeWord('bus', 'en').canonical).toBe('bus');
      expect(canonicalizeWord('gas', 'en').canonical).toBe('gas');
      expect(canonicalizeWord('chaos', 'en').canonical).toBe('chaos');
      expect(canonicalizeWord('virus', 'en').canonical).toBe('virus');
      expect(canonicalizeWord('campus', 'en').canonical).toBe('campus');
      // `its` must not collapse to `it` — the rule path requires length ≥ 3.
      expect(canonicalizeWord('its', 'en').canonical).toBe('its');
    });

    it('keeps plural-only / lexicalized nouns', () => {
      expect(canonicalizeWord('news', 'en').canonical).toBe('news');
      expect(canonicalizeWord('thanks', 'en').canonical).toBe('thanks');
      expect(canonicalizeWord('glasses', 'en').canonical).toBe('glasses');
      expect(canonicalizeWord('clothes', 'en').canonical).toBe('clothes');
      expect(canonicalizeWord('shorts', 'en').canonical).toBe('shorts');
      expect(canonicalizeWord('physics', 'en').canonical).toBe('physics');
      expect(canonicalizeWord('means', 'en').canonical).toBe('means');
    });
  });

  describe('-ing forms', () => {
    it('strips -ing with orthographic adjustments', () => {
      expect(canonicalizeWord('walking', 'en').canonical).toBe('walk');
      expect(canonicalizeWord('running', 'en').canonical).toBe('run');
      expect(canonicalizeWord('stopping', 'en').canonical).toBe('stop');
      expect(canonicalizeWord('planning', 'en').canonical).toBe('plan');
      expect(canonicalizeWord('making', 'en').canonical).toBe('make');
      expect(canonicalizeWord('hoping', 'en').canonical).toBe('hope');
      expect(canonicalizeWord('using', 'en').canonical).toBe('use');
      expect(canonicalizeWord('loving', 'en').canonical).toBe('love');
      expect(canonicalizeWord('translating', 'en').canonical).toBe('translate');
      expect(canonicalizeWord('creating', 'en').canonical).toBe('create');
      expect(canonicalizeWord('lying', 'en').canonical).toBe('lie');
      expect(canonicalizeWord('dying', 'en').canonical).toBe('die');
      expect(canonicalizeWord('singing', 'en').canonical).toBe('sing');
      expect(canonicalizeWord('timing', 'en').canonical).toBe('time');
      expect(canonicalizeWord('snowing', 'en').canonical).toBe('snow');
    });

    it('keeps lexicalized -ing nouns and adjectives', () => {
      expect(canonicalizeWord('interesting', 'en').canonical).toBe('interesting');
      expect(canonicalizeWord('tired', 'en').canonical).toBe('tired');
      expect(canonicalizeWord('building', 'en').canonical).toBe('building');
      expect(canonicalizeWord('morning', 'en').canonical).toBe('morning');
      expect(canonicalizeWord('ceiling', 'en').canonical).toBe('ceiling');
      expect(canonicalizeWord('clothing', 'en').canonical).toBe('clothing');
      expect(canonicalizeWord('excited', 'en').canonical).toBe('excited');
      expect(canonicalizeWord('used', 'en').canonical).toBe('used');
    });
  });

  describe('-ed forms', () => {
    it('strips -ed with orthographic adjustments', () => {
      expect(canonicalizeWord('walked', 'en').canonical).toBe('walk');
      expect(canonicalizeWord('stopped', 'en').canonical).toBe('stop');
      expect(canonicalizeWord('planned', 'en').canonical).toBe('plan');
      expect(canonicalizeWord('hoped', 'en').canonical).toBe('hope');
      expect(canonicalizeWord('loved', 'en').canonical).toBe('love');
      expect(canonicalizeWord('used', 'en').canonical).toBe('used'); // lexicalized
      expect(canonicalizeWord('studied', 'en').canonical).toBe('study');
      expect(canonicalizeWord('carried', 'en').canonical).toBe('carry');
      expect(canonicalizeWord('created', 'en').canonical).toBe('create');
      expect(canonicalizeWord('celebrated', 'en').canonical).toBe('celebrate');
      expect(canonicalizeWord('graduated', 'en').canonical).toBe('graduate');
      expect(canonicalizeWord('motivated', 'en').canonical).toBe('motivate');
    });
  });

  describe('irregular forms', () => {
    it('resolves suppletive verbs and irregular plurals', () => {
      expect(canonicalizeWord('went', 'en').canonical).toBe('go');
      expect(canonicalizeWord('gone', 'en').canonical).toBe('go');
      expect(canonicalizeWord('was', 'en').canonical).toBe('be');
      expect(canonicalizeWord('were', 'en').canonical).toBe('be');
      expect(canonicalizeWord('did', 'en').canonical).toBe('do');
      expect(canonicalizeWord('children', 'en').canonical).toBe('child');
      expect(canonicalizeWord('mice', 'en').canonical).toBe('mouse');
      expect(canonicalizeWord('men', 'en').canonical).toBe('man');
      expect(canonicalizeWord('feet', 'en').canonical).toBe('foot');
      expect(canonicalizeWord('people', 'en').canonical).toBe('person');
    });
  });

  describe('dictionary headword arbitration', () => {
    it('uses a headword that is a valid candidate of the surface form', () => {
      const result = canonicalizeWord('went', 'en', { headword: 'go' });
      expect(result.canonical).toBe('go');
    });

    it('uses headwords for bases the frequency list does not know', () => {
      const result = canonicalizeWord('flirting', 'en', { headword: 'flirt' });
      expect(result.canonical).toBe('flirt');
    });

    it('sanitizes decorated headwords', () => {
      const result = canonicalizeWord('running', 'en', { headword: 'run①' });
      expect(result.canonical).toBe('run');
    });

    it('ignores a headword equal to the surface form (dictionary has its own entry)', () => {
      // `interesting` is lexicalized, so even a dictionary entry for it must
      // not collapse it into `interest`.
      const result = canonicalizeWord('interesting', 'en', { headword: 'interesting' });
      expect(result.canonical).toBe('interesting');
    });

    it('ignores a headword that is not a candidate of the surface form', () => {
      const result = canonicalizeWord('running', 'en', { headword: 'jog' });
      expect(result.canonical).toBe('run'); // falls back to the rule + list path
    });
  });

  describe('possessives', () => {
    it('strips the clitic and keeps lemmatizing', () => {
      expect(canonicalizeWord("cat's", 'en').canonical).toBe('cat');
      expect(canonicalizeWord("cats'", 'en').canonical).toBe('cat');
    });

    it('keeps original casing for pure possessives', () => {
      expect(canonicalizeWord("John's", 'en').canonical).toBe('John');
    });
  });

  describe('scope guards', () => {
    it('does not canonicalize comparatives or adverbs', () => {
      expect(canonicalizeWord('bigger', 'en').canonical).toBe('bigger');
      expect(canonicalizeWord('better', 'en').canonical).toBe('better');
      expect(canonicalizeWord('quickly', 'en').canonical).toBe('quickly');
    });

    it('passes non-English languages through unchanged', () => {
      expect(canonicalizeWord('chats', 'fr').canonical).toBe('chats');
      expect(canonicalizeWord('Bücher', 'de').canonical).toBe('Bücher');
      expect(canonicalizeWord('running', 'zh').canonical).toBe('running');
    });

    it('defaults to English for a missing language, matching the lookup path', () => {
      expect(canonicalizeWord('running', null).canonical).toBe('run');
      expect(canonicalizeWord('running').canonical).toBe('run');
    });

    it('keeps unknown stems instead of inventing ones', () => {
      // `chattering` without a dictionary signal: `chatter` is not in the
      // frequency list, so the surface form is kept rather than saved as a
      // bogus stem.
      expect(canonicalizeWord('chattering', 'en').canonical).toBe('chattering');
      expect(canonicalizeWord('gibberish', 'en').canonical).toBe('gibberish');
    });

    it('leaves non-word inputs alone', () => {
      expect(canonicalizeWord('', 'en').canonical).toBe('');
      expect(canonicalizeWord('hello world', 'en').canonical).toBe('hello world');
      expect(canonicalizeWord('中文', 'en').canonical).toBe('中文');
    });
  });

  describe('changed flag and surface', () => {
    it('reports what changed', () => {
      const result = canonicalizeWord('Running', 'en');
      expect(result.surface).toBe('Running');
      expect(result.canonical).toBe('run');
      expect(result.changed).toBe(true);
    });

    it('reports unchanged words', () => {
      const result = canonicalizeWord('run', 'en');
      expect(result.canonical).toBe('run');
      expect(result.surface).toBe('run');
      expect(result.changed).toBe(false);
    });
  });
});
