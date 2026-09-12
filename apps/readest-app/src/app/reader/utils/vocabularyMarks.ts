/**
 * In-text marking of vocabulary-book words.
 *
 * Draws one overlay per occurrence of a saved word — including its inflected
 * shapes — on the reader's overlayer, the same SVG layer user highlights and
 * underlines use, so the marks are visually native but never become real
 * annotation records: deleting the word removes its marks, and the notes
 * list / sync stay untouched.
 *
 * Matching resolves each text token *back* to a base form with the same
 * restricted candidate set the save path uses (`running → run`), plus exact
 * equality against stored canonical words and their recorded surface forms —
 * irregular shapes (`ran`) are covered by the irregular table, regular
 * orthography by the suffix rules, and legacy/foreign surfaces by the list.
 */
import { Overlayer } from 'foliate-js/overlayer.js';

import type { VocabularyMarkStyle } from '@/types/settings';
import type { VocabularyWord } from '@/types/vocabulary';
import {
  hasInflectionSuffix,
  inflectionCandidates,
  irregularBaseOf,
} from '@/services/dictionaries/lemmatize';

/** Prefix for overlayer keys; Annotator routes clicks on these to the detail dialog. */
export const VOCAB_MARK_PREFIX = 'vocab:';

/** Same per-section bound Word Lens uses — a whole-novel-in-one-file guard. */
const MAX_MARKS_PER_SECTION = 2000;

// Latin tokenizer, kept in sync with Word Lens' planner (word-boundary runs
// with internal apostrophes/hyphens; CJK runs match by exact equality only).
const TOKEN_RE = /[\p{L}][\p{L}\p{M}’'-]*/gu;

interface Segment {
  node: Text;
  /** Offset of this node's text within the concatenated model string. */
  start: number;
}

interface SectionTextModel {
  text: string;
  locate(offset: number): { node: Text; offset: number };
}

/**
 * Word Lens' text model skips ruby elements entirely (its glosses ARE ruby);
 * ours must see the BASE word inside a gloss so a saved word still gets its
 * mark when both features are on. Skip only rt/rp (readings) and
 * script/style — the overlayer skips rt/rp when drawing, too.
 */
const buildMarksTextModel = (doc: Document): SectionTextModel => {
  const root = doc.body ?? doc.documentElement;
  const segments: Segment[] = [];
  let text = '';
  if (root) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        let p: Node | null = n.parentNode;
        while (p) {
          if (p.nodeType === Node.ELEMENT_NODE) {
            const tag = (p as Element).tagName.toLowerCase();
            if (tag === 'rt' || tag === 'rp' || tag === 'script' || tag === 'style') {
              return NodeFilter.FILTER_REJECT;
            }
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (!t.data) continue;
      segments.push({ node: t, start: text.length });
      text += t.data;
    }
  }
  const locate = (offset: number) => {
    let lo = 0;
    let hi = segments.length - 1;
    let seg = segments[0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid]!;
      if (offset < s.start) hi = mid - 1;
      else {
        seg = s;
        lo = mid + 1;
      }
    }
    return { node: seg!.node, offset: offset - seg!.start };
  };
  return { text, locate };
};

export interface VocabularyMarkMatcher {
  /** Unique id per build — lets the per-section memo detect word-set changes. */
  id: number;
  /** Exact forms (canonical word + recorded surfaces) → owning word key. */
  forms: Map<string, string>;
  /** Canonical word keys → themselves (candidate resolution target). */
  lemmas: Map<string, string>;
}

let matcherSeq = 0;

export const buildVocabularyMarkMatcher = (
  words: Pick<VocabularyWord, 'word' | 'surfaceForms'>[],
): VocabularyMarkMatcher => {
  const forms = new Map<string, string>();
  const lemmas = new Map<string, string>();
  for (const { word, surfaceForms } of words) {
    const key = word.trim().toLowerCase();
    if (!key) continue;
    lemmas.set(key, key);
    forms.set(key, key);
    for (const form of surfaceForms) {
      const lower = form.trim().toLowerCase();
      if (lower && !forms.has(lower)) forms.set(lower, key);
    }
  }
  return { id: ++matcherSeq, forms, lemmas };
};

/** Resolve one lowercased text token to the word key it belongs to, or null. */
export const matchVocabularyToken = (
  matcher: VocabularyMarkMatcher,
  token: string,
): string | null => {
  const direct = matcher.forms.get(token);
  if (direct) return direct;
  // Irregular shapes (`ran`, `went`, `mice`) carry no suffix — the table
  // lookup is a cheap map hit, so it gates alongside the suffix pre-check.
  if (!hasInflectionSuffix(token) && irregularBaseOf(token) === null) return null;
  for (const candidate of inflectionCandidates(token)) {
    const hit = matcher.lemmas.get(candidate);
    if (hit) return hit;
  }
  return null;
};

