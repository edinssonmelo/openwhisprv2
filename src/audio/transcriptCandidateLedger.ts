export type TranscriptCandidateMode = 'preview' | 'final';

export interface TranscriptCandidateInput {
  id: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  mode: TranscriptCandidateMode;
  source: 'mic' | 'system' | 'mixed';
  rms: number;
  peak?: number;
  modelName?: string;
  durationMs?: number;
  suspicious?: boolean;
  language?: 'es' | 'auto';
  receivedAtMs?: number;
}

export interface TranscriptCandidate extends TranscriptCandidateInput {
  receivedAtMs: number;
  normalizedText: string;
  tokenCount: number;
}

export interface LedgerDebugGroup {
  segmentId: string;
  startMs: number;
  endMs: number;
  committed: boolean;
  chosenCandidateId: string | null;
  chosenText: string;
  reasons: string[];
  candidates: Array<{
    id: string;
    mode: TranscriptCandidateMode;
    text: string;
    score: number;
    reasons: string[];
    startMs: number;
    endMs: number;
    modelName?: string;
  }>;
}

export interface LedgerSnapshot {
  committedText: string;
  unstableText: string;
  lastReason: string;
  committedThroughMs: number;
  debugGroups: LedgerDebugGroup[];
  nextFlushDelayMs: number | null;
}

interface CandidateGroup {
  segmentId: string;
  startMs: number;
  endMs: number;
  candidates: TranscriptCandidate[];
  committedCandidateId: string | null;
  firstSeenAtMs: number;
  finalSeenAtMs: number | null;
}

interface ScoredCandidate {
  candidate: TranscriptCandidate;
  score: number;
  reasons: string[];
}

export interface TranscriptCandidateLedgerConfig {
  retentionMs: number;
  normalCommitDelayMs: number;
  firstSegmentProtectedUntilMs: number;
  firstSegmentHoldMs: number;
}

const DEFAULT_CONFIG: TranscriptCandidateLedgerConfig = {
  retentionMs: 30_000,
  normalCommitDelayMs: 1_500,
  firstSegmentProtectedUntilMs: 15_000,
  firstSegmentHoldMs: 12_000,
};

export class TranscriptCandidateLedger {
  private cfg: TranscriptCandidateLedgerConfig;
  private groups: CandidateGroup[] = [];
  private committedOrder: string[] = [];

  constructor(config: Partial<TranscriptCandidateLedgerConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  reset(): void {
    this.groups = [];
    this.committedOrder = [];
  }

  addCandidate(input: TranscriptCandidateInput, nowMs = Date.now()): LedgerSnapshot {
    const text = sanitizeTranscriptText(input.text);
    if (!text) return this.snapshot(nowMs);

    const candidate: TranscriptCandidate = {
      ...input,
      text,
      receivedAtMs: input.receivedAtMs ?? nowMs,
      normalizedText: normalizeForLedger(text),
      tokenCount: tokenizeForLedger(text).length,
    };

    let group = this.groups.find((g) => g.segmentId === candidate.segmentId);
    if (!group) {
      group = {
        segmentId: candidate.segmentId,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        candidates: [],
        committedCandidateId: null,
        firstSeenAtMs: candidate.receivedAtMs,
        finalSeenAtMs: null,
      };
      this.groups.push(group);
      this.groups.sort((a, b) => a.startMs - b.startMs);
    }

    group.startMs = Math.min(group.startMs, candidate.startMs);
    group.endMs = Math.max(group.endMs, candidate.endMs);
    group.firstSeenAtMs = Math.min(group.firstSeenAtMs, candidate.receivedAtMs);
    if (candidate.mode === 'final') {
      group.finalSeenAtMs = group.finalSeenAtMs === null
        ? candidate.receivedAtMs
        : Math.min(group.finalSeenAtMs, candidate.receivedAtMs);
    }

    const duplicate = group.candidates.find(
      (c) => c.id === candidate.id || (c.mode === candidate.mode && c.normalizedText === candidate.normalizedText),
    );
    if (!duplicate) group.candidates.push(candidate);

    this.flush(nowMs);
    this.prune(nowMs);
    return this.snapshot(nowMs);
  }

  flush(nowMs = Date.now()): LedgerSnapshot {
    for (const group of this.groups) {
      if (group.committedCandidateId) continue;
      const best = this.pickBest(group);
      if (!best || !this.isMature(group, best, nowMs)) continue;
      group.committedCandidateId = best.candidate.id;
      this.committedOrder.push(group.segmentId);
    }
    this.prune(nowMs);
    return this.snapshot(nowMs);
  }

  snapshot(nowMs = Date.now()): LedgerSnapshot {
    const committedGroups = this.groups
      .filter((group) => group.committedCandidateId)
      .sort((a, b) => a.startMs - b.startMs);
    const committedText = committedGroups
      .map((group) => this.pickCommitted(group)?.text ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const pending = this.groups
      .filter((group) => !group.committedCandidateId)
      .sort((a, b) => a.startMs - b.startMs);
    const unstableText = pending
      .map((group) => this.pickBest(group)?.candidate.text ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const latestCommitted = committedGroups.at(-1);
    const latestPending = pending[0];

    return {
      committedText,
      unstableText,
      lastReason: latestPending
        ? `ledger-holding:${latestPending.segmentId}`
        : latestCommitted
          ? `ledger-committed:${latestCommitted.segmentId}`
          : 'ledger-waiting',
      committedThroughMs: latestCommitted?.endMs ?? 0,
      debugGroups: this.groups.map((group) => this.toDebugGroup(group)),
      nextFlushDelayMs: this.nextFlushDelay(nowMs),
    };
  }

  private pickCommitted(group: CandidateGroup): TranscriptCandidate | null {
    if (!group.committedCandidateId) return null;
    return group.candidates.find((candidate) => candidate.id === group.committedCandidateId) ?? null;
  }

  private pickBest(group: CandidateGroup): ScoredCandidate | null {
    if (group.candidates.length === 0) return null;
    const scored = group.candidates.map((candidate) => this.scoreCandidate(candidate, group));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.candidate.mode !== b.candidate.mode) return a.candidate.mode === 'preview' ? -1 : 1;
      return a.candidate.receivedAtMs - b.candidate.receivedAtMs;
    });
    return scored[0];
  }

