import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createTranscriptCoordinator,
  type CommittedSegment,
  type TranscriptCoordinatorState,
} from '../transcription/transcriptCoordinator';
import type { AsrLanguage, AsrLiveEvent, AsrSessionStatus, AsrSource } from '../transcription/types';

/**
 * Renderer side of the live ASR pipeline.
 *
 * Responsibilities (and nothing else):
 *   - own the `TranscriptCoordinator` and expose its state to React;
 *   - start/stop the main-process ASR session (`asr:start` / `asr:stop`, the latter awaits the drain);
 *   - stream mic (or a renderer-owned system MediaStream) as mono Float32 PCM to `asr:push`.
 *
 * VAD, segmentation, engines, queueing and fallback live in the main process (`electron/asr`). System audio
 * captured by the native helpers never touches the renderer for ASR: main feeds it to the session directly.
 */

/** Samples accumulated per source before an `asr:push` (~170 ms at 48 kHz): fewer IPC messages, negligible latency. */
const PUSH_BATCH_SAMPLES = 8192;
const PROCESSOR_BUFFER_SIZE = 4096;

export interface LiveAsrStartRequest {
  sessionId: string;
  generation: number;
  language: AsrLanguage;
  sources: { mic: boolean; system: boolean };
}

export interface LiveAsrFrameInfo {
  source: AsrSource;
  rms: number;
  peak: number;
  sampleRate: number;
  atMs: number;
  firstFrame: boolean;
}

export interface UseLiveAsrOptions {
  /** Fired once per committed (non-empty) final, in display order. */
  onFinal?: (segment: CommittedSegment) => void;
  /** Fired for every accepted event (diagnostics). */
  onEvent?: (event: AsrLiveEvent, applied: boolean, reason: string) => void;
  /** Fired for each PCM frame the renderer forwards (watchdog / diagnostics). */
  onFrame?: (info: LiveAsrFrameInfo) => void;
  onLog?: (message: string) => void;
}

export interface LiveAsrHandle {
  transcript: TranscriptCoordinatorState;
  status: AsrSessionStatus | null;
  /** Latest coordinator state without waiting for a React render (safe after `await`). */
  getTranscript: () => TranscriptCoordinatorState;
  /** Clears finals/previews and binds the coordinator to a new session id. */
  beginSession: (sessionId: string, generation: number) => void;
  /** Same session, new capture generation: keeps finals, drops previews, rejects events from old generation. */
  bumpGeneration: (generation: number) => void;
  resetTranscript: () => void;
  startSession: (request: LiveAsrStartRequest) => Promise<{ ok: boolean; status: AsrSessionStatus; error?: string }>;
  /** Detaches renderer PCM pushers and awaits the main-process drain (all closed segments finalised). */
  stopSession: (reason?: string) => Promise<{
    ok: boolean;
    drained: Extract<AsrLiveEvent, { type: 'drained' }> | null;
    status: AsrSessionStatus;
  } | null>;
  /** Streams `stream` as `source` to the active session until `detachStreams()` / `stopSession()`. */
  attachStream: (audioContext: AudioContext, stream: MediaStream, source: AsrSource) => void;
  detachStreams: () => void;
  prepare: () => Promise<AsrSessionStatus | null>;
  refreshStatus: () => Promise<AsrSessionStatus | null>;
  isSessionActive: () => boolean;
}

interface Pusher {
  source: AsrSource;
  nodes: AudioNode[];
  processor: ScriptProcessorNode;
  /** Flush remaining PCM so stop() does not drop the last ~170 ms in the batch buffer. */
  flush: () => void;
}

function asrBridge() {
  return typeof window !== 'undefined' ? window.meetingAssistant?.asr ?? null : null;
}