interface MarkOccurrence {
  start: number;
  end: number;
  wordKey: string;
}

const findOccurrences = (
  text: string,
  matcher: VocabularyMarkMatcher,
  cap: number,
): MarkOccurrence[] => {
  const out: MarkOccurrence[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    const wordKey = matchVocabularyToken(matcher, m[0].toLowerCase());
    if (wordKey) {
      out.push({ start: m.index, end: m.index + m[0].length, wordKey });
      if (out.length >= cap) break;
    }
  }
  return out;
};

const occurrenceRange = (
  doc: Document,
  model: SectionTextModel,
  occ: MarkOccurrence,
): Range | null => {
  const s = model.locate(occ.start);
  // Locate() resolves a boundary offset to the START of the next segment, so
  // a word ending exactly at a node boundary must be closed inside the start
  // node itself; only genuinely cross-node words fall back to locate(end).
  const length = occ.end - occ.start;
  const range = doc.createRange();
  try {
    if (s.offset + length <= s.node.data.length) {
      range.setStart(s.node, s.offset);
      range.setEnd(s.node, s.offset + length);
    } else {
      const e = model.locate(occ.end);
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
    }
  } catch {
    return null;
  }
  return range;
};

const markColor = (style: Exclude<VocabularyMarkStyle, 'off'>, isDarkMode: boolean): string => {
  if (style === 'highlight') return isDarkMode ? '#3b82f6' : '#93c5fd';
  return isDarkMode ? '#fbbf24' : '#d97706';
};

export interface OverlayerLike {
  add: (value: string, range: Range, draw: unknown, opts?: unknown) => void;
  remove: (value: string) => void;
}

/** Per-section state: the keys we drew (for removal) + the memo signature. */
interface SectionMarkState {
  overlayer: OverlayerLike;
  keys: string[];
  signature: string;
}

const sectionStates = new WeakMap<Document, SectionMarkState>();

export interface RefreshSectionMarksOptions {
  isDarkMode: boolean;
}

/**
 * Re-draw the vocabulary marks of one rendered section. Idempotent and
 * synchronous: previous keys are removed first, then occurrences are
 * re-scanned. Skips work when neither the word set, the style, nor the
 * overlayer changed since the last call (page turns within a section).
 */
export const refreshSectionVocabularyMarks = (
  doc: Document,
  overlayer: OverlayerLike,
  matcher: VocabularyMarkMatcher | null,
  style: VocabularyMarkStyle,
  opts: RefreshSectionMarksOptions,
): number => {
  try {
    // Same words + style + overlayer → the existing marks are still correct
    // (a page turn inside a section doesn't invalidate them).
    const signature = `${style}:${matcher ? matcher.id : 0}`;
    const prev = sectionStates.get(doc);
    if (
      prev &&
      prev.overlayer === overlayer &&
      prev.signature === signature &&
      style !== 'off' &&
      matcher &&
      matcher.lemmas.size > 0
    ) {
      return prev.keys.length;
    }

    if (prev) {
      for (const key of prev.keys) {
        try {
          prev.overlayer.remove(key);
        } catch {
          // best-effort — overlayer may have been rebuilt
        }
      }
      sectionStates.delete(doc);
    }

    if (style === 'off' || !matcher || matcher.lemmas.size === 0) {
      return 0;
    }

    const model = buildMarksTextModel(doc);
    const occurrences = findOccurrences(model.text, matcher, MAX_MARKS_PER_SECTION);
    const keys: string[] = [];
    if (occurrences.length > 0) {
      const view = doc.defaultView;
      const writingMode = view ? view.getComputedStyle(doc.body!).writingMode : undefined;
      const draw =
        style === 'highlight'
          ? Overlayer.highlight
          : style === 'squiggly'
            ? Overlayer.squiggly
            : Overlayer.underline;
      const drawOpts = { color: markColor(style, opts.isDarkMode), writingMode };
      for (let i = occurrences.length - 1; i >= 0; i -= 1) {
        const occ = occurrences[i]!;
        const range = occurrenceRange(doc, model, occ);
        if (!range) continue;
        const key = `${VOCAB_MARK_PREFIX}${encodeURIComponent(occ.wordKey)}#${i}`;
        try {
          overlayer.add(key, range, draw, drawOpts);
          keys.push(key);
        } catch {
          // Range no longer valid (concurrent DOM mutation); skip.
        }
      }
    }
    sectionStates.set(doc, { overlayer, keys, signature });
    return keys.length;
  } catch (err) {
    console.warn('[vocab-marks] refresh failed', err);
    return 0;
  }
};

/** Parse a mark key back to its word key ("vocab%3Arun%23…" → "run"). */
export const wordKeyFromMarkValue = (value: string): string | null => {
  if (!value.startsWith(VOCAB_MARK_PREFIX)) return null;
  const encoded = value.slice(VOCAB_MARK_PREFIX.length).split('#')[0] ?? '';
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
};
