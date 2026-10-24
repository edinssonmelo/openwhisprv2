/**
 * Renderer-side transcript state machine fed by main-process ASR events.
 *
 * Rules (all enforced here, nowhere else):
 *   - finals are append-only and immutable; arrival order is display order;
 *   - previews are replace-only per (source, segmentId) and disappear when that segment finalizes or drops;
 *   - events from another session/generation, or for an already finalized segment, are rejected as stale;
 *   - no heuristic dedupe between finals: segments come from VAD and never overlap.
 *
 * Pure module (no React/DOM) so it is unit-testable with `scripts/test-transcript-coordinator.mjs`.
 */

import type { AsrEngineName, AsrLiveEvent, AsrSource } from './types';

export interface CommittedSegment {
  segmentId: string;
  source: AsrSource;
  text: string;
  startMs: number;
  endMs: number;
  engine: AsrEngineName;
  viaFallback: boolean;
  receivedAtMs: number;
}

export interface ProvisionalSegment {
  segmentId: string;
  source: AsrSource;
  text: string;
  startMs: number;
  endMs: number;
  engine: AsrEngineName;
  updatedAtMs: number;
  revisions: number;
}

export interface CoordinatorStats {
  previewsApplied: number;
  finalsApplied: number;
  emptyFinals: number;
  staleRejected: number;
  duplicateFinals: number;
  errors: number;
}

export interface TranscriptCoordinatorState {
  sessionId: string | null;
  generation: number;
  finals: readonly CommittedSegment[];
  provisional: readonly ProvisionalSegment[];
  /** Finals joined with single spaces. */
  committedText: string;
  /** Open-segment previews joined (mic before system when both are open). */
  provisionalText: string;
  /** committedText + provisionalText. */
  visibleText: string;
  liveEngine: AsrEngineName | null;
  finalEngine: AsrEngineName | null;
  fallbackUsed: boolean;
  lastFinalAtMs: number | null;
  lastPreviewAtMs: number | null;
  lastDrain: Extract<AsrLiveEvent, { type: 'drained' }> | null;
  lastReason: string;
  stats: CoordinatorStats;
}

export interface ApplyResult {
  applied: boolean;
  reason: string;
}

export interface TranscriptCoordinatorOptions {
  now?: () => number;
}

const SOURCE_ORDER: Record<AsrSource, number> = { mic: 0, system: 1 };

function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function createInitialState(): TranscriptCoordinatorState {
  return {
    sessionId: null,
    generation: 0,
    finals: [],
    provisional: [],
    committedText: '',
    provisionalText: '',
    visibleText: '',
    liveEngine: null,
    finalEngine: null,
    fallbackUsed: false,
    lastFinalAtMs: null,
    lastPreviewAtMs: null,
    lastDrain: null,
    lastReason: 'initial',
    stats: { previewsApplied: 0, finalsApplied: 0, emptyFinals: 0, staleRejected: 0, duplicateFinals: 0, errors: 0 },
  };
}

export class TranscriptCoordinator {
  private state: TranscriptCoordinatorState = createInitialState();
  private finalizedSegmentIds = new Set<string>();
  private readonly listeners = new Set<(state: TranscriptCoordinatorState) => void>();
  private readonly now: () => number;