export function useLiveAsr(options: UseLiveAsrOptions = {}): LiveAsrHandle {
  const coordinator = useMemo(() => createTranscriptCoordinator(), []);
  const [transcript, setTranscript] = useState<TranscriptCoordinatorState>(() => coordinator.getState());
  const [status, setStatus] = useState<AsrSessionStatus | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activeRef = useRef<{ sessionId: string; generation: number } | null>(null);
  const pushersRef = useRef<Pusher[]>([]);
  const publishFrameRef = useRef<number | null>(null);
  const pendingStateRef = useRef<TranscriptCoordinatorState | null>(null);

  // Coalesce coordinator notifications into one React update per animation frame.
  useEffect(() => {
    const unsubscribe = coordinator.subscribe((state) => {
      pendingStateRef.current = state;
      if (publishFrameRef.current !== null) return;
      publishFrameRef.current = window.requestAnimationFrame(() => {
        publishFrameRef.current = null;
        const next = pendingStateRef.current;
        pendingStateRef.current = null;
        if (next) setTranscript(next);
      });
    });
    return () => {
      unsubscribe();
      if (publishFrameRef.current !== null) {
        window.cancelAnimationFrame(publishFrameRef.current);
        publishFrameRef.current = null;
      }
    };
  }, [coordinator]);

  // Main-process events → coordinator; status → React.
  useEffect(() => {
    const bridge = asrBridge();
    if (!bridge) return undefined;
    const offEvent = bridge.onEvent((event) => {
      const result = coordinator.applyEvent(event);
      optionsRef.current.onEvent?.(event, result.applied, result.reason);
      if (event.type === 'final' && result.applied && result.reason === 'final-appended') {
        const finals = coordinator.getState().finals;
        const committed = finals[finals.length - 1];
        if (committed && committed.segmentId === event.segmentId) {
          optionsRef.current.onFinal?.(committed);
        }
      }
    });
    const offStatus = bridge.onStatus((next) => setStatus(next));
    void bridge.status().then(setStatus).catch(() => undefined);
    return () => {
      offEvent();
      offStatus();
    };
  }, [coordinator]);

  const detachStreams = useCallback(() => {
    const pushers = pushersRef.current;
    pushersRef.current = [];
    for (const pusher of pushers) {
      pusher.flush();
      pusher.processor.onaudioprocess = null;
      for (const node of pusher.nodes) {
        try {
          node.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    }
  }, []);

  useEffect(() => () => detachStreams(), [detachStreams]);

  const attachStream = useCallback((audioContext: AudioContext, stream: MediaStream, source: AsrSource) => {
    const bridge = asrBridge();
    if (!bridge) return;
    if (stream.getAudioTracks().length === 0) return;

    const mediaSource = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    /* Gain 0 + destination: inaudible, but keeps the ScriptProcessor pulling reliably on macOS/Electron. */
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;

    let batch = new Float32Array(PUSH_BATCH_SAMPLES);
    let batchLength = 0;
    let firstFrame = true;

    const flush = () => {
      const active = activeRef.current;
      if (!active || batchLength === 0) {
        batchLength = 0;
        return;
      }
      const pcm = batch.subarray(0, batchLength).slice();
      batchLength = 0;
      bridge.push({
        sessionId: active.sessionId,
        generation: active.generation,
        source,
        sampleRate: audioContext.sampleRate,
        pcm,
      });
    };

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      if (input.length === 0) return;

      if (optionsRef.current.onFrame) {
        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < input.length; i += 1) {
          const sample = input[i]!;
          const abs = Math.abs(sample);
          if (abs > peak) peak = abs;
          sumSq += sample * sample;
        }
        optionsRef.current.onFrame({
          source,
          rms: Math.sqrt(sumSq / input.length),
          peak,
          sampleRate: audioContext.sampleRate,
          atMs: Date.now(),
          firstFrame,
        });
      }
      firstFrame = false;

      if (!activeRef.current) return;
      let offset = 0;
      while (offset < input.length) {
        const room = batch.length - batchLength;
        const take = Math.min(room, input.length - offset);
        batch.set(input.subarray(offset, offset + take), batchLength);
        batchLength += take;
        offset += take;
        if (batchLength === batch.length) flush();
      }
    };

    mediaSource.connect(processor);
    processor.connect(silentSink);
    silentSink.connect(audioContext.destination);
    pushersRef.current.push({ source, processor, nodes: [mediaSource, processor, silentSink], flush });
    batch = new Float32Array(PUSH_BATCH_SAMPLES);
  }, []);

  const beginSession = useCallback((sessionId: string, generation: number) => {
    coordinator.beginSession(sessionId, generation);
  }, [coordinator]);

  const bumpGeneration = useCallback((generation: number) => {
    coordinator.bumpGeneration(generation);
  }, [coordinator]);

  const resetTranscript = useCallback(() => {
    coordinator.reset();
  }, [coordinator]);

  const startSession = useCallback(async (request: LiveAsrStartRequest) => {
    const bridge = asrBridge();
    if (!bridge) {
      const fallback: AsrSessionStatus = {
        state: 'error',
        sessionId: null,
        generation: request.generation,
        engineMode: 'unavailable',
        liveEngine: null,
        finalEngine: null,
        helper: { running: false, ready: false, modelsPresent: false, downloadFraction: null, lastError: null },
        fallbackConfigured: false,
        message: 'ASR bridge unavailable (not running inside Electron).',
      };
      return { ok: false, status: fallback, error: fallback.message ?? undefined };
    }
    const result = await bridge.start(request);
    setStatus(result.status);
    if (result.ok) {
      activeRef.current = { sessionId: request.sessionId, generation: request.generation };
      optionsRef.current.onLog?.(
        `asr: sesión iniciada (${result.status.engineMode}; live ${result.status.liveEngine ?? '—'}, final ${result.status.finalEngine ?? '—'})`,
      );
    } else {
      activeRef.current = null;
      optionsRef.current.onLog?.(`asr: no se pudo iniciar (${result.error ?? result.status.message ?? 'error desconocido'})`);
    }
    return result;
  }, []);

  const stopSession = useCallback(async (reason?: string) => {
    detachStreams();
    const bridge = asrBridge();
    const wasActive = activeRef.current !== null;
    activeRef.current = null;
    if (!bridge) return null;
    try {
      const result = await bridge.stop(reason);
      setStatus(result.status);
      if (wasActive && result.drained) {
        const d = result.drained;
        optionsRef.current.onLog?.(
          `asr: drenado en ${d.elapsedMs} ms (${d.finalsFlushed} finales${d.finalsFailed ? `, ${d.finalsFailed} fallidos` : ''}${d.timedOut ? ', timeout' : ''})`,
        );
      }
      return result;
    } catch (error) {
      optionsRef.current.onLog?.(`asr: error al detener (${String(error)})`);
      return null;
    }
  }, [detachStreams]);

  const prepare = useCallback(async () => {
    const bridge = asrBridge();
    if (!bridge) return null;
    try {
      const next = await bridge.prepare();
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const bridge = asrBridge();
    if (!bridge) return null;
    try {
      const next = await bridge.status();
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const getTranscript = useCallback(() => coordinator.getState(), [coordinator]);
  const isSessionActive = useCallback(() => activeRef.current !== null, []);

  return {
    transcript,
    status,
    getTranscript,
    beginSession,
    bumpGeneration,
    resetTranscript,
    startSession,
    stopSession,
    attachStream,
    detachStreams,
    prepare,
    refreshStatus,
    isSessionActive,
  };
}
