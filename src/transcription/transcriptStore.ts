import type {
  TranscriptFinalInput,
  TranscriptPreviewHistoryEntry,
  TranscriptPreviewInput,
  TranscriptViewState,
} from './types';

export interface TranscriptStoreOptions {
  hiddenPreviewTailWords?: number;
  maxPreviewHistoryPerSegment?: number;
  maxOverlapWords?: number;
  minStablePreviewWords?: number;
  maxDivergenceRatio?: number;
}

export interface TranscriptStore {
  acceptPreview(input: TranscriptPreviewInput): TranscriptViewState;
  acceptFinal(input: TranscriptFinalInput): TranscriptViewState;
  getState(): TranscriptViewState;
  reset(): TranscriptViewState;
}

interface MutableTranscriptState {
  committedText: string;
  previewSuffix: string;
  rawPreview: string;
  segmentId: string | null;
  lastReason: string;
  previewHistory: TranscriptPreviewHistoryEntry[];
}

const DEFAULT_OPTIONS: Required<TranscriptStoreOptions> = {
  hiddenPreviewTailWords: 3,
  maxPreviewHistoryPerSegment: 6,
  maxOverlapWords: 16,
  minStablePreviewWords: 1,
  maxDivergenceRatio: 0.45,
};

export function createTranscriptStore(options: TranscriptStoreOptions = {}): TranscriptStore {
  const cfg = { ...DEFAULT_OPTIONS, ...options };
  let state: MutableTranscriptState = createInitialState();

  function getState(): TranscriptViewState {
    return freezeState(state, cfg.maxOverlapWords);
  }

  function reset(): TranscriptViewState {
    state = createInitialState();
    return getState();
  }

  function acceptPreview(input: TranscriptPreviewInput): TranscriptViewState {
    const rawPreview = sanitizeText(input.text);
    const receivedAtMs = input.receivedAtMs ?? Date.now();

    if (input.segmentId !== state.segmentId) {
      state = {
        ...state,
        previewSuffix: '',
        rawPreview: '',
        segmentId: input.segmentId,
        previewHistory: [],
        lastReason: 'preview-segment-reset',
      };
    }

    state.rawPreview = rawPreview;

    if (!rawPreview) {
      pushPreviewHistory('', '', 'preview-empty', receivedAtMs);
      return getState();
    }

    const currentWords = revealablePreviewWords(rawPreview, cfg.hiddenPreviewTailWords);
    const previous = state.previewHistory.at(-1);
    if (!previous) {
      pushPreviewHistory(rawPreview, '', 'preview-held-for-confirmation', receivedAtMs);
      return getState();
    }

    const previousWords = revealablePreviewWords(previous.rawPreview, cfg.hiddenPreviewTailWords);
    const stableWords = commonPrefixWords(previousWords, currentWords);

    if (stableWords.length < cfg.minStablePreviewWords) {
      pushPreviewHistory(rawPreview, '', 'preview-no-stable-prefix', receivedAtMs);
      return getState();
    }

    const previewWords = splitWords(state.previewSuffix);
    const divergence = prefixDivergenceRatio(previewWords, stableWords);
    if (previewWords.length > 0 && divergence > cfg.maxDivergenceRatio) {
      pushPreviewHistory(rawPreview, joinWords(stableWords), 'preview-diverged-held', receivedAtMs);
      return getState();
    }

    const acceptedWords = appendNewWords(previewWords, stableWords, cfg.maxOverlapWords);
    if (acceptedWords.length === 0) {
      pushPreviewHistory(rawPreview, joinWords(stableWords), 'preview-no-new-stable-words', receivedAtMs);
      return getState();
    }

    state.previewSuffix = appendWordsDeduped(state.previewSuffix, acceptedWords, cfg.maxOverlapWords);
    pushPreviewHistory(rawPreview, joinWords(stableWords), `preview-appended:${acceptedWords.length}`, receivedAtMs, joinWords(acceptedWords));
    return getState();
  }

  function acceptFinal(input: TranscriptFinalInput): TranscriptViewState {
    const finalText = sanitizeText(input.text);
    if (!finalText) {
      state = {
        ...state,
        previewSuffix: '',
        rawPreview: '',
        segmentId: null,
        previewHistory: [],
        lastReason: 'final-empty-preview-cleared',
      };
      return getState();
    }

    const before = state.committedText;
    const previewLine = appendWordsDeduped(before, splitWords(state.previewSuffix), cfg.maxOverlapWords);
    const finalWords = splitWords(finalText);
    const wordsToAppend = appendNewWords(splitWords(before), finalWords, cfg.maxOverlapWords);
    const nextCommitted = appendWordsDeduped(before, wordsToAppend, cfg.maxOverlapWords);

    const alreadyVisibleAfterCommit = appendWordsDeduped(previewLine, wordsToAppend, cfg.maxOverlapWords) === previewLine;
    const reason = wordsToAppend.length === 0
      ? 'final-already-visible'
      : alreadyVisibleAfterCommit
        ? `final-committed-preview-visible:${wordsToAppend.length}`
      : finalDiffersFromPreview(state.previewSuffix, finalText)
        ? `final-diverged-appended-safe:${wordsToAppend.length}`
        : `final-appended:${wordsToAppend.length}`;

    state = {
      committedText: nextCommitted,
      previewSuffix: '',
      rawPreview: '',
      segmentId: null,
      lastReason: reason,
      previewHistory: state.previewHistory,
    };
    return getState();
  }

  function pushPreviewHistory(
    rawPreview: string,
    stablePreview: string,
    reason: string,
    receivedAtMs: number,
    acceptedText = '',
  ): void {
    state.lastReason = reason;
    state.previewHistory = [
      ...state.previewHistory,
      {
        segmentId: state.segmentId ?? 'unknown',
        rawPreview,
        stablePreview,
        acceptedText,
        reason,
        receivedAtMs,
      },
    ].slice(-cfg.maxPreviewHistoryPerSegment);
  }

  return {
    acceptPreview,
    acceptFinal,
    getState,
    reset,
  };
}

