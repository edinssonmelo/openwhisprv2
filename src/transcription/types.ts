export type TranscriptRefinementMode = 'off' | 'whisper-only' | 'whisper-qwen';

export type AsrLanguage = 'es' | 'en' | 'auto';

export type AsrSource = 'mic' | 'system';

/** Engine ids emitted by the main-process ASR session (mirrors `electron/asr`). */
export type AsrEngineName = 'parakeet-tdt-0.6b-v3' | 'whisper-large-v3-turbo' | (string & {});

export type AsrEngineMode = 'parakeet' | 'whisper-fallback' | 'unavailable';

interface AsrEventBase {
  sessionId: string;
  generation: number;
  source: AsrSource;
  segmentId: string;
}

/**
 * Renderer mirror of `AsrSessionEvent` (electron/asr/asrSession.ts). Kept structurally identical so the
 * preload can forward events untouched.
 */
export type AsrLiveEvent =
  | (AsrEventBase & { type: 'segment-open'; startMs: number })
  | (AsrEventBase & { type: 'preview'; text: string; startMs: number; endMs: number; engine: AsrEngineName; latencyMs: number })
  | (AsrEventBase & {
      type: 'final';
      text: string;
      startMs: number;
      endMs: number;
      engine: AsrEngineName;
      latencyMs: number;
      audioMs: number;
      viaFallback: boolean;
    })
  | (AsrEventBase & { type: 'segment-dropped'; startMs: number; endMs: number; reason: 'too-short' | 'error' | 'stale' })
  | (AsrEventBase & { type: 'error'; kind: 'preview' | 'final'; message: string })
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

export interface AsrSessionStatus {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'error';
  sessionId: string | null;
  generation: number;
  engineMode: AsrEngineMode;
  liveEngine: AsrEngineName | null;
  finalEngine: AsrEngineName | null;
  helper: {
    running: boolean;
    ready: boolean;
    modelsPresent: boolean;
    downloadFraction: number | null;
    lastError: string | null;
  };
  fallbackConfigured: boolean;
  message: string | null;
}