  constructor(options: TranscriptCoordinatorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  getState(): TranscriptCoordinatorState {
    return this.state;
  }

  subscribe(listener: (state: TranscriptCoordinatorState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** New session: everything is cleared. */
  beginSession(sessionId: string, generation: number): TranscriptCoordinatorState {
    this.finalizedSegmentIds = new Set();
    this.state = { ...createInitialState(), sessionId, generation, lastReason: 'session-begin' };
    this.notify();
    return this.state;
  }

  /**
   * Same session, new capture generation (reconnect, source change): finals survive, previews are cleared,
   * events from the previous generation become stale.
   */
  bumpGeneration(generation: number): TranscriptCoordinatorState {
    this.setState({ generation, provisional: [], lastReason: 'generation-bump' });
    return this.state;
  }

  reset(): TranscriptCoordinatorState {
    this.finalizedSegmentIds = new Set();
    this.state = createInitialState();
    this.notify();
    return this.state;
  }

  /** Replaces the transcript wholesale (session restore). Marks segments as finalized. */
  hydrate(sessionId: string, generation: number, finals: CommittedSegment[]): TranscriptCoordinatorState {
    this.finalizedSegmentIds = new Set(finals.map((segment) => segment.segmentId));
    this.state = { ...createInitialState(), sessionId, generation, finals: [...finals], lastReason: 'hydrate' };
    this.recomputeText();
    this.notify();
    return this.state;
  }

  applyEvent(event: AsrLiveEvent): ApplyResult {
    if (event.sessionId !== this.state.sessionId || event.generation !== this.state.generation) {
      this.bumpStat('staleRejected', `stale:${event.type}`);
      return { applied: false, reason: 'stale-session-or-generation' };
    }

    switch (event.type) {
      case 'segment-open':
        return { applied: true, reason: 'segment-open' };

      case 'preview': {
        if (this.finalizedSegmentIds.has(event.segmentId)) {
          this.bumpStat('staleRejected', 'preview-after-final');
          return { applied: false, reason: 'preview-after-final' };
        }
        const text = sanitize(event.text);
        if (!text) return { applied: false, reason: 'preview-empty' };
        const receivedAtMs = this.now();
        const existing = this.state.provisional.find((segment) => segment.segmentId === event.segmentId);
        const next: ProvisionalSegment = {
          segmentId: event.segmentId,
          source: event.source,
          text,
          startMs: event.startMs,
          endMs: event.endMs,
          engine: event.engine,
          updatedAtMs: receivedAtMs,
          revisions: existing ? existing.revisions + 1 : 1,
        };
        const provisional = existing
          ? this.state.provisional.map((segment) => (segment.segmentId === event.segmentId ? next : segment))
          : [...this.state.provisional, next].sort(
              (a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.startMs - b.startMs,
            );
        this.setState({
          provisional,
          liveEngine: event.engine,
          lastPreviewAtMs: receivedAtMs,
          lastReason: existing ? 'preview-replaced' : 'preview-opened',
          stats: { ...this.state.stats, previewsApplied: this.state.stats.previewsApplied + 1 },
        });
        return { applied: true, reason: existing ? 'preview-replaced' : 'preview-opened' };
      }

      case 'final': {
        if (this.finalizedSegmentIds.has(event.segmentId)) {
          this.bumpStat('duplicateFinals', 'final-duplicate');
          return { applied: false, reason: 'final-duplicate' };
        }
        this.finalizedSegmentIds.add(event.segmentId);
        const text = sanitize(event.text);
        const receivedAtMs = this.now();
        const provisional = this.state.provisional.filter((segment) => segment.segmentId !== event.segmentId);
        if (!text) {
          this.setState({
            provisional,
            lastReason: 'final-empty',
            stats: { ...this.state.stats, emptyFinals: this.state.stats.emptyFinals + 1 },
          });
          return { applied: true, reason: 'final-empty' };
        }
        const segment: CommittedSegment = {
          segmentId: event.segmentId,
          source: event.source,
          text,
          startMs: event.startMs,
          endMs: event.endMs,
          engine: event.engine,
          viaFallback: event.viaFallback,
          receivedAtMs,
        };
        this.setState({
          finals: [...this.state.finals, segment],
          provisional,
          finalEngine: event.engine,
          fallbackUsed: this.state.fallbackUsed || event.viaFallback,
          lastFinalAtMs: receivedAtMs,
          lastReason: 'final-appended',
          stats: { ...this.state.stats, finalsApplied: this.state.stats.finalsApplied + 1 },
        });
        return { applied: true, reason: 'final-appended' };
      }

      case 'segment-dropped': {
        this.finalizedSegmentIds.add(event.segmentId);
        const provisional = this.state.provisional.filter((segment) => segment.segmentId !== event.segmentId);
        this.setState({ provisional, lastReason: `segment-dropped:${event.reason}` });
        return { applied: true, reason: `segment-dropped:${event.reason}` };
      }

      case 'error':
        this.bumpStat('errors', `error:${event.kind}`);
        return { applied: true, reason: `error:${event.kind}` };

      case 'drained':
        this.setState({ provisional: [], lastDrain: event, lastReason: 'drained' });
        return { applied: true, reason: 'drained' };

      default:
        return { applied: false, reason: 'unknown-event' };
    }
  }

  // ——— internals ———

  private bumpStat(key: keyof CoordinatorStats, reason: string): void {
    this.setState({ stats: { ...this.state.stats, [key]: this.state.stats[key] + 1 }, lastReason: reason });
  }

  private setState(patch: Partial<TranscriptCoordinatorState>): void {
    this.state = { ...this.state, ...patch };
    this.recomputeText();
    this.notify();
  }

  private recomputeText(): void {
    const committedText = this.state.finals.map((segment) => segment.text).join(' ').trim();
    const provisionalText = this.state.provisional.map((segment) => segment.text).join(' ').trim();
    const visibleText = [committedText, provisionalText].filter(Boolean).join(' ');
    this.state = { ...this.state, committedText, provisionalText, visibleText };
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

export function createTranscriptCoordinator(options?: TranscriptCoordinatorOptions): TranscriptCoordinator {
  return new TranscriptCoordinator(options);
}

/** Human label for the footer: `Live: Parakeet · Final: Parakeet` / `Final: Whisper Turbo (fallback)`. */
export function describeEngine(engine: AsrEngineName | null): string | null {
  if (!engine) return null;
  if (engine.startsWith('parakeet')) return 'Parakeet TDT v3';
  if (engine.startsWith('whisper')) return 'Whisper Turbo';
  return engine;
}