function createInitialState(): MutableTranscriptState {
  return {
    committedText: '',
    previewSuffix: '',
    rawPreview: '',
    segmentId: null,
    lastReason: 'initial',
    previewHistory: [],
  };
}

function freezeState(state: MutableTranscriptState, maxOverlapWords: number): TranscriptViewState {
  return {
    committedText: state.committedText,
    previewSuffix: state.previewSuffix,
    rawPreview: state.rawPreview,
    segmentId: state.segmentId,
    visibleText: appendWordsDeduped(state.committedText, splitWords(state.previewSuffix), maxOverlapWords),
    lastReason: state.lastReason,
    previewHistory: state.previewHistory.map((entry) => ({ ...entry })),
  };
}

function revealablePreviewWords(text: string, hiddenTailWords: number): string[] {
  const words = splitWords(text);
  if (words.length <= hiddenTailWords) return [];
  return words.slice(0, words.length - hiddenTailWords);
}

function appendNewWords(visibleWords: string[], candidateWords: string[], maxOverlapWords: number): string[] {
  if (candidateWords.length === 0) return [];
  if (visibleWords.length === 0) return candidateWords;

  const max = Math.min(maxOverlapWords, visibleWords.length, candidateWords.length);
  for (let n = max; n >= 1; n -= 1) {
    const left = visibleWords.slice(visibleWords.length - n).map(normalizeWord);
    const right = candidateWords.slice(0, n).map(normalizeWord);
    if (left.every((word, index) => word === right[index])) {
      return candidateWords.slice(n);
    }
  }

  return candidateWords;
}

function appendWordsDeduped(existingText: string, wordsToAppend: string[], maxOverlapWords: number): string {
  const existingWords = splitWords(existingText);
  const newWords = appendNewWords(existingWords, wordsToAppend, maxOverlapWords);
  if (newWords.length === 0) return sanitizeText(existingText);
  return joinWords([...existingWords, ...newWords]);
}

function commonPrefixWords(left: string[], right: string[]): string[] {
  const limit = Math.min(left.length, right.length);
  const out: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    if (normalizeWord(left[index]) !== normalizeWord(right[index])) break;
    out.push(right[index]);
  }
  return out;
}

function prefixDivergenceRatio(visibleWords: string[], candidateWords: string[]): number {
  if (visibleWords.length === 0) return 0;
  const stablePrefix = commonPrefixWords(visibleWords, candidateWords).length;
  return 1 - stablePrefix / Math.max(visibleWords.length, 1);
}

function finalDiffersFromPreview(previewSuffix: string, finalText: string): boolean {
  const previewWords = splitWords(previewSuffix);
  if (previewWords.length === 0) return false;
  const finalWords = splitWords(finalText);
  return commonPrefixWords(previewWords, finalWords).length < Math.min(previewWords.length, finalWords.length);
}

function splitWords(text: string): string[] {
  return sanitizeText(text).split(/\s+/).filter(Boolean);
}

function joinWords(words: string[]): string {
  return words.join(' ').trim();
}

function sanitizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\p{P}+|\p{P}+$/gu, '');
}
