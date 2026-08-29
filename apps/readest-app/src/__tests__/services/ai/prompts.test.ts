import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PERSONA,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  buildAvatarProtocol,
  buildSystemPrompt,
} from '@/services/ai/prompts';
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

describe('buildSystemPrompt (default template)', () => {
  it('uses the built-in persona and injects RAG context', () => {
    const prompt = buildSystemPrompt('A Tale', 'Dickens', [chunk], 42);
    expect(prompt).toContain('warm and encouraging reading companion');
    expect(prompt).toContain('ABSOLUTE CONSTRAINTS');
    expect(prompt).toContain('<BOOK_PASSAGES page_limit="currentPage">');
    expect(prompt).toContain('[Chapter One, Page 3]');
    expect(prompt).toContain('page 42 of "A Tale"');
    expect(prompt).toContain(' by Dickens');
  });

  it('replaces the persona but keeps the skeleton sections', () => {
    const prompt = buildSystemPrompt(
      'A Tale',
      'Dickens',
      [chunk],
      42,
      'You are Alice, a strict tutor.',
    );
    expect(prompt).toContain('You are Alice, a strict tutor.');
    expect(prompt).not.toContain(BUILT_IN_PERSONA);
    expect(prompt).toContain('ABSOLUTE CONSTRAINTS');
    expect(prompt).toContain('<BOOK_PASSAGES');
  });

  it('falls back to the built-in persona for blank custom prompts', () => {
    for (const blank of ['', '   ', '\n\t']) {
      const prompt = buildSystemPrompt('T', '', [], 1, blank);
      expect(prompt).toContain('warm and encouraging reading companion');
    }
  });
});

describe('buildSystemPrompt (custom template)', () => {
  it('replaces the entire skeleton — nothing is forced on the user', () => {
    const prompt = buildSystemPrompt(
      'T',
      'A',
      [chunk],
      7,
      'PERSONA-X',
      'You are free. {{persona}} Book: {{bookTitle}}{{authorName}} page {{currentPage}}.{{bookPassages}}',
    );
    expect(prompt).toContain('You are free. PERSONA-X Book: T by A page 7.');
    expect(prompt).toContain('[Chapter One, Page 3]');
    expect(prompt).not.toContain('ABSOLUTE CONSTRAINTS');
  });

  it('substitutes placeholders; unknown ones stay literal', () => {
    const prompt = buildSystemPrompt('T', '', [], 5, undefined, 'X {{nope}} {{currentPage}}');
    expect(prompt).toBe('X {{nope}} 5');
  });

  it('blank template falls back to the default skeleton', () => {
    const prompt = buildSystemPrompt('T', '', [], 1, undefined, '   ');
    expect(prompt).toContain('ABSOLUTE CONSTRAINTS');
  });

  it('missing placeholders simply drop those injections', () => {
    const prompt = buildSystemPrompt('T', 'A', [chunk], 9, 'P', 'Just {{persona}}.');
    expect(prompt).toBe('Just P.');
  });

  it('default template carries the core placeholders', () => {
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain('{{persona}}');
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain('{{bookPassages}}');
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain('{{currentPage}}');
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
