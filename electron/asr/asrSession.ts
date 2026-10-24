/**
 * Main-process live ASR session: VAD endpointing per source, replace-only previews of the open segment,
 * append-only finals for closed segments, and an ordered drain on stop so no audio is lost.
 *
 * Pure module (no Electron imports) so `scripts/asr-benchmark.mjs` and unit tests can drive it with any engine.
 */

import type { AsrLanguageCode, AsrRequestKind, AsrSource } from './protocol';
import { ASR_SAMPLE_RATE, resampleToAsrRate } from './resample';
import { DEFAULT_VAD_CONFIG, VadEndpointing, type VadClosedSegment, type VadConfig } from './vadEndpointing';

export interface EngineRequest {
  requestId: string;
  sessionId: string;
  generation: number;
  source: AsrSource;
  segmentId: string;
  kind: AsrRequestKind;
  /** 16 kHz mono float32. */
  samples: Float32Array;
  sampleRate: number;
  startMs: number;
  endMs: number;
  language: AsrLanguageCode;
}

export interface EngineResult {
  text: string;
  confidence?: number;
  processingMs: number;
  engine: string;
}

export interface AsrEngine {
  /** Stable engine id used in events and UI (e.g. `parakeet-tdt-0.6b-v3`, `whisper-large-v3-turbo`). */
  readonly name: string;
  /** False for engines too slow for rolling previews (whisper.cpp fallback). */
  readonly supportsPreview: boolean;
  transcribe(request: EngineRequest): Promise<EngineResult>;
  /** Drop queued previews (best effort) so finals get the engine immediately. */
  cancelPreviews?(sessionId: string): void;
}

/** Thrown by engines when a request was superseded/cancelled before running (not an engine failure). */
export class RequestDroppedError extends Error {
  constructor(public readonly requestId: string, public readonly reason: string) {
    super(`request ${requestId} dropped: ${reason}`);
    this.name = 'RequestDroppedError';
  }
}

interface EventBase {
  sessionId: string;
  generation: number;
  source: AsrSource;
  segmentId: string;
}

export type AsrSessionEvent =
  | (EventBase & { type: 'segment-open'; startMs: number })
  | (EventBase & {
      type: 'preview';
      text: string;
      startMs: number;
      endMs: number;
      engine: string;
      latencyMs: number;
    })
  | (EventBase & {
      type: 'final';
      text: string;
      startMs: number;
      endMs: number;
      engine: string;
      /** Wall time from segment close to result. */
      latencyMs: number;
      audioMs: number;
      /** Final produced by the fallback engine after the primary failed. */
      viaFallback: boolean;
    })
  | (EventBase & { type: 'segment-dropped'; startMs: number; endMs: number; reason: 'too-short' | 'error' | 'stale' })
  | (EventBase & { type: 'error'; kind: AsrRequestKind; message: string })
  | {
      type: 'drained';
      sessionId: string;
      generation: number;
      finalsFlushed: number;
      finalsFailed: number;
      previewsCancelled: number;
      timedOut: boolean;
      elapsedMs: number;
    };

export interface AsrSessionStats {
  pushedMs: Record<AsrSource, number>;
  segmentsOpened: number;
  finalsEmitted: number;
  finalsEmpty: number;
  finalsFailed: number;
  previewsEmitted: number;
  previewsSkippedBusy: number;
  previewsStale: number;
  fallbackFinals: number;
  firstPreviewLatencyMs: number[];
  finalLatencyMs: number[];
}

export interface AsrSessionOptions {
  sessionId: string;
  generation: number;
  language: AsrLanguageCode;
  engine: AsrEngine;
  fallbackEngine?: AsrEngine | null;
  emit: (event: AsrSessionEvent) => void;
  /** Injected clock (ms) for tests. */
  now?: () => number;
  vad?: Partial<VadConfig>;
  /** Minimum interval between preview requests per source. */
  previewIntervalMs?: number;
  /** Do not preview segments shorter than this. */
  minPreviewAudioMs?: number;
  /** Segments with less detected speech than this are dropped as noise. */
  minFinalAudioMs?: number;
  previewTimeoutMs?: number;
  finalTimeoutMs?: number;
  /** Disable previews regardless of engine support. */
  previewsEnabled?: boolean;
}

/** Endpointing tuned for live finals: ~1.1 s after the speaker stops instead of ~1.6 s (renderer defaults). */
export const LIVE_VAD_CONFIG: Partial<VadConfig> = {
  silenceToCloseMs: 650,
  hangoverMs: 200,
  postRollMs: 250,
  minSpeechMs: 400,
  maxSegmentMs: 20_000,
};