  private scoreCandidate(candidate: TranscriptCandidate, group: CandidateGroup): ScoredCandidate {
    const reasons: string[] = [];
    let score = candidate.mode === 'final' ? 10 : 8;
    if (candidate.mode === 'final') reasons.push('final-candidate-not-authoritative');
    if (candidate.mode === 'preview') reasons.push('early-preview-preserved');

    score += Math.min(candidate.tokenCount, 28) * 0.35;
    const quality = assessTranscriptQuality(candidate.text, candidate.language ?? 'es');
    score += quality.scoreDelta;
    reasons.push(...quality.reasons);

    const compatible = group.candidates.filter((other) => other.id !== candidate.id && areCompatible(candidate, other));
    if (compatible.length > 0) {
      if (quality.severe) {
        score += Math.min(compatible.length, 3) * 1;
        reasons.push('repeated-but-low-quality');
      } else {
        score += Math.min(compatible.length, 3) * 5;
        reasons.push('consistent-with-other-window');
      }
    }

    const maxTokens = Math.max(...group.candidates.map((c) => c.tokenCount), 0);
    const maxChars = Math.max(...group.candidates.map((c) => c.normalizedText.length), 0);
    const shorterTokenRegression = maxTokens >= 6 && candidate.tokenCount < maxTokens * 0.65;
    const shorterCharRegression = maxChars >= 24 && candidate.normalizedText.length < maxChars * 0.65;
    if (shorterTokenRegression || shorterCharRegression) {
      score -= candidate.mode === 'final' ? 14 : 10;
      reasons.push('shorter-regression-rejected');
    }

    if (candidate.suspicious) {
      score -= 12;
      reasons.push('suspicious-phrase');
    }

    if (candidate.normalizedText.length === 0) {
      score -= 100;
      reasons.push('empty-normalized');
    }

    return { candidate, score, reasons };
  }

  private isMature(group: CandidateGroup, best: ScoredCandidate, nowMs: number): boolean {
    if (group.finalSeenAtMs === null) return false;
    if (best.score < -10) return false;
    const hasCompatible = group.candidates.some((candidate) => candidate.id !== best.candidate.id && areCompatible(candidate, best.candidate));
    if (hasCompatible) return true;
    if (group.startMs < this.cfg.firstSegmentProtectedUntilMs) {
      return nowMs - group.firstSeenAtMs >= this.cfg.firstSegmentHoldMs;
    }
    return nowMs - group.finalSeenAtMs >= this.cfg.normalCommitDelayMs;
  }

  private nextFlushDelay(nowMs: number): number | null {
    let next: number | null = null;
    for (const group of this.groups) {
      if (group.committedCandidateId || group.finalSeenAtMs === null) continue;
      const best = this.pickBest(group);
      if (!best) continue;
      if (group.candidates.some((candidate) => candidate.id !== best.candidate.id && areCompatible(candidate, best.candidate))) continue;
      const dueAt = group.startMs < this.cfg.firstSegmentProtectedUntilMs
        ? group.firstSeenAtMs + this.cfg.firstSegmentHoldMs
        : group.finalSeenAtMs + this.cfg.normalCommitDelayMs;
      const delay = Math.max(0, dueAt - nowMs);
      next = next === null ? delay : Math.min(next, delay);
    }
    return next;
  }

  private prune(nowMs: number): void {
    const newestCommittedMs = Math.max(
      0,
      ...this.groups
        .filter((group) => group.committedCandidateId)
        .map((group) => group.firstSeenAtMs),
    );
    this.groups = this.groups.filter((group) => {
      if (!group.committedCandidateId) return true;
      return nowMs - Math.max(group.firstSeenAtMs, newestCommittedMs) <= this.cfg.retentionMs;
    });
  }

