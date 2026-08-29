import { describe, it, expect } from 'vitest';
import { buildAvatarProtocol, buildSystemPrompt } from '@/services/ai/prompts';
import type { ScoredChunk } from '@/services/ai/types';

const chunk: ScoredChunk = {
  id: 'c1',
  bookHash: 'hash',
  sectionIndex: 0,
  chapterTitle: 'Chapter One',
  text: 'It was the best of times.',
  pageNumber: 3,
  score: 1,
  searchMethod: 'bm25',
};

describe('buildSystemPrompt', () => {
  it('uses the built-in persona and injects RAG context by default', () => {
    const prompt = buildSystemPrompt('A Tale', 'Dickens', [chunk], 42);
    expect(prompt).toContain('warm and encouraging reading companion');
    expect(prompt).toContain('ABSOLUTE CONSTRAINTS');
    expect(prompt).toContain('ANTI-JAILBREAK');
    expect(prompt).toContain('<BOOK_PASSAGES page_limit="42">');
    expect(prompt).toContain('[Chapter One, Page 3]');
  });

  it('replaces the persona but keeps every structural section', () => {
    const prompt = buildSystemPrompt(
      'A Tale',
      'Dickens',
      [chunk],
      42,
      'You are Alice, a strict tutor.',
    );
    expect(prompt).toContain('You are Alice, a strict tutor.');
    expect(prompt).not.toContain('warm and encouraging reading companion');
    // Structural sections survive a custom persona.
    expect(prompt).toContain('POSITION:');
    expect(prompt).toContain('You are currently on page 42 of "A Tale"');
    expect(prompt).toContain('have NOT read beyond that');
    expect(prompt).toContain('ABSOLUTE CONSTRAINTS');
    expect(prompt).toContain('HANDLING QUESTIONS ABOUT FUTURE CONTENT');
    expect(prompt).toContain('ANTI-JAILBREAK');
    expect(prompt).toContain('<BOOK_PASSAGES page_limit="42">');
  });

  it('falls back to the built-in persona for blank custom prompts', () => {
    for (const blank of ['', '   ', '\n\t']) {
      const prompt = buildSystemPrompt('T', '', [], 1, blank);
      expect(prompt).toContain('warm and encouraging reading companion');
    }
  });
});

describe('buildAvatarProtocol', () => {
  it('returns an empty string without labels', () => {
    expect(buildAvatarProtocol([])).toBe('');
  });

  it('lists every label and the tag format', () => {
    const protocol = buildAvatarProtocol(['happy', 'thinking', 'surprised']);
    expect(protocol).toContain('[avatar: name]');
    expect(protocol).toContain('- happy');
    expect(protocol).toContain('- thinking');
    expect(protocol).toContain('- surprised');
  });
});