interface SourceState {
  vad: VadEndpointing;
  sampleCursor: number;
  segmentCounter: number;
  openSegmentId: string | null;
  openSegmentStartMs: number;
  lastPreviewSentAt: number;
  previewInFlight: boolean;
  previewGeneration: number;
  lastPreviewText: string;
}

const VAD_FRAME_SAMPLES = 480; // 30 ms @ 16 kHz

const DEFAULTS = {
  previewIntervalMs: 600,
  minPreviewAudioMs: 500,
  minFinalAudioMs: 300,
  previewTimeoutMs: 4_000,
  finalTimeoutMs: 30_000,
};

let requestCounter = 0;
function nextRequestId(kind: AsrRequestKind): string {
  requestCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${requestCounter}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class AsrSession {
  readonly sessionId: string;
  readonly generation: number;
  private readonly language: AsrLanguageCode;
  private readonly engine: AsrEngine;
  private readonly fallbackEngine: AsrEngine | null;
  private readonly emit: (event: AsrSessionEvent) => void;
  private readonly now: () => number;
  private readonly vadConfig: Partial<VadConfig>;
  private readonly options: typeof DEFAULTS & { previewsEnabled: boolean };
  private readonly sources = new Map<AsrSource, SourceState>();
  private readonly finalsInFlight = new Set<Promise<void>>();
  private readonly finalizedSegments = new Set<string>();
  private stopping = false;
  private stopped = false;
  readonly stats: AsrSessionStats = {
    pushedMs: { mic: 0, system: 0 },
    segmentsOpened: 0,
    finalsEmitted: 0,
    finalsEmpty: 0,
    finalsFailed: 0,
    previewsEmitted: 0,
    previewsSkippedBusy: 0,
    previewsStale: 0,
    fallbackFinals: 0,
    firstPreviewLatencyMs: [],
    finalLatencyMs: [],
  };

  constructor(options: AsrSessionOptions) {
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.language = options.language;
    this.engine = options.engine;
    this.fallbackEngine = options.fallbackEngine ?? null;
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.vadConfig = { ...LIVE_VAD_CONFIG, ...(options.vad ?? {}) };
    this.options = {
      previewIntervalMs: options.previewIntervalMs ?? DEFAULTS.previewIntervalMs,
      minPreviewAudioMs: options.minPreviewAudioMs ?? DEFAULTS.minPreviewAudioMs,
      minFinalAudioMs: options.minFinalAudioMs ?? DEFAULTS.minFinalAudioMs,
      previewTimeoutMs: options.previewTimeoutMs ?? DEFAULTS.previewTimeoutMs,
      finalTimeoutMs: options.finalTimeoutMs ?? DEFAULTS.finalTimeoutMs,
      previewsEnabled: (options.previewsEnabled ?? true) && options.engine.supportsPreview,
    };
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get engineName(): string {
    return this.engine.name;
  }

  getVadConfig(): VadConfig {
    return { ...DEFAULT_VAD_CONFIG, ...this.vadConfig };
  }

  /**
   * Feed mono float32 PCM for one source. Any sample rate; resampled to 16 kHz here so VAD, previews,
   * finals and both engines all see identical audio.
   */
  pushAudio(source: AsrSource, samples: Float32Array, sampleRate: number): void {
    if (this.stopping || this.stopped || samples.length === 0) return;
    const pcm = resampleToAsrRate(samples, sampleRate);
    // VAD decisions are per frame: keep frames ≤ 30 ms regardless of how the capturer batches audio.
    for (let offset = 0; offset < pcm.length; offset += VAD_FRAME_SAMPLES) {
      this.pushFrame(source, pcm.subarray(offset, Math.min(pcm.length, offset + VAD_FRAME_SAMPLES)));
    }
  }

  private pushFrame(source: AsrSource, pcm: Float32Array): void {
    const state = this.getSource(source);
    const startSample = state.sampleCursor;
    state.sampleCursor += pcm.length;
    this.stats.pushedMs[source] += (pcm.length / ASR_SAMPLE_RATE) * 1000;

    const wasOpen = state.vad.isSegmentOpen();
    const { closed } = state.vad.pushFrame(pcm, ASR_SAMPLE_RATE, startSample);
    const isOpen = state.vad.isSegmentOpen();

    for (const segment of closed) {
      const segmentId = state.openSegmentId ?? this.newSegmentId(state, source, segment.startMs);
      this.closeSegment(source, state, segmentId, segment);
    }

    if (isOpen && (!wasOpen || state.openSegmentId === null)) {
      const snapshot = state.vad.getOpenSegmentSnapshot(ASR_SAMPLE_RATE);
      const startMs = snapshot ? snapshot.startMs : (startSample / ASR_SAMPLE_RATE) * 1000;
      const segmentId = this.newSegmentId(state, source, startMs);
      state.openSegmentId = segmentId;
      state.openSegmentStartMs = startMs;
      state.lastPreviewSentAt = 0;
      state.lastPreviewText = '';
      this.stats.segmentsOpened += 1;
      this.emit({ type: 'segment-open', ...this.base(source, segmentId), startMs });
    }

    if (isOpen && state.openSegmentId) {
      this.maybePreview(source, state);
    }
  }

  /**
   * Ordered shutdown: close open segments (even short ones), cancel previews only, await finals with a
   * timeout, and report what was flushed. Resolves once it is safe to persist the transcript.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<Extract<AsrSessionEvent, { type: 'drained' }>> {
    const timeoutMs = options.timeoutMs ?? 8_000;
    const startedAt = this.now();
    if (this.stopped) {
      return {
        type: 'drained',
        sessionId: this.sessionId,
        generation: this.generation,
        finalsFlushed: 0,
        finalsFailed: 0,
        previewsCancelled: 0,
        timedOut: false,
        elapsedMs: 0,
      };
    }
    this.stopping = true;
    let previewsCancelled = 0;
    const finalsBefore = this.stats.finalsEmitted + this.stats.finalsEmpty;
    const failedBefore = this.stats.finalsFailed;

    for (const [source, state] of this.sources) {
      if (state.previewInFlight) previewsCancelled += 1;
      state.previewGeneration += 1; // invalidates in-flight preview results
      const segmentId = state.openSegmentId;
      const raw = state.vad.closeOpenSegment(ASR_SAMPLE_RATE);
      if (raw && segmentId) {
        this.closeSegment(source, state, segmentId, raw);
      } else if (segmentId) {
        state.openSegmentId = null;
      }
    }
    this.engine.cancelPreviews?.(this.sessionId);

    let timedOut = false;
    if (this.finalsInFlight.size > 0) {
      const pending = Promise.allSettled(Array.from(this.finalsInFlight));
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
      const outcome = await Promise.race([pending.then(() => 'done' as const), timeout]);
      timedOut = outcome === 'timeout';
    }
    this.stopped = true;
    const event: Extract<AsrSessionEvent, { type: 'drained' }> = {
      type: 'drained',
      sessionId: this.sessionId,
      generation: this.generation,
      finalsFlushed: this.stats.finalsEmitted + this.stats.finalsEmpty - finalsBefore,
      finalsFailed: this.stats.finalsFailed - failedBefore,
      previewsCancelled,
      timedOut,
      elapsedMs: this.now() - startedAt,
    };
    this.emit(event);
    return event;
  }

  // ——— internals ———

  private base(source: AsrSource, segmentId: string): EventBase {
    return { sessionId: this.sessionId, generation: this.generation, source, segmentId };
  }

  private getSource(source: AsrSource): SourceState {
    let state = this.sources.get(source);
    if (!state) {
      state = {
        vad: new VadEndpointing(this.vadConfig),
        sampleCursor: 0,
        segmentCounter: 0,
        openSegmentId: null,
        openSegmentStartMs: 0,
        lastPreviewSentAt: 0,
        previewInFlight: false,
        previewGeneration: 0,
        lastPreviewText: '',
      };
      this.sources.set(source, state);
    }
    return state;
  }

  private newSegmentId(state: SourceState, source: AsrSource, startMs: number): string {
    state.segmentCounter += 1;
    return `${this.sessionId}:${this.generation}:${source}:${state.segmentCounter}:${Math.round(startMs)}`;
  }

  private maybePreview(source: AsrSource, state: SourceState): void {
    if (!this.options.previewsEnabled || !state.openSegmentId) return;
    const now = this.now();
    if (now - state.lastPreviewSentAt < this.options.previewIntervalMs) return;
    if (state.previewInFlight) {
      this.stats.previewsSkippedBusy += 1;
      return;
    }
    const snapshot = state.vad.getOpenSegmentSnapshot(ASR_SAMPLE_RATE);
    if (!snapshot || snapshot.durationMs < this.options.minPreviewAudioMs) return;

    const segmentId = state.openSegmentId;
    const previewGeneration = state.previewGeneration;
    const sentAt = now;
    state.lastPreviewSentAt = now;
    state.previewInFlight = true;
    const request: EngineRequest = {
      requestId: nextRequestId('preview'),
      sessionId: this.sessionId,
      generation: this.generation,
      source,
      segmentId,
      kind: 'preview',
      samples: snapshot.samples,
      sampleRate: ASR_SAMPLE_RATE,
      startMs: snapshot.startMs,
      endMs: snapshot.endMs,
      language: this.language,
    };
    withTimeout(this.engine.transcribe(request), this.options.previewTimeoutMs, 'preview')
      .then((result) => {
        state.previewInFlight = false;
        const stale =
          previewGeneration !== state.previewGeneration ||
          state.openSegmentId !== segmentId ||
          this.finalizedSegments.has(segmentId) ||
          this.stopping;
        if (stale) {
          this.stats.previewsStale += 1;
          return;
        }
        const text = result.text.trim();
        if (!text) return;
        if (state.lastPreviewText === '') {
          this.stats.firstPreviewLatencyMs.push(this.now() - sentAt);
        }
        state.lastPreviewText = text;
        this.stats.previewsEmitted += 1;
        this.emit({
          type: 'preview',
          ...this.base(source, segmentId),
          text,
          startMs: snapshot.startMs,
          endMs: snapshot.endMs,
          engine: result.engine,
          latencyMs: this.now() - sentAt,
        });
        // The interval elapsed while we were busy: keep the preview cadence without waiting for the next frame.
        if (state.openSegmentId === segmentId && this.now() - state.lastPreviewSentAt >= this.options.previewIntervalMs) {
          this.maybePreview(source, state);
        }
      })
      .catch((error: unknown) => {
        state.previewInFlight = false;
        if (error instanceof RequestDroppedError) return;
        if (previewGeneration !== state.previewGeneration || this.stopping) return;
        this.emit({
          type: 'error',
          ...this.base(source, segmentId),
          kind: 'preview',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private closeSegment(source: AsrSource, state: SourceState, segmentId: string, segment: VadClosedSegment): void {
    state.openSegmentId = null;
    state.previewGeneration += 1;
    this.finalizedSegments.add(segmentId);
    const closedAt = this.now();

    if (segment.speechMs < this.options.minFinalAudioMs) {
      this.emit({
        type: 'segment-dropped',
        ...this.base(source, segmentId),
        startMs: segment.startMs,
        endMs: segment.endMs,
        reason: 'too-short',
      });
      return;
    }

    const request: EngineRequest = {
      requestId: nextRequestId('final'),
      sessionId: this.sessionId,
      generation: this.generation,
      source,
      segmentId,
      kind: 'final',
      samples: segment.samples,
      sampleRate: ASR_SAMPLE_RATE,
      startMs: segment.startMs,
      endMs: segment.endMs,
      language: this.language,
    };

    const task = this.runFinal(request, segment, closedAt).finally(() => {
      this.finalsInFlight.delete(task);
    });
    this.finalsInFlight.add(task);
  }

  private async runFinal(request: EngineRequest, segment: VadClosedSegment, closedAt: number): Promise<void> {
    let result: EngineResult | null = null;
    let viaFallback = false;
    let primaryError: unknown = null;
    try {
      result = await withTimeout(this.engine.transcribe(request), this.options.finalTimeoutMs, 'final');
    } catch (error) {
      primaryError = error;
    }
    if (!result && this.fallbackEngine) {
      try {
        result = await withTimeout(
          this.fallbackEngine.transcribe({ ...request, requestId: nextRequestId('final') }),
          this.options.finalTimeoutMs,
          'fallback final',
        );
        viaFallback = true;
      } catch (error) {
        primaryError = primaryError ?? error;
      }
    }
    const base = this.base(request.source, request.segmentId);
    if (!result) {
      this.stats.finalsFailed += 1;
      this.emit({
        type: 'error',
        ...base,
        kind: 'final',
        message: primaryError instanceof Error ? primaryError.message : String(primaryError),
      });
      this.emit({ type: 'segment-dropped', ...base, startMs: segment.startMs, endMs: segment.endMs, reason: 'error' });
      return;
    }
    const text = result.text.trim();
    const latencyMs = this.now() - closedAt;
    if (viaFallback) this.stats.fallbackFinals += 1;
    if (text) {
      this.stats.finalsEmitted += 1;
      this.stats.finalLatencyMs.push(latencyMs);
    } else {
      this.stats.finalsEmpty += 1;
    }
    this.emit({
      type: 'final',
      ...base,
      text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      engine: result.engine,
      latencyMs,
      audioMs: segment.durationMs,
      viaFallback,
    });
  }
}