  private toDebugGroup(group: CandidateGroup): LedgerDebugGroup {
    const best = this.pickBest(group);
    const scored = group.candidates
      .map((candidate) => this.scoreCandidate(candidate, group))
      .sort((a, b) => b.score - a.score);
    return {
      segmentId: group.segmentId,
      startMs: group.startMs,
      endMs: group.endMs,
      committed: Boolean(group.committedCandidateId),
      chosenCandidateId: group.committedCandidateId ?? best?.candidate.id ?? null,
      chosenText: (group.committedCandidateId ? this.pickCommitted(group)?.text : best?.candidate.text) ?? '',
      reasons: best?.reasons ?? [],
      candidates: scored.map((entry) => ({
        id: entry.candidate.id,
        mode: entry.candidate.mode,
        text: entry.candidate.text,
        score: Number(entry.score.toFixed(2)),
        reasons: entry.reasons,
        startMs: entry.candidate.startMs,
        endMs: entry.candidate.endMs,
        modelName: entry.candidate.modelName,
      })),
    };
  }
}

export function createTranscriptCandidateLedger(config?: Partial<TranscriptCandidateLedgerConfig>): TranscriptCandidateLedger {
  return new TranscriptCandidateLedger(config);
}

function sanitizeTranscriptText(text: string): string {
  return text
    .replace(/\banchor-[a-z0-9-]+\b/giu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForLedger(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForLedger(text: string): string[] {
  return normalizeForLedger(text).split(/\s+/).filter(Boolean);
}

function areCompatible(left: TranscriptCandidate, right: TranscriptCandidate): boolean {
  if (!left.normalizedText || !right.normalizedText) return false;
  if (left.normalizedText === right.normalizedText) return true;
  if (left.normalizedText.includes(right.normalizedText) || right.normalizedText.includes(left.normalizedText)) {
    const shorter = Math.min(left.normalizedText.length, right.normalizedText.length);
    return shorter >= 12;
  }
  const leftTokens = tokenizeForLedger(left.text);
  const rightTokens = tokenizeForLedger(right.text);
  return jaccard(leftTokens, rightTokens) >= 0.58 || commonPrefixTokens(leftTokens, rightTokens) >= 4;
}

function commonPrefixTokens(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const l = new Set(left);
  const r = new Set(right);
  let intersection = 0;
  for (const token of l) {
    if (r.has(token)) intersection += 1;
  }
  return intersection / Math.max(1, l.size + r.size - intersection);
}

function assessTranscriptQuality(text: string, language: 'es' | 'auto'): { scoreDelta: number; reasons: string[]; severe: boolean } {
  const normalized = normalizeForLedger(text);
  const tokens = tokenizeForLedger(text);
  const reasons: string[] = [];
  let scoreDelta = 0;
  let severe = false;

  if (/[ðþæøå]/iu.test(text)) {
    scoreDelta -= 45;
    severe = true;
    reasons.push('non-spanish-characters');
  }

  const spanishHints = countSpanishHints(tokens);
  if (language === 'es') {
    if (spanishHints >= 2) {
      scoreDelta += 12;
      reasons.push('spanish-language-evidence');
    } else if (tokens.length >= 4) {
      scoreDelta -= 10;
      reasons.push('weak-spanish-evidence');
    }
  }

  const weirdInitialAcronyms = text.match(/^\s*(?:[A-Z]{2,5}[\s,.:-]+){1,3}/u);
  if (weirdInitialAcronyms && spanishHints < 2) {
    scoreDelta -= 18;
    reasons.push('weird-leading-acronyms');
  } else if (weirdInitialAcronyms) {
    scoreDelta -= 6;
    reasons.push('leading-acronym-uncertain');
  }

  if (/(\.\s*){4,}/u.test(text) || normalized.length === 0) {
    scoreDelta -= 35;
    severe = true;
    reasons.push('punctuation-only-or-empty');
  }

  const latinLetterCount = (text.match(/\p{Letter}/gu) ?? []).length;
  const asciiOrSpanishLetterCount = (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/gu) ?? []).length;
  if (latinLetterCount >= 8 && asciiOrSpanishLetterCount / latinLetterCount < 0.82) {
    scoreDelta -= 25;
    severe = true;
    reasons.push('unexpected-letter-mix');
  }

  return { scoreDelta, reasons, severe };
}

function countSpanishHints(tokens: string[]): number {
  const hints = new Set([
    'que', 'como', 'cual', 'cuál', 'era', 'es', 'la', 'el', 'los', 'las', 'de', 'del',
    'en', 'un', 'una', 'podria', 'podría', 'ser', 'estamos', 'hablando', 'pues',
    'algun', 'algún', 'punto', 'estado', 'actualizara', 'mejor', 'opcion', 'opción',
    'no', 'si', 'sí', 'para', 'por',
  ]);
  let count = 0;
  for (const token of tokens) {
    if (hints.has(token)) count += 1;
  }
  return count;
}
