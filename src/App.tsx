import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { encodeWav } from './audio/wav';
import { createVadEndpointing, type VadClosedSegment } from './audio/vadEndpointing';
import { createTranscriptCandidateLedger, type LedgerDebugGroup, type LedgerSnapshot } from './audio/transcriptCandidateLedger';

type SourceKey = 'mic' | 'system' | 'mixed';
type CaptureMode = 'mic' | 'system' | 'both';
type CaptureStatus = 'idle' | 'requesting_permission' | 'capturing' | 'silence' | 'failed' | 'stopped';
type TranscriptViewMode = 'verbatim' | 'clean';
type WhisperPromptMode = 'empty' | 'minimal' | 'contextual';

interface MeterState {
  rms: number;
  peak: number;
  sampleRate: number | null;
  status: CaptureStatus;
  silence: boolean;
  clipping: boolean;
  error: string | null;
}

interface DesktopSource {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
}

interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  rawText?: string;
  status: 'partial' | 'final';
  source: SourceKey;
  rms: number;
  durationMs?: number;
  modelName?: string;
  stabilizationReason?: string;
  suspicious?: boolean;
  sampleRate?: number;
  sampleCount?: number;
  peak?: number;
  whisperGain?: number;
  possibleClipping?: boolean;
  asrMode?: 'preview' | 'final';
  segmentId?: string;
  whisperPromptLength?: number;
  coalesced?: boolean;
  language?: 'es' | 'auto';
}

interface WhisperSetupState {
  ok: boolean;
  missing: string[];
  cliPath: string;
  modelPath: string;
  message: string;
  activeModelName?: string | null;
  previewModelName?: string | null;
  finalModelName?: string | null;
  modelCandidates?: Array<{
    name: string;
    path: string;
    exists: boolean;
  }>;
}

interface PolisherSetupState {
  ok: boolean;
  model: string;
  message: string;
}

interface CleanSegment {
  id: string;
  startMs: number;
  endMs: number;
  rawSegmentIds: string[];
  cleanText: string;
  status: 'final';
}

interface LiveTranscriptState {
  committedText: string;
  unstableSuffix: string;
  lastReason: string;
  lastUpdatedAt: number | null;
}

/** Solo lectura natural: cola + typewriter. Hipótesis cruda en lastRawPreview no va a la vista principal. */
interface LiveVisualDraft {
  segmentId: string | null;
  visibleDraft: string;
  pendingWords: string[];
  lastRawPreview: string;
}

interface TranscriptionWindow {
  blockId: string;
  wavBytes: Uint8Array;
  startMs: number;
  endMs: number;
  rms: number;
  peak: number;
  source: SourceKey;
  sampleRate: number;
  sampleCount: number;
  coalesced?: boolean;
  possibleClipping?: boolean;
  whisperGain?: number;
  mode: 'preview' | 'final';
  segmentId: string;
  verbatimOnly: boolean;
  language: 'es' | 'auto';
  enqueuedAtMs?: number;
}

interface PendingPolishJob {
  batchId: string;
  startMs: number;
  endMs: number;
  text: string;
  source: SourceKey;
}

const initialMeter: MeterState = {
  rms: 0,
  peak: 0,
  sampleRate: null,
  status: 'idle',
  silence: false,
  clipping: false,
  error: null,
};

/** Preview es UX. Final es verdad: ledger no gobierna committedText; Gemma fuera del ASR. */
const SAFE_BASELINE = true;
/** Whisper preview rápido (descartable); final VAD sigue siendo la fuente oficial del transcript. */
const ENABLE_LIVE_PREVIEW = true;
const MAX_FINAL_SEGMENT_MS = 15_000;

const SILENCE_THRESHOLD = 0.01;
const CLIPPING_THRESHOLD = 0.98;
const WHISPER_PEAK_TARGET = 0.92;
const PREVIEW_INTERVAL_MS = 2_000;
const MAX_PREVIEW_QUEUE = 1;
/** Ventana mínima de audio por pasada de preview. */
const MIN_PREVIEW_AUDIO_MS = 2_500;
/**
 * Recorte de cola del segmento abierto para cada pasada de preview (velocidad).
 * Subir a 15_000 si la frase construida aún parece cola móvil; bajar a 8_000 si el rendimiento pesa.
 */
const MAX_PREVIEW_AUDIO_MS = 12_000;
const MIN_FINAL_AUDIO_MS = 5_000;
/** Preview ASR: mismo ggml que el final (más lento, hipótese más alineada). Usar `'fast'` para small/base. */
const PREVIEW_MODEL_POLICY: 'same-as-final' | 'fast' = 'same-as-final';
/** Palabras del final de la hipótesis que no se encolan al usuario (zona inestable). */
const PREVIEW_HIDDEN_TAIL_WORDS = 7;
/** Mínimo de palabras en prefijo común (normalizado) para tratar prefijo como estable. */
const PREVIEW_MIN_COMMON_PREFIX_WORDS = 4;
const TYPEWRITER_WORD_INTERVAL_MS = 110;
const TYPEWRITER_MAX_WORDS_PER_TICK = 1;
/** Por encima de esto, el typewriter drena 2 palabras por tick hasta ponerse al día. */
const TYPEWRITER_PENDING_CATCHUP_THRESHOLD = 14;
const TYPEWRITER_CATCHUP_WORDS_PER_TICK = 2;
/** Autoscroll al confirmar o actualizar preview solo si el usuario estaba cerca del fondo. */
const SCROLL_STICK_THRESHOLD_PX = 72;
const MIN_WHISPER_RMS = 0.018;
const NOTES_POLISH_INTERVAL_MS = 12_000;
const DEFAULT_GLOSSARY = 'Intel, TSMC, Taiwan, Apple, GPU, Anthropic, OpenAI, chips, servidores, inversión, burbuja, foundry, informática, startups, Silicon Valley, programación, productos, IA';
const SUSPICIOUS_PHRASES = [
  'nos vemos en el próximo video',
  'gracias por ver el video',
  'subtítulos realizados',
  'suscríbete',
  'dale like',
];
const DEBUG_PREFIX = '[audio-diagnostics]';

function debug(scope: string, data?: unknown) {
  if (data === undefined) {
    console.log(`${DEBUG_PREFIX} ${scope}`);
    return;
  }
  console.log(`${DEBUG_PREFIX} ${scope} ${safeJson(data)}`);
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function describeStream(stream: MediaStream) {
  return {
    id: stream.id,
    active: stream.active,
    audioTracks: stream.getAudioTracks().map(describeTrack),
    videoTracks: stream.getVideoTracks().map(describeTrack),
  };
}

function mergeVadClosedSegments(a: VadClosedSegment, b: VadClosedSegment, sampleRate: number): VadClosedSegment {
  const startSample = a.startSample;
  const out = new Float32Array(a.samples.length + b.samples.length);
  out.set(a.samples, 0);
  out.set(b.samples, a.samples.length);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) {
    const s = out[i];
    sum += s * s;
    peak = Math.max(peak, Math.abs(s));
  }
  const rms = Math.sqrt(sum / out.length);
  const endSample = startSample + out.length;
  const durationMs = (out.length / sampleRate) * 1000;
  return {
    startSample,
    endSample,
    startMs: (startSample / sampleRate) * 1000,
    endMs: (endSample / sampleRate) * 1000,
    samples: out,
    rms,
    peak,
    durationMs,
  };
}

/** Limita preview al final del segmento abierto para reducir latencia por llamada a whisper-cli. */
function trimPreviewSamplesToTail(
  samples: Float32Array,
  sampleRate: number,
  segmentEndSample: number,
  maxAudioMs: number,
): { samples: Float32Array; startMs: number; endMs: number } {
  const maxSamples = Math.max(1, Math.floor((maxAudioMs / 1000) * sampleRate));
  if (samples.length <= maxSamples) {
    const startSample = segmentEndSample - samples.length;
    return {
      samples,
      startMs: (startSample / sampleRate) * 1000,
      endMs: (segmentEndSample / sampleRate) * 1000,
    };
  }
  const tail = samples.subarray(samples.length - maxSamples);
  const startSample = segmentEndSample - tail.length;
  return {
    samples: tail,
    startMs: (startSample / sampleRate) * 1000,
    endMs: (segmentEndSample / sampleRate) * 1000,
  };
}

const INITIAL_LIVE_VISUAL_DRAFT: LiveVisualDraft = {
  segmentId: null,
  visibleDraft: '',
  pendingWords: [],
  lastRawPreview: '',
};

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function joinWords(words: string[]): string {
  return words.join(' ');
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^\p{P}+|\p{P}+$/gu, '');
}

function longestCommonPrefixLength(normA: string[], normB: string[]): number {
  let i = 0;
  while (i < normA.length && i < normB.length && normA[i] === normB[i]) {
    i += 1;
  }
  return i;
}

/** Cola oculta derivada solo para debug (no estado). */
function debugHiddenTailFromRaw(raw: string): string {
  const words = splitWords(raw);
  if (words.length === 0) return '';
  return joinWords(words.slice(-PREVIEW_HIDDEN_TAIL_WORDS));
}

/** Encola solo palabras “maduras”; no borra ni reemplaza visibleDraft. */
function mergeLiveVisualDraft(prev: LiveVisualDraft, newPreview: string, segmentId: string): LiveVisualDraft {
  const wordsNew = splitWords(newPreview);

  if (segmentId !== prev.segmentId) {
    const stableWords = wordsNew.slice(0, Math.max(0, wordsNew.length - PREVIEW_HIDDEN_TAIL_WORDS));
    return {
      segmentId,
      lastRawPreview: newPreview,
      visibleDraft: '',
      pendingWords: stableWords,
    };
  }

  const normNew = wordsNew.map(normalizeWord);
  const normOld = splitWords(prev.lastRawPreview).map(normalizeWord);
  const L = longestCommonPrefixLength(normOld, normNew);

  if (L < PREVIEW_MIN_COMMON_PREFIX_WORDS) {
    return {
      ...prev,
      lastRawPreview: newPreview,
    };
  }

  const stableCount = Math.max(0, L - PREVIEW_HIDDEN_TAIL_WORDS);
  const stableWords = wordsNew.slice(0, stableCount);
  const already = [...splitWords(prev.visibleDraft), ...prev.pendingWords];
  let k = 0;
  while (
    k < already.length &&
    k < stableWords.length &&
    normalizeWord(already[k]) === normalizeWord(stableWords[k])
  ) {
    k += 1;
  }
  const newWords = stableWords.slice(k);

  return {
    ...prev,
    lastRawPreview: newPreview,
    pendingWords: [...prev.pendingWords, ...newWords],
  };
}

function describeTrack(track: MediaStreamTrack) {
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings: track.getSettings(),
    constraints: track.getConstraints(),
  };
}

export default function App() {
  const [platform, setPlatform] = useState<NodeJS.Platform | 'unknown'>('unknown');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [desktopSources, setDesktopSources] = useState<DesktopSource[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [selectedSystemInputId, setSelectedSystemInputId] = useState<string>('');
  const [selectedOutputId, setSelectedOutputId] = useState<string>('');
  const [selectedDesktopSourceId, setSelectedDesktopSourceId] = useState<string>('');
  const [micPermission, setMicPermission] = useState<PermissionState | 'unknown'>('unknown');
  const [systemPermission, setSystemPermission] = useState<PermissionState | 'unknown'>('unknown');
  const [nativeMediaAccess, setNativeMediaAccess] = useState<{ microphone: string; screen: string } | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMode | null>(null);
  const [meters, setMeters] = useState<Record<SourceKey, MeterState>>({
    mic: initialMeter,
    system: initialMeter,
    mixed: initialMeter,
  });
  const [diagnosticLog, setDiagnosticLog] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingSecondsLeft, setRecordingSecondsLeft] = useState(30);
  const [savedWav, setSavedWav] = useState<{ path: string; fileUrl: string } | null>(null);
  const [rawSegments, setRawSegments] = useState<TranscriptSegment[]>([]);
  const [cleanSegments, setCleanSegments] = useState<CleanSegment[]>([]);
  const [ledgerDebugGroups, setLedgerDebugGroups] = useState<LedgerDebugGroup[]>([]);
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscriptState>({
    committedText: '',
    unstableSuffix: '',
    lastReason: 'waiting',
    lastUpdatedAt: null,
  });
  const [liveVisualDraft, setLiveVisualDraft] = useState<LiveVisualDraft>(INITIAL_LIVE_VISUAL_DRAFT);
  const [whisperSetup, setWhisperSetup] = useState<WhisperSetupState | null>(null);
  const [polisherSetup, setPolisherSetup] = useState<PolisherSetupState | null>(null);
  const [glossary, setGlossary] = useState(DEFAULT_GLOSSARY);
  const [showRawDebug, setShowRawDebug] = useState(false);
  const [transcriptViewMode, setTranscriptViewMode] = useState<TranscriptViewMode>('verbatim');
  const [promptMode, setPromptMode] = useState<WhisperPromptMode>('empty');
  const [whisperLanguage, setWhisperLanguage] = useState<'es' | 'auto'>('es');
  const [allowWhisperContext, setAllowWhisperContext] = useState(false);

  const allowWhisperContextRef = useRef(allowWhisperContext);
  const whisperLanguageRef = useRef(whisperLanguage);
  allowWhisperContextRef.current = allowWhisperContext;
  whisperLanguageRef.current = whisperLanguage;

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamsRef = useRef<Partial<Record<SourceKey, MediaStream>>>({});
  const analysersRef = useRef<Partial<Record<SourceKey, AnalyserNode>>>({});
  const graphNodesRef = useRef<AudioNode[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<Partial<Record<SourceKey, number>>>({});
  const recordingChunksRef = useRef<Float32Array[]>([]);
  const recordingProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const transcriptionProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptionSampleCursorRef = useRef<number>(0);
  const transcriptionBusyRef = useRef<boolean>(false);
  const pendingTranscriptionWindowsRef = useRef<TranscriptionWindow[]>([]);
  const vadRef = useRef(createVadEndpointing(
    SAFE_BASELINE ? { maxSegmentMs: MAX_FINAL_SEGMENT_MS } : {},
  ));
  const candidateLedgerRef = useRef(createTranscriptCandidateLedger());
  const ledgerFlushTimerRef = useRef<number | null>(null);
  const vadShortAccumRef = useRef<VadClosedSegment | null>(null);
  const activeSegmentIdRef = useRef<string | null>(null);
  const lastPreviewPerfMsRef = useRef<number>(0);
  const liveTranscriptionSourceRef = useRef<SourceKey>('mixed');
  const lastNotesPolishAtRef = useRef<number>(0);
  const lastNotesTextLengthRef = useRef<number>(0);
  const polisherBusyRef = useRef<boolean>(false);
  const pendingPolishJobRef = useRef<PendingPolishJob | null>(null);
  const cleanContextRef = useRef<string>('');
  const lastClippingWarningAtRef = useRef<number>(0);
  /** Solo `preview` | `final` mientras transcribeBlock está en vuelo (para cancelar solo previews). */
  const transcriptionInFlightModeRef = useRef<'preview' | 'final' | null>(null);
  const previewDroppedCountRef = useRef(0);
  const previewReplacedCountRef = useRef(0);
  const finalAcceptedCountRef = useRef(0);
  const previewSegmentOpenedAtRef = useRef<Map<string, number>>(new Map());
  const previewFirstSuccessRef = useRef<Set<string>>(new Set());
  const liveTranscriptScrollRef = useRef<HTMLDivElement>(null);
  const stickNearBottomRef = useRef(true);

  const [asrLiveStats, setAsrLiveStats] = useState({
    previewLatencyMs: null as number | null,
    finalLatencyMs: null as number | null,
    previewQueueSize: 0,
    finalQueueSize: 0,
    previewDroppedCount: 0,
    previewReplacedCount: 0,
    finalAcceptedCount: 0,
    lastPreviewSegmentDurationMs: null as number | null,
    timeToFirstPreviewMs: null as number | null,
    lastCancelReason: null as string | null,
  });

  const syncAsrLiveStats = useCallback((patch: Partial<typeof asrLiveStats>) => {
    setAsrLiveStats((prev) => {
      const p = pendingTranscriptionWindowsRef.current;
      return {
        ...prev,
        ...patch,
        previewQueueSize: p.filter((w) => w.mode === 'preview').length,
        finalQueueSize: p.filter((w) => w.mode === 'final').length,
        previewDroppedCount: previewDroppedCountRef.current,
        previewReplacedCount: previewReplacedCountRef.current,
        finalAcceptedCount: finalAcceptedCountRef.current,
      };
    });
  }, []);

  const macSystemFallbackText =
    'Para capturar audio del sistema en este Mac cuando Electron loopback falla, instala BlackHole, enruta la salida del sistema hacia BlackHole y selecciona BlackHole como entrada virtual.';

  const virtualSystemInputs = useMemo(() => {
    const virtualNames = ['blackhole', 'loopback', 'soundflower', 'vb-cable', 'stereo mix', 'what u hear'];
    return inputDevices.filter((device) => virtualNames.some((name) => device.label.toLowerCase().includes(name)));
  }, [inputDevices]);

  const liveCleanText = useMemo(() => cleanSegments.map((segment) => segment.cleanText).join(' ').trim(), [cleanSegments]);

  const addLog = useCallback((message: string) => {
    debug('ui-log', message);
    setDiagnosticLog((current) => [`${new Date().toLocaleTimeString()} - ${message}`, ...current].slice(0, 50));
  }, []);

  const patchMeter = useCallback((source: SourceKey, patch: Partial<MeterState>) => {
    setMeters((current) => ({
      ...current,
      [source]: {
        ...current[source],
        ...patch,
      },
    }));
  }, []);

  const onLiveTranscriptScroll = useCallback(() => {
    const el = liveTranscriptScrollRef.current;
    if (!el) return;
    stickNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_STICK_THRESHOLD_PX;
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const mediaDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = mediaDevices.filter((device) => device.kind === 'audioinput');
      const audioOutputs = mediaDevices.filter((device) => device.kind === 'audiooutput');
      debug('devices:audioinput', audioInputs.map((device) => ({
        deviceId: device.deviceId,
        groupId: device.groupId,
        label: device.label,
      })));
      debug('devices:audiooutput', audioOutputs.map((device) => ({
        deviceId: device.deviceId,
        groupId: device.groupId,
        label: device.label,
      })));
      setInputDevices(audioInputs);
      setOutputDevices(audioOutputs);
      setSelectedMicId((current) => current || audioInputs[0]?.deviceId || '');
      setSelectedOutputId((current) => current || audioOutputs[0]?.deviceId || '');
      setSelectedSystemInputId((current) => current || audioInputs.find((device) => {
        const label = device.label.toLowerCase();
        return label.includes('blackhole') || label.includes('loopback') || label.includes('vb-cable') || label.includes('stereo mix');
      })?.deviceId || '');
    } catch (error) {
      addLog(`device: no se pudieron listar micrófonos (${String(error)})`);
    }
  }, [addLog]);

  const refreshDesktopSources = useCallback(async () => {
    try {
      const { sources, error } = await window.meetingAssistant.audio.getDesktopSources();
      debug('desktop-sources', { sources, error });
      setDesktopSources(sources);
      setSelectedDesktopSourceId((current) => current || sources[0]?.id || '');
      if (error) addLog(error);
    } catch (error) {
      addLog(`system: no se pudieron listar fuentes de pantalla (${String(error)})`);
    }
  }, [addLog]);

  const refreshPermissions = useCallback(async () => {
    try {
      const microphone = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      setMicPermission(microphone?.state ?? 'unknown');
    } catch {
      setMicPermission('unknown');
    }

    try {
      const display = await navigator.permissions?.query({ name: 'display-capture' as PermissionName });
      setSystemPermission(display?.state ?? 'unknown');
    } catch {
      setSystemPermission('unknown');
    }
  }, []);

  useEffect(() => {
    void window.meetingAssistant.platform.getInfo().then((info) => {
      debug('platform-info', info);
      setPlatform(info.platform);
      setNativeMediaAccess(info.mediaAccess);
    }).catch((error) => {
      debug('platform-info:error', String(error));
      setPlatform('unknown');
    });
    void refreshDevices();
    void refreshDesktopSources();
    void refreshPermissions();
    void window.meetingAssistant.transcription.checkSetup().then((setup) => {
      setWhisperSetup(setup);
      debug('transcription:setup', setup);
      if (!setup.ok) addLog(setup.message);
    });
    void window.meetingAssistant.polisher.check().then((setup) => {
      setPolisherSetup(setup);
      debug('polisher:setup', setup);
      if (!setup.ok) addLog(setup.message);
    });

    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [addLog, refreshDesktopSources, refreshDevices, refreshPermissions]);

  useLayoutEffect(() => {
    if (!SAFE_BASELINE) return;
    const el = liveTranscriptScrollRef.current;
    if (!el || !stickNearBottomRef.current) return;
    requestAnimationFrame(() => {
      const box = liveTranscriptScrollRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    });
  }, [liveTranscript.committedText, liveVisualDraft.visibleDraft, liveVisualDraft.pendingWords.length, liveVisualDraft.segmentId]);

  useEffect(() => {
    if (!SAFE_BASELINE || !ENABLE_LIVE_PREVIEW) return;
    if (liveVisualDraft.pendingWords.length === 0) return;
    const id = window.setInterval(() => {
      setLiveVisualDraft((p) => {
        if (p.pendingWords.length === 0) return p;
        const n =
          p.pendingWords.length > TYPEWRITER_PENDING_CATCHUP_THRESHOLD
            ? TYPEWRITER_CATCHUP_WORDS_PER_TICK
            : TYPEWRITER_MAX_WORDS_PER_TICK;
        const take = p.pendingWords.slice(0, n);
        const rest = p.pendingWords.slice(n);
        const draftTrim = p.visibleDraft.trim();
        const newDraft = draftTrim ? `${draftTrim} ${take.join(' ')}` : take.join(' ');
        return { ...p, visibleDraft: newDraft, pendingWords: rest };
      });
    }, TYPEWRITER_WORD_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [liveVisualDraft.pendingWords.length, SAFE_BASELINE, ENABLE_LIVE_PREVIEW]);

  useEffect(() => () => {
    if (ledgerFlushTimerRef.current !== null) {
      window.clearTimeout(ledgerFlushTimerRef.current);
    }
  }, []);

  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const connectAnalyser = useCallback(
    (stream: MediaStream, source: SourceKey) => {
      const audioContext = ensureAudioContext();
      debug(`stream:${source}:connect-analyser`, describeStream(stream));
      stream.getTracks().forEach((track) => {
        track.addEventListener('mute', () => {
          debug(`track:${source}:mute`, describeTrack(track));
          addLog(`${source}: track ${track.kind} muted (${track.label || track.id})`);
        });
        track.addEventListener('unmute', () => {
          debug(`track:${source}:unmute`, describeTrack(track));
          addLog(`${source}: track ${track.kind} unmuted (${track.label || track.id})`);
        });
        track.addEventListener('ended', () => {
          debug(`track:${source}:ended`, describeTrack(track));
          addLog(`${source}: track ${track.kind} ended (${track.label || track.id})`);
        });
      });
      const mediaSource = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      mediaSource.connect(analyser);
      graphNodesRef.current.push(mediaSource, analyser);
      analysersRef.current[source] = analyser;
      patchMeter(source, {
        status: 'capturing',
        sampleRate: audioContext.sampleRate,
        error: null,
      });
    },
    [addLog, ensureAudioContext, patchMeter],
  );

  const startMeterLoop = useCallback(() => {
    if (animationFrameRef.current) return;
    let lastMeterDebugAt = 0;
    const tick = () => {
      const now = performance.now();
      const meterSnapshot: Partial<Record<SourceKey, { rms: number; peak: number; silence: boolean; clipping: boolean }>> = {};
      (['mic', 'system', 'mixed'] as SourceKey[]).forEach((source) => {
        const analyser = analysersRef.current[source];
        if (!analyser) return;
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);

        let sum = 0;
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const absolute = Math.abs(data[i]);
          sum += data[i] * data[i];
          peak = Math.max(peak, absolute);
        }

        const rms = Math.sqrt(sum / data.length);
        const clipping = peak >= CLIPPING_THRESHOLD;
        const previousSilenceStart = silenceStartRef.current[source];
        if (rms < SILENCE_THRESHOLD) {
          silenceStartRef.current[source] = previousSilenceStart ?? now;
        } else {
          silenceStartRef.current[source] = undefined;
        }
        const silence = Boolean(silenceStartRef.current[source] && now - silenceStartRef.current[source]! > 1200);
        meterSnapshot[source] = {
          rms: Number(rms.toFixed(5)),
          peak: Number(peak.toFixed(5)),
          silence,
          clipping,
        };

        patchMeter(source, {
          rms,
          peak,
          silence,
          clipping,
          status: silence ? 'silence' : 'capturing',
          error: silence ? 'rms-zero: stream activo, pero RMS bajo/silencioso' : null,
        });
      });
      if (now - lastMeterDebugAt > 2000) {
        lastMeterDebugAt = now;
        debug('meters', meterSnapshot);
      }
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
  }, [patchMeter]);

  const stopMeterLoop = useCallback(() => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const stopCapture = useCallback(async () => {
    stopMeterLoop();

    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    recordingProcessorRef.current?.disconnect();
    recordingProcessorRef.current = null;
    transcriptionProcessorRef.current?.disconnect();
    transcriptionProcessorRef.current = null;
    transcriptionSampleCursorRef.current = 0;
    transcriptionBusyRef.current = false;
    transcriptionInFlightModeRef.current = null;
    pendingTranscriptionWindowsRef.current = [];
    vadRef.current.reset();
    vadShortAccumRef.current = null;
    activeSegmentIdRef.current = null;
    lastPreviewPerfMsRef.current = 0;
    previewSegmentOpenedAtRef.current.clear();
    previewFirstSuccessRef.current.clear();
    setLiveVisualDraft(INITIAL_LIVE_VISUAL_DRAFT);
    pendingPolishJobRef.current = null;
    void window.meetingAssistant.transcription.cancelPending().catch((error) => {
      debug('transcription:cancel:error', String(error));
    });
    setRecording(false);

    graphNodesRef.current.forEach((node) => node.disconnect());
    graphNodesRef.current = [];
    Object.values(streamsRef.current).forEach((stream) => {
      stream?.getTracks().forEach((track) => track.stop());
    });
    streamsRef.current = {};
    analysersRef.current = {};
    silenceStartRef.current = {};

    await audioContextRef.current?.close();
    audioContextRef.current = null;

    setCaptureMode(null);
    setMeters({
      mic: { ...initialMeter, status: 'stopped' },
      system: { ...initialMeter, status: 'stopped' },
      mixed: { ...initialMeter, status: 'stopped' },
    });
    addLog('captura detenida');
  }, [addLog, stopMeterLoop]);

  const captureMic = useCallback(async () => {
    patchMeter('mic', { status: 'requesting_permission', error: null });
    try {
      const constraints = {
        audio: {
          deviceId: selectedMicId ? { exact: selectedMicId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
        video: false,
      } satisfies MediaStreamConstraints;
      debug('capture:mic:constraints', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      debug('capture:mic:stream', describeStream(stream));
      if (stream.getAudioTracks().length === 0) {
        throw new Error('empty-stream: no audio tracks returned for microphone');
      }
      streamsRef.current.mic = stream;
      connectAnalyser(stream, 'mic');
      await refreshDevices();
      await refreshPermissions();
      addLog('mic: captura iniciada');
      return stream;
    } catch (error) {
      const message = `permission/device: no se pudo capturar micrófono (${String(error)})`;
      patchMeter('mic', { status: 'failed', error: message });
      addLog(message);
      throw error;
    }
  }, [addLog, connectAnalyser, patchMeter, refreshDevices, refreshPermissions, selectedMicId]);

  const captureSystem = useCallback(async () => {
    patchMeter('system', { status: 'requesting_permission', error: null });

    try {
      // Only request systemAudio; avoid false/AGC flags here — on macOS Electron loopback,
      // extra processing constraints have caused silent meters / early track end when combined
      // with Web Audio routing (see audioContext.resume + pull-only destination below).
      const displayConstraints = {
        audio: {
          systemAudio: 'include',
        },
        video: true,
      } as DisplayMediaStreamOptions;
      debug('capture:system:getDisplayMedia:constraints', displayConstraints);
      const displayStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
      debug('capture:system:getDisplayMedia:stream', describeStream(displayStream));
      if (displayStream.getAudioTracks().length === 0) {
        throw new Error('empty-stream: display capture returned no audio track');
      }
      streamsRef.current.system = displayStream;
      connectAnalyser(displayStream, 'system');
      await refreshPermissions();
      addLog('system: captura display/system iniciada');
      return displayStream;
    } catch (firstError) {
      debug('capture:system:getDisplayMedia:error', String(firstError));
      try {
        const legacyConstraints = {
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedDesktopSourceId || undefined,
            },
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedDesktopSourceId || undefined,
              maxWidth: 1,
              maxHeight: 1,
            },
          },
        } as MediaStreamConstraints;
        debug('capture:system:legacy:constraints', legacyConstraints);
        const legacyStream = await (navigator.mediaDevices as MediaDevices).getUserMedia(legacyConstraints);
        debug('capture:system:legacy:stream', describeStream(legacyStream));
        if (legacyStream.getAudioTracks().length === 0) {
          throw new Error('empty-stream: legacy desktop capture returned no audio track');
        }
        streamsRef.current.system = legacyStream;
        connectAnalyser(legacyStream, 'system');
        addLog('system: captura legacy chromeMediaSource iniciada');
        return legacyStream;
      } catch (secondError) {
        debug('capture:system:legacy:error', String(secondError));
        const fallbackDeviceId = selectedSystemInputId || virtualSystemInputs[0]?.deviceId || '';
        debug('capture:system:virtual:candidate', {
          selectedSystemInputId,
          virtualSystemInputs: virtualSystemInputs.map((device) => ({
            deviceId: device.deviceId,
            groupId: device.groupId,
            label: device.label,
          })),
          fallbackDeviceId,
        });
        if (fallbackDeviceId) {
          try {
            const virtualConstraints = {
              audio: {
                deviceId: { exact: fallbackDeviceId },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
              video: false,
            } satisfies MediaStreamConstraints;
            debug('capture:system:virtual:constraints', virtualConstraints);
            const fallbackStream = await navigator.mediaDevices.getUserMedia(virtualConstraints);
            debug('capture:system:virtual:stream', describeStream(fallbackStream));
            if (fallbackStream.getAudioTracks().length === 0) {
              throw new Error('empty-stream: virtual system input returned no audio track');
            }
            streamsRef.current.system = fallbackStream;
            connectAnalyser(fallbackStream, 'system');
            addLog('system: captura iniciada desde entrada virtual seleccionada');
            return fallbackStream;
          } catch (thirdError) {
            debug('capture:system:virtual:error', String(thirdError));
            const fallback = platform === 'darwin' ? ` ${macSystemFallbackText}` : '';
            const message = `system: falló captura de audio del sistema (${String(firstError)} / ${String(secondError)} / ${String(thirdError)}).${fallback}`;
            patchMeter('system', { status: 'failed', error: message });
            addLog(message);
            throw thirdError;
          }
        }

        const fallback = platform === 'darwin' ? ` ${macSystemFallbackText}` : '';
        const virtualHint = platform === 'darwin' && virtualSystemInputs.length === 0
          ? ' No se detectó BlackHole/Loopback/VB-CABLE como entrada.'
          : '';
        const message = `system: falló captura de audio del sistema (${String(firstError)} / ${String(secondError)}).${virtualHint}${fallback}`;
        patchMeter('system', { status: 'failed', error: message });
        addLog(message);
        throw secondError;
      }
    }
  }, [
    addLog,
    connectAnalyser,
    macSystemFallbackText,
    patchMeter,
    platform,
    refreshPermissions,
    selectedDesktopSourceId,
    selectedSystemInputId,
    virtualSystemInputs,
  ]);

  const buildMixedStream = useCallback((sources: MediaStream[]) => {
    const audioContext = ensureAudioContext();
    const destination = audioContext.createMediaStreamDestination();
    sources.forEach((stream) => {
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      gain.gain.value = SAFE_BASELINE
        ? (sources.length > 1 ? 0.35 : 0.7)
        : Math.max(0.45, 1 / Math.max(1, sources.length));
      source.connect(gain);
      gain.connect(destination);
      graphNodesRef.current.push(source, gain);
    });
    streamsRef.current.mixed = destination.stream;
    connectAnalyser(destination.stream, 'mixed');
    return destination.stream;
  }, [connectAnalyser, ensureAudioContext]);

  const runPolishJob = useCallback((job: PendingPolishJob) => {
    polisherBusyRef.current = true;
    const startedAt = Date.now();

    window.meetingAssistant.polisher.polishSegment({
      batchId: job.batchId,
      rawSegments: [{
        id: job.batchId,
        startMs: job.startMs,
        endMs: job.endMs,
        text: job.text,
        source: job.source,
        rms: 0.1,
      }],
      context: cleanContextRef.current.slice(-900),
      glossary,
    }).then((result) => {
      debug('polisher:notes-result', {
        ...result,
        polishLatency: Date.now() - startedAt,
        chars: job.text.length,
        pending: Boolean(pendingPolishJobRef.current),
      });
      if (!result.ok) {
        addLog(`notas Gemma: ${result.error ?? 'error desconocido'}`);
        return;
      }
      const text = (result.text ?? '').trim();
      if (!text) return;
      cleanContextRef.current = `${cleanContextRef.current} ${text}`.trim();
      setCleanSegments((current) => [...current, {
        id: job.batchId,
        startMs: job.startMs,
        endMs: job.endMs,
        rawSegmentIds: [job.batchId],
        cleanText: text,
        status: 'final' as const,
      }].slice(-20));
    }).catch((error) => {
      debug('polisher:notes-error', String(error));
      addLog(`notas Gemma: ${String(error)}`);
    }).finally(() => {
      polisherBusyRef.current = false;
      const pending = pendingPolishJobRef.current;
      pendingPolishJobRef.current = null;
      if (pending) runPolishJob(pending);
    });
  }, [addLog, glossary]);

  const maybePolishNotes = useCallback((committedText: string, source: SourceKey, endMs: number) => {
    if (SAFE_BASELINE) return;
    if (!polisherSetup?.ok) return;
    const now = Date.now();
    const newChars = committedText.length - lastNotesTextLengthRef.current;
    if (now - lastNotesPolishAtRef.current < NOTES_POLISH_INTERVAL_MS && newChars < 180) return;
    if (committedText.trim().length < 80) return;

    const newConfirmedText = committedText.slice(Math.max(0, lastNotesTextLengthRef.current)).trim();
    const textToPolish = newConfirmedText.length >= 80
      ? newConfirmedText
      : committedText.slice(Math.max(0, committedText.length - 1600));
    const batchId = `note-${now}-${endMs}`;
    const job: PendingPolishJob = {
      batchId,
      startMs: Math.max(0, endMs - 40_000),
      endMs,
      text: textToPolish,
      source,
    };

    lastNotesPolishAtRef.current = now;
    lastNotesTextLengthRef.current = committedText.length;

    if (polisherBusyRef.current) {
      pendingPolishJobRef.current = job;
      debug('polisher:notes-queued-latest', {
        batchId,
        chars: textToPolish.length,
        action: 'replace-pending-polish',
      });
      return;
    }

    runPolishJob(job);
  }, [polisherSetup, runPolishJob]);

  const warnPossibleClipping = useCallback((source: SourceKey, peak: number) => {
    if (peak < CLIPPING_THRESHOLD) return;
    const now = Date.now();
    if (now - lastClippingWarningAtRef.current < 12_000) return;
    lastClippingWarningAtRef.current = now;
    addLog(`${source}: audio está clipeando (peak ${peak.toFixed(3)}); baja el volumen de la fuente para mejorar Whisper`);
  }, [addLog]);

  const scheduleLedgerFlush = useCallback((delayMs: number | null) => {
    if (ledgerFlushTimerRef.current !== null) {
      window.clearTimeout(ledgerFlushTimerRef.current);
      ledgerFlushTimerRef.current = null;
    }
    if (delayMs === null) return;
    ledgerFlushTimerRef.current = window.setTimeout(() => {
      ledgerFlushTimerRef.current = null;
      const snapshot = candidateLedgerRef.current.flush();
      setLedgerDebugGroups(snapshot.debugGroups);
      const source = liveTranscriptionSourceRef.current;
      setLiveTranscript((prev) => {
        if (snapshot.committedText && snapshot.committedText.length > prev.committedText.length) {
          queueMicrotask(() => maybePolishNotes(snapshot.committedText, source, snapshot.committedThroughMs));
        }
        return {
          committedText: snapshot.committedText,
          unstableSuffix: snapshot.unstableText,
          lastReason: snapshot.lastReason,
          lastUpdatedAt: Date.now(),
        };
      });
      scheduleLedgerFlush(snapshot.nextFlushDelayMs);
    }, Math.max(50, delayMs));
  }, [maybePolishNotes]);

  const applyLedgerSnapshot = useCallback((snapshot: LedgerSnapshot, source: SourceKey) => {
    setLedgerDebugGroups(snapshot.debugGroups);
    setLiveTranscript((prev) => {
      if (snapshot.committedText && snapshot.committedText.length > prev.committedText.length) {
        queueMicrotask(() => maybePolishNotes(snapshot.committedText, source, snapshot.committedThroughMs));
      }
      return {
        committedText: snapshot.committedText,
        unstableSuffix: snapshot.unstableText,
        lastReason: snapshot.lastReason,
        lastUpdatedAt: Date.now(),
      };
    });
    scheduleLedgerFlush(snapshot.nextFlushDelayMs);
  }, [maybePolishNotes, scheduleLedgerFlush]);

  const handlePreviewSegment = useCallback((segment: TranscriptSegment, segmentId: string) => {
    if (SAFE_BASELINE) {
      if (!ENABLE_LIVE_PREVIEW) return;
      if (!shouldUseForLive(segment)) {
        debug('transcription:preview-filtered', { segmentId, blockId: segment.id });
        return;
      }
      const previewText = segment.text.trim();
      if (!previewText) return;
      setLiveTranscript((prev) => ({
        ...prev,
        unstableSuffix: '',
        lastReason: 'preview-only',
        lastUpdatedAt: Date.now(),
      }));
      setLiveVisualDraft((prev) => mergeLiveVisualDraft(prev, previewText, segmentId));
      if (showRawDebug) {
        setRawSegments((current) => [...current, { ...segment, asrMode: 'preview' as const, segmentId }].slice(-120));
      }
      return;
    }

    if (!shouldUseForLive(segment)) {
      setRawSegments((current) => [...current, { ...segment, stabilizationReason: 'filtered' }].slice(-120));
      return;
    }
    setRawSegments((current) => [...current, { ...segment, asrMode: 'preview' as const, segmentId }].slice(-120));
    const snapshot = candidateLedgerRef.current.addCandidate({
      id: segment.id,
      segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      mode: 'preview',
      source: segment.source,
      rms: segment.rms,
      peak: segment.peak,
      modelName: segment.modelName,
      durationMs: segment.durationMs,
      suspicious: segment.suspicious,
      language: segment.language,
    });
    applyLedgerSnapshot(snapshot, segment.source);
  }, [applyLedgerSnapshot, showRawDebug]);

  const handleFinalSegment = useCallback((segment: TranscriptSegment, segmentId: string) => {
    const finalText = segment.text.trim();
    if (!finalText) return;

    if (SAFE_BASELINE) {
      const pk = segment.peak ?? 0;
      if (pk >= CLIPPING_THRESHOLD) {
        addLog(`${segment.source}: segmento final descartado por clipping; baja volumen de la fuente (peak ${pk.toFixed(3)})`);
        debug('transcription:final-audit', {
          startMs: segment.startMs,
          endMs: segment.endMs,
          durationMs: segment.durationMs,
          rms: segment.rms,
          peak: pk,
          whisperGain: segment.whisperGain,
          promptLength: segment.whisperPromptLength ?? 0,
          language: segment.language ?? 'es',
          acceptedFinal: false,
          rejectReason: 'clipping',
        });
        return;
      }
      setRawSegments((current) => [...current, {
        ...segment,
        status: 'final' as const,
        asrMode: 'final' as const,
        segmentId,
        stabilizationReason: 'vad-final-direct',
      }].slice(-120));
      setLiveTranscript((prev) => ({
        committedText: `${prev.committedText} ${finalText}`.trim(),
        unstableSuffix: '',
        lastReason: 'vad-final-direct',
        lastUpdatedAt: Date.now(),
      }));
      setLiveVisualDraft(INITIAL_LIVE_VISUAL_DRAFT);
      finalAcceptedCountRef.current += 1;
      syncAsrLiveStats({});
      const snapshot = candidateLedgerRef.current.addCandidate({
        id: segment.id,
        segmentId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        mode: 'final',
        source: segment.source,
        rms: segment.rms,
        peak: segment.peak,
        modelName: segment.modelName,
        durationMs: segment.durationMs,
        suspicious: segment.suspicious,
        language: segment.language,
      });
      setLedgerDebugGroups(snapshot.debugGroups);
      debug('transcription:final-audit', {
        startMs: segment.startMs,
        endMs: segment.endMs,
        durationMs: segment.durationMs,
        rms: segment.rms,
        peak: pk,
        whisperGain: segment.whisperGain,
        promptLength: segment.whisperPromptLength ?? 0,
        language: segment.language ?? 'es',
        acceptedFinal: true,
        rejectReason: null,
      });
      return;
    }

    setRawSegments((current) => [...current, {
      ...segment,
      status: 'final' as const,
      asrMode: 'final' as const,
      segmentId,
      stabilizationReason: 'vad-endpoint',
    }].slice(-120));
    const snapshot = candidateLedgerRef.current.addCandidate({
      id: segment.id,
      segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      mode: 'final',
      source: segment.source,
      rms: segment.rms,
      peak: segment.peak,
      modelName: segment.modelName,
      durationMs: segment.durationMs,
      suspicious: segment.suspicious,
      language: segment.language,
    });
    applyLedgerSnapshot(snapshot, segment.source);
  }, [addLog, applyLedgerSnapshot, syncAsrLiveStats]);

  const processNextTranscriptionWindow = useCallback(() => {
    if (transcriptionBusyRef.current) return;
    const request = pendingTranscriptionWindowsRef.current.shift();
    if (!request) return;

    transcriptionBusyRef.current = true;
    transcriptionInFlightModeRef.current = request.mode;

    const effectiveGlossary = SAFE_BASELINE ? undefined : (request.verbatimOnly ? undefined : glossary);
    const effectivePromptMode = SAFE_BASELINE ? 'empty' : (request.verbatimOnly ? 'empty' : promptMode);
    const effectiveVerbatimOnly = SAFE_BASELINE ? true : request.verbatimOnly;
    const effectiveLanguage = SAFE_BASELINE ? 'es' : request.language;

    debug('transcription:window-send', {
      blockId: request.blockId,
      mode: request.mode,
      segmentId: request.segmentId,
      source: request.source,
      startMs: request.startMs,
      endMs: request.endMs,
      rms: request.rms,
      peak: request.peak,
      verbatimOnly: effectiveVerbatimOnly,
      language: effectiveLanguage,
      promptMode: effectivePromptMode,
      glossaryChars: effectiveGlossary?.length ?? 0,
      safeBaseline: SAFE_BASELINE,
      sampleRate: request.sampleRate,
      sampleCount: request.sampleCount,
      bytes: request.wavBytes.byteLength,
      asrQueue: pendingTranscriptionWindowsRef.current.length,
      coalesced: request.coalesced ?? false,
      possibleClipping: request.possibleClipping ?? false,
      whisperGain: request.whisperGain,
    });

    window.meetingAssistant.transcription.transcribeBlock({
      blockId: request.blockId,
      wavBytes: request.wavBytes,
      startMs: request.startMs,
      endMs: request.endMs,
      rms: request.rms,
      peak: request.peak,
      source: request.source,
      glossary: effectiveGlossary,
      promptMode: effectivePromptMode,
      sampleRate: request.sampleRate,
      sampleCount: request.sampleCount,
      whisperGain: request.whisperGain,
      mode: request.mode,
      modelRole: request.mode === 'preview' ? 'preview' as const : 'final' as const,
      previewModelPolicy: SAFE_BASELINE && request.mode === 'preview' ? PREVIEW_MODEL_POLICY : undefined,
      language: effectiveLanguage,
      verbatimOnly: effectiveVerbatimOnly,
    }).then((result) => {
      debug('transcription:whisper-invocation', result.whisperDebug ?? {
        language: effectiveLanguage,
        promptLength: 0,
        verbatimOnly: effectiveVerbatimOnly,
        translateEnabled: false,
        argsSanitized: [],
      });
      debug('transcription:window-result', {
        ...result,
        mode: request.mode,
        asrQueue: pendingTranscriptionWindowsRef.current.length,
      });
      if (!result.ok) {
        addLog(`transcription error: ${result.error ?? 'error desconocido'}`);
        if (SAFE_BASELINE && request.mode === 'final') {
          debug('transcription:final-audit', {
            startMs: request.startMs,
            endMs: request.endMs,
            durationMs: request.endMs - request.startMs,
            rms: request.rms,
            peak: request.peak,
            whisperGain: request.whisperGain,
            promptLength: 0,
            language: effectiveLanguage,
            acceptedFinal: false,
            rejectReason: `whisper-error: ${result.error ?? 'unknown'}`,
          });
        }
        return;
      }

      const text = (result.text ?? '').trim();
      if (!text) {
        if (request.mode === 'final') {
          addLog(`transcription: segmento final sin texto (${result.durationMs}ms)`);
          if (SAFE_BASELINE) {
            debug('transcription:final-audit', {
              startMs: request.startMs,
              endMs: request.endMs,
              durationMs: result.durationMs,
              rms: request.rms,
              peak: request.peak,
              whisperGain: request.whisperGain,
              promptLength: result.whisperPromptLength ?? 0,
              language: effectiveLanguage,
              acceptedFinal: false,
              rejectReason: 'empty-transcript',
            });
          }
        }
        return;
      }

      if (SAFE_BASELINE && request.mode === 'final' && (request.peak ?? 0) >= CLIPPING_THRESHOLD) {
        addLog(`${request.source}: segmento final descartado por clipping; baja volumen de la fuente (peak ${(request.peak ?? 0).toFixed(3)})`);
        debug('transcription:final-audit', {
          startMs: request.startMs,
          endMs: request.endMs,
          durationMs: result.durationMs,
          rms: request.rms,
          peak: request.peak,
          whisperGain: request.whisperGain,
          promptLength: result.whisperPromptLength ?? 0,
          language: effectiveLanguage,
          acceptedFinal: false,
          rejectReason: 'clipping',
        });
        return;
      }

      const queueWaitMs = request.enqueuedAtMs !== undefined ? Date.now() - request.enqueuedAtMs : 0;
      const wallLatencyMs = queueWaitMs + result.durationMs;
      if (request.mode === 'preview') {
        let timeToFirstPreviewMs: number | undefined;
        if (!previewFirstSuccessRef.current.has(request.segmentId)) {
          previewFirstSuccessRef.current.add(request.segmentId);
          const openedAt = previewSegmentOpenedAtRef.current.get(request.segmentId);
          if (openedAt !== undefined) {
            timeToFirstPreviewMs = Math.round(performance.now() - openedAt);
          }
        }
        syncAsrLiveStats({
          previewLatencyMs: wallLatencyMs,
          lastPreviewSegmentDurationMs: request.endMs - request.startMs,
          ...(timeToFirstPreviewMs !== undefined ? { timeToFirstPreviewMs } : {}),
        });
        debug('transcription:latency-metrics', {
          kind: 'preview',
          wallLatencyMs,
          timeToFirstPreviewMs,
          segmentDurationMs: request.endMs - request.startMs,
          modelName: result.modelName,
        });
      } else {
        syncAsrLiveStats({ finalLatencyMs: wallLatencyMs });
        debug('transcription:latency-metrics', {
          kind: 'final',
          wallLatencyMs,
          timeToFinalMs: wallLatencyMs,
          modelName: result.modelName,
        });
      }

      const baseSegment: TranscriptSegment = {
        id: request.blockId,
        startMs: request.startMs,
        endMs: request.endMs,
        text,
        rawText: result.text,
        status: request.mode === 'final' ? 'final' : 'partial',
        source: request.source,
        rms: request.rms,
        peak: request.peak,
        durationMs: result.durationMs,
        modelName: result.modelName,
        suspicious: request.mode === 'preview' && isSuspiciousTranscript(text, request.rms),
        sampleRate: request.sampleRate,
        sampleCount: request.sampleCount,
        possibleClipping: request.possibleClipping,
        whisperGain: request.whisperGain,
        whisperPromptLength: result.whisperPromptLength,
        segmentId: request.segmentId,
        asrMode: request.mode === 'final' ? 'final' as const : 'preview' as const,
        language: effectiveLanguage,
      };

      if (request.mode === 'final') {
        handleFinalSegment(baseSegment, request.segmentId);
      } else {
        handlePreviewSegment(baseSegment, request.segmentId);
      }
    }).catch((error) => {
      debug('transcription:whisper-invocation', {
        language: effectiveLanguage,
        promptLength: 0,
        verbatimOnly: effectiveVerbatimOnly,
        translateEnabled: false,
        argsSanitized: [],
        invokeError: String(error),
      });
      debug('transcription:window-error', String(error));
      addLog(`transcription error: ${String(error)}`);
    }).finally(() => {
      transcriptionBusyRef.current = false;
      transcriptionInFlightModeRef.current = null;
      syncAsrLiveStats({});
      processNextTranscriptionWindow();
    });
  }, [addLog, glossary, handleFinalSegment, handlePreviewSegment, promptMode, syncAsrLiveStats]);

  const enqueueTranscription = useCallback((request: TranscriptionWindow) => {
    const enqueuedAtMs = Date.now();
    const r: TranscriptionWindow = SAFE_BASELINE
      ? { ...request, verbatimOnly: true, language: 'es', enqueuedAtMs }
      : { ...request, enqueuedAtMs };

    if (r.mode === 'final') {
      if (transcriptionBusyRef.current && transcriptionInFlightModeRef.current === 'preview') {
        debug('transcription:cancel-preview-for-final', { cancelReason: 'final-arrived-while-preview-running' });
        void window.meetingAssistant.transcription.cancelPending().catch(() => undefined);
        syncAsrLiveStats({ lastCancelReason: 'final-arrived-while-preview-running' });
      }
      const withoutPreviews = pendingTranscriptionWindowsRef.current.filter((w) => w.mode !== 'preview');
      pendingTranscriptionWindowsRef.current = [r, ...withoutPreviews];
      syncAsrLiveStats({});
    } else {
      const pending = pendingTranscriptionWindowsRef.current;
      const lastIdx = pending.length - 1;
      if (lastIdx >= 0 && pending[lastIdx].mode === 'preview' && pending[lastIdx].segmentId === r.segmentId) {
        previewReplacedCountRef.current += 1;
        pending[lastIdx] = { ...r, coalesced: true };
        syncAsrLiveStats({});
        debug('transcription:preview-replaced', { blockId: r.blockId, segmentId: r.segmentId });
        processNextTranscriptionWindow();
        return;
      }
      let previewCount = 0;
      for (let i = 0; i < pending.length; i += 1) {
        if (pending[i].mode === 'preview') previewCount += 1;
      }
      if (previewCount >= MAX_PREVIEW_QUEUE) {
        const firstPreview = pending.findIndex((req) => req.mode === 'preview');
        if (firstPreview >= 0) {
          previewReplacedCountRef.current += 1;
          pending.splice(firstPreview, 1);
        }
      }
      pending.push(r);
      syncAsrLiveStats({});
    }
    debug('transcription:window-queued', {
      blockId: r.blockId,
      mode: r.mode,
      segmentId: r.segmentId,
      asrQueue: pendingTranscriptionWindowsRef.current.length,
    });
    processNextTranscriptionWindow();
  }, [processNextTranscriptionWindow, syncAsrLiveStats]);

  const startLiveTranscription = useCallback((stream: MediaStream, source: SourceKey) => {
    const audioContext = ensureAudioContext();
    transcriptionProcessorRef.current?.disconnect();
    transcriptionSampleCursorRef.current = 0;
    transcriptionBusyRef.current = false;
    pendingTranscriptionWindowsRef.current = [];
    vadRef.current.reset();
    vadShortAccumRef.current = null;
    activeSegmentIdRef.current = null;
    lastPreviewPerfMsRef.current = 0;
    transcriptionInFlightModeRef.current = null;
    previewDroppedCountRef.current = 0;
    previewReplacedCountRef.current = 0;
    finalAcceptedCountRef.current = 0;
    previewSegmentOpenedAtRef.current.clear();
    previewFirstSuccessRef.current.clear();
    setAsrLiveStats({
      previewLatencyMs: null,
      finalLatencyMs: null,
      previewQueueSize: 0,
      finalQueueSize: 0,
      previewDroppedCount: 0,
      previewReplacedCount: 0,
      finalAcceptedCount: 0,
      lastPreviewSegmentDurationMs: null,
      timeToFirstPreviewMs: null,
      lastCancelReason: null,
    });
    liveTranscriptionSourceRef.current = source;
    polisherBusyRef.current = false;
    pendingPolishJobRef.current = null;
    cleanContextRef.current = '';
    lastNotesPolishAtRef.current = 0;
    lastNotesTextLengthRef.current = 0;

    const mediaSource = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;
    // Pull graph without sending to hardware speakers — routing loopback to
    // audioContext.destination can make macOS tear down screen-capture system audio.
    const pullSink = audioContext.createMediaStreamDestination();

    processor.onaudioprocess = (event) => {
      const input = new Float32Array(event.inputBuffer.getChannelData(0));
      const frameStartSample = transcriptionSampleCursorRef.current;
      transcriptionSampleCursorRef.current += input.length;

      const { closed } = vadRef.current.pushFrame(input, audioContext.sampleRate, frameStartSample);

      const verbatimOnly = SAFE_BASELINE ? true : !allowWhisperContextRef.current;
      const language = SAFE_BASELINE ? 'es' : whisperLanguageRef.current;

      if (vadRef.current.isSegmentOpen() && !activeSegmentIdRef.current) {
        const newSegId = `seg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        activeSegmentIdRef.current = newSegId;
        previewSegmentOpenedAtRef.current.set(newSegId, performance.now());
      }

      const captureSource = liveTranscriptionSourceRef.current;

      for (const seg of closed) {
        const segmentId = activeSegmentIdRef.current;
        if (segmentId) {
          previewFirstSuccessRef.current.delete(segmentId);
          previewSegmentOpenedAtRef.current.delete(segmentId);
        }
        activeSegmentIdRef.current = null;

        let workSeg = seg;
        if (SAFE_BASELINE && vadShortAccumRef.current) {
          workSeg = mergeVadClosedSegments(vadShortAccumRef.current, workSeg, audioContext.sampleRate);
          vadShortAccumRef.current = null;
        }

        if (SAFE_BASELINE && workSeg.durationMs < MIN_FINAL_AUDIO_MS) {
          vadShortAccumRef.current = workSeg;
          debug('vad:accumulate-short', { durationMs: workSeg.durationMs, endMs: workSeg.endMs });
          continue;
        }

        const { rms, peak, gain, processedSamples } = prepareWhisperSamples(workSeg.samples);
        warnPossibleClipping(captureSource, peak);

        if (SAFE_BASELINE && peak >= CLIPPING_THRESHOLD) {
          addLog(`${captureSource}: segmento final descartado por clipping; baja volumen de la fuente`);
          debug('transcription:final-audit', {
            startMs: workSeg.startMs,
            endMs: workSeg.endMs,
            durationMs: workSeg.durationMs,
            rms,
            peak,
            whisperGain: gain,
            promptLength: 0,
            language: 'es',
            acceptedFinal: false,
            rejectReason: 'clipping',
          });
          continue;
        }

        const audioDurationMs = samplesDurationMs(processedSamples, audioContext.sampleRate);
        if (rms < MIN_WHISPER_RMS || audioDurationMs < MIN_FINAL_AUDIO_MS) {
          debug('transcription:vad-skip-low-quality-final', { rms, durationMs: audioDurationMs, vadDurationMs: workSeg.durationMs });
          continue;
        }
        const blockId = `final-${segmentId ?? 'unknown'}-${Math.round(workSeg.startMs)}-${Math.round(workSeg.endMs)}`;
        const wavBytes = encodeWav(processedSamples, audioContext.sampleRate);
        enqueueTranscription({
          blockId,
          wavBytes,
          startMs: Math.round(workSeg.startMs),
          endMs: Math.round(workSeg.endMs),
          rms,
          peak,
          source: captureSource,
          sampleRate: audioContext.sampleRate,
          sampleCount: processedSamples.length,
          possibleClipping: peak >= CLIPPING_THRESHOLD,
          whisperGain: gain,
          mode: 'final',
          segmentId: segmentId ?? 'unknown',
          verbatimOnly,
          language,
        });
      }

      if (SAFE_BASELINE && !ENABLE_LIVE_PREVIEW) return;
      if (!vadRef.current.isSegmentOpen()) return;

      const segmentId = activeSegmentIdRef.current;
      if (!segmentId) return;

      const pendingQ = pendingTranscriptionWindowsRef.current;
      if (pendingQ.some((w) => w.mode === 'final')) {
        previewDroppedCountRef.current += 1;
        syncAsrLiveStats({});
        return;
      }
      if (transcriptionBusyRef.current && transcriptionInFlightModeRef.current === 'final') {
        previewDroppedCountRef.current += 1;
        syncAsrLiveStats({});
        return;
      }

      const now = performance.now();
      if (now - lastPreviewPerfMsRef.current < PREVIEW_INTERVAL_MS) return;

      const snap = vadRef.current.getOpenSegmentSnapshot(audioContext.sampleRate);
      if (!snap || snap.samples.length === 0) return;

      const tail = trimPreviewSamplesToTail(
        snap.samples,
        audioContext.sampleRate,
        snap.endSample,
        MAX_PREVIEW_AUDIO_MS,
      );
      const { rms, peak, gain, processedSamples } = prepareWhisperSamples(tail.samples);
      warnPossibleClipping(captureSource, peak);
      const audioDurationMs = samplesDurationMs(processedSamples, audioContext.sampleRate);
      if (rms < MIN_WHISPER_RMS || audioDurationMs < MIN_PREVIEW_AUDIO_MS) {
        debug('transcription:preview-skip-low-quality', { rms, durationMs: audioDurationMs });
        return;
      }

      lastPreviewPerfMsRef.current = now;
      const wavBytes = encodeWav(processedSamples, audioContext.sampleRate);
      enqueueTranscription({
        blockId: `preview-${segmentId}-${Math.round(now)}`,
        wavBytes,
        startMs: Math.round(tail.startMs),
        endMs: Math.round(tail.endMs),
        rms,
        peak,
        source: captureSource,
        sampleRate: audioContext.sampleRate,
        sampleCount: processedSamples.length,
        possibleClipping: peak >= CLIPPING_THRESHOLD,
        whisperGain: gain,
        mode: 'preview',
        segmentId,
        verbatimOnly,
        language,
      });
    };

    mediaSource.connect(processor);
    processor.connect(silentSink);
    silentSink.connect(pullSink);
    transcriptionProcessorRef.current = processor;
    graphNodesRef.current.push(mediaSource, processor, silentSink, pullSink);
    addLog(SAFE_BASELINE
      ? `transcripción: safeBaseline — final=VAD directo (≥5s, máx 15s), preview cada ~2s (cola ≤${MAX_PREVIEW_AUDIO_MS / 1000}s, modelo liviano si existe). Preview es UX; final es verdad.`
      : 'transcripción: VAD + ledger; Whisper con calidad prioritaria si contexto activo');
  }, [addLog, enqueueTranscription, ensureAudioContext, syncAsrLiveStats, warnPossibleClipping]);

  const startCapture = useCallback(
    async (mode: CaptureMode) => {
      await stopCapture();
      setSavedWav(null);
      setRawSegments([]);
      setCleanSegments([]);
      setLedgerDebugGroups([]);
      setLiveVisualDraft(INITIAL_LIVE_VISUAL_DRAFT);
      setLiveTranscript({ committedText: '', unstableSuffix: '', lastReason: 'waiting', lastUpdatedAt: null });
      pendingTranscriptionWindowsRef.current = [];
      vadRef.current.reset();
      vadShortAccumRef.current = null;
      candidateLedgerRef.current.reset();
      if (ledgerFlushTimerRef.current !== null) {
        window.clearTimeout(ledgerFlushTimerRef.current);
        ledgerFlushTimerRef.current = null;
      }
      activeSegmentIdRef.current = null;
      lastPreviewPerfMsRef.current = 0;
      transcriptionInFlightModeRef.current = null;
      previewDroppedCountRef.current = 0;
      previewReplacedCountRef.current = 0;
      finalAcceptedCountRef.current = 0;
      previewSegmentOpenedAtRef.current.clear();
      previewFirstSuccessRef.current.clear();
      setAsrLiveStats({
        previewLatencyMs: null,
        finalLatencyMs: null,
        previewQueueSize: 0,
        finalQueueSize: 0,
        previewDroppedCount: 0,
        previewReplacedCount: 0,
        finalAcceptedCount: 0,
        lastPreviewSegmentDurationMs: null,
        timeToFirstPreviewMs: null,
        lastCancelReason: null,
      });
      pendingPolishJobRef.current = null;
      cleanContextRef.current = '';
      setCaptureMode(mode);
      addLog(`iniciando captura: ${mode}`);
      debug('capture:start', {
        mode,
        selectedMicId,
        selectedSystemInputId,
        selectedDesktopSourceId,
        inputDevices: inputDevices.map((device) => ({ deviceId: device.deviceId, groupId: device.groupId, label: device.label })),
        outputDevices: outputDevices.map((device) => ({ deviceId: device.deviceId, groupId: device.groupId, label: device.label })),
        desktopSources,
        nativeMediaAccess,
        browserPermissions: {
          micPermission,
          systemPermission,
        },
      });

      const captured: MediaStream[] = [];
      if (mode === 'mic' || mode === 'both') {
        try {
          captured.push(await captureMic());
        } catch {
          addLog('mic: no disponible para esta sesión');
        }
      }
      if (mode === 'system' || mode === 'both') {
        try {
          captured.push(await captureSystem());
        } catch {
          addLog('system: no disponible para esta sesión');
        }
      }

      if (captured.length > 0) {
        const mixedStream = buildMixedStream(captured);
        debug('capture:mixed:stream', describeStream(mixedStream));
        startLiveTranscription(mixedStream, captured.length > 1 ? 'mixed' : mode === 'system' ? 'system' : 'mic');
      } else {
        patchMeter('mixed', {
          status: 'failed',
          error: 'empty-stream: no hay fuentes activas para mezclar ni transcribir',
        });
      }

      const ctx = audioContextRef.current;
      if (ctx?.state === 'suspended') {
        try {
          await ctx.resume();
          debug('audio-context:resumed', { state: ctx.state });
        } catch (error) {
          debug('audio-context:resume-error', String(error));
        }
      }

      startMeterLoop();
    },
    [
      addLog,
      buildMixedStream,
      captureMic,
      captureSystem,
      desktopSources,
      inputDevices,
      micPermission,
      nativeMediaAccess,
      patchMeter,
      selectedDesktopSourceId,
      selectedMicId,
      selectedOutputId,
      selectedSystemInputId,
      startMeterLoop,
      startLiveTranscription,
      stopCapture,
      systemPermission,
      outputDevices,
    ],
  );

  const startTestRecording = useCallback(async () => {
    const stream = streamsRef.current.mixed || streamsRef.current.mic || streamsRef.current.system;
    const audioContext = audioContextRef.current;
    if (!stream || !audioContext) {
      addLog('recording: no hay captura activa para grabar prueba');
      return;
    }

    if (audioContext.state === 'suspended') {
      void audioContext.resume().catch(() => undefined);
    }

    recordingChunksRef.current = [];
    setRecording(true);
    setRecordingSecondsLeft(30);
    setSavedWav(null);

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;

    processor.onaudioprocess = (event) => {
      recordingChunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };

    const pullSink = audioContext.createMediaStreamDestination();
    source.connect(processor);
    processor.connect(silentSink);
    silentSink.connect(pullSink);
    recordingProcessorRef.current = processor;

    const startedAt = Date.now();
    recordingTimerRef.current = window.setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setRecordingSecondsLeft(Math.max(0, 30 - elapsed));
      if (elapsed < 30) return;

      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
      processor.disconnect();
      silentSink.disconnect();
      source.disconnect();
      recordingProcessorRef.current = null;
      setRecording(false);

      const totalLength = recordingChunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
      const samples = new Float32Array(totalLength);
      let offset = 0;
      recordingChunksRef.current.forEach((chunk) => {
        samples.set(chunk, offset);
        offset += chunk.length;
      });

      const wavBytes = encodeWav(samples, audioContext.sampleRate);
      const saved = await window.meetingAssistant.files.saveWav({
        bytes: wavBytes,
        fileName: `audio-diagnostic-${captureMode ?? 'mixed'}-${new Date().toISOString()}.wav`,
      });
      setSavedWav(saved);
      addLog(`recording: WAV guardado en ${saved.path}`);
    }, 250);
  }, [addLog, captureMode]);

  const statusSummary = useMemo(() => {
    if (platform === 'darwin') {
      return 'macOS: se intenta system audio directo con Electron. Si el track llega vacío o termina, la ruta confiable del MVP es BlackHole como entrada virtual.';
    }
    if (platform === 'win32') {
      return 'Windows: se intenta la ruta Electron/Chromium de desktop audio para loopback del sistema.';
    }
    return 'Plataforma no objetivo del MVP; los diagnósticos pueden servir para desarrollo.';
  }, [platform]);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Local Meeting Assistant MVP</p>
          <h1>Audio Diagnostics</h1>
        </div>
        <div className="platform-pill">{platform}</div>
      </section>

      <section className="diagnostic-grid">
        <div className="panel controls-panel">
          <h2>Capture</h2>
          <p className="muted">{statusSummary}</p>

          <label className="field">
            <span>Micrófono</span>
            <select value={selectedMicId} onChange={(event) => setSelectedMicId(event.target.value)}>
              {inputDevices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Micrófono ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Salida que querés escuchar/capturar</span>
            <select value={selectedOutputId} onChange={(event) => setSelectedOutputId(event.target.value)}>
              <option value="">Salida predeterminada del sistema</option>
              {outputDevices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Salida ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Fuente desktop/system</span>
            <select value={selectedDesktopSourceId} onChange={(event) => setSelectedDesktopSourceId(event.target.value)}>
              <option value="">Auto / picker del sistema</option>
              {desktopSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Entrada virtual para system audio</span>
            <select value={selectedSystemInputId} onChange={(event) => setSelectedSystemInputId(event.target.value)}>
              <option value="">Auto detectar BlackHole/Loopback/VB-CABLE</option>
              {inputDevices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Entrada ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <p className="routing-note">
            Los audífonos y bocinas son salidas, no entradas capturables por `getUserMedia`.
            En macOS, si Electron no obtiene system audio directo, hay que rutear esa salida hacia una entrada virtual como BlackHole.
          </p>

          <div className="permission-row">
            <PermissionBadge label="Mic" state={micPermission} />
            <PermissionBadge label="Screen/System" state={systemPermission} />
          </div>
          {nativeMediaAccess && (
            <div className="native-permissions">
              <span>macOS mic: <strong>{nativeMediaAccess.microphone}</strong></span>
              <span>macOS screen: <strong>{nativeMediaAccess.screen}</strong></span>
            </div>
          )}

          <div className="button-grid">
            <button onClick={() => void startCapture('mic')}>Capturar micrófono</button>
            <button onClick={() => void startCapture('system')}>Capturar sistema</button>
            <button onClick={() => void startCapture('both')}>Capturar ambos</button>
            <button className="secondary" onClick={() => void stopCapture()}>Detener</button>
          </div>

          <button className="record-button" disabled={!captureMode || recording} onClick={() => void startTestRecording()}>
            {recording ? `Grabando ${recordingSecondsLeft}s` : 'Grabar prueba 30 segundos'}
          </button>

          {savedWav && (
            <div className="playback">
              <span>WAV guardado</span>
              <code>{savedWav.path}</code>
              <audio controls src={savedWav.fileUrl} />
            </div>
          )}

          {platform === 'darwin' && <p className="fallback">{macSystemFallbackText}</p>}
        </div>

        <div className="meters-stack">
          <MeterCard title="Mic RMS" meter={meters.mic} />
          <MeterCard title="System RMS" meter={meters.system} />
          <MeterCard title="Mixed RMS" meter={meters.mixed} />
        </div>

        <div className="panel log-panel">
          <h2>Failure / Debug Log</h2>
          {diagnosticLog.length === 0 ? (
            <p className="muted">Sin eventos todavía.</p>
          ) : (
            <ul>
              {diagnosticLog.map((entry, index) => (
                <li key={`${index}-${entry}`}>{entry}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel transcript-panel">
          <div className="transcript-header">
            <div>
              <h2>Transcripción en vivo</h2>
              <p className="muted">
                {SAFE_BASELINE && !showRawDebug ? (
                  <span>Arriba: solo texto confirmado (VAD) y borrador visual con typewriter (~{TYPEWRITER_WORD_INTERVAL_MS} ms/palabra). Sin hipótesis cruda en pantalla. Cursor mientras capturás o hay cola pendiente.</span>
                ) : (
                  <>
                    {SAFE_BASELINE && (
                      <span><strong>Modo safeBaseline:</strong> vista verbatim, Whisper sin prompt, idioma es, sin Gemma en ASR; final=VAD directo; preview solo hipótesis en vivo (sin lista de alternativas). </span>
                    )}
                    {whisperSetup?.ok
                      ? (SAFE_BASELINE
                        ? `Final: ${whisperSetup.finalModelName ?? whisperSetup.activeModelName ?? '—'}. Preview ASR: ${PREVIEW_MODEL_POLICY === 'same-as-final' ? 'mismo modelo que el final' : `rápido (${whisperSetup.previewModelName ?? 'small/base'})`}. VAD ≥ ${MIN_FINAL_AUDIO_MS / 1000}s, máx ${MAX_FINAL_SEGMENT_MS / 1000}s; clipping ≥ ${CLIPPING_THRESHOLD} rechazado.`
                        : `Whisper (${whisperSetup.activeModelName ?? 'modelo'}): VAD + ledger estabilizan frases; el preview va en cursiva. La vista principal muestra el texto refinado (Gemma) cuando está listo.`)
                      : whisperSetup?.message ?? 'Verificando whisper.cpp local...'}
                  </>
                )}
              </p>
            </div>
            <button className="secondary" onClick={() => {
              setRawSegments([]);
              setCleanSegments([]);
              setLedgerDebugGroups([]);
              setLiveVisualDraft(INITIAL_LIVE_VISUAL_DRAFT);
              setLiveTranscript({ committedText: '', unstableSuffix: '', lastReason: 'waiting', lastUpdatedAt: null });
              pendingTranscriptionWindowsRef.current = [];
              vadRef.current.reset();
              vadShortAccumRef.current = null;
              candidateLedgerRef.current.reset();
              if (ledgerFlushTimerRef.current !== null) {
                window.clearTimeout(ledgerFlushTimerRef.current);
                ledgerFlushTimerRef.current = null;
              }
              activeSegmentIdRef.current = null;
              lastPreviewPerfMsRef.current = 0;
              transcriptionInFlightModeRef.current = null;
              previewDroppedCountRef.current = 0;
              previewReplacedCountRef.current = 0;
              finalAcceptedCountRef.current = 0;
              previewSegmentOpenedAtRef.current.clear();
              previewFirstSuccessRef.current.clear();
              setAsrLiveStats({
                previewLatencyMs: null,
                finalLatencyMs: null,
                previewQueueSize: 0,
                finalQueueSize: 0,
                previewDroppedCount: 0,
                previewReplacedCount: 0,
                finalAcceptedCount: 0,
                lastPreviewSegmentDurationMs: null,
                timeToFirstPreviewMs: null,
                lastCancelReason: null,
              });
              pendingPolishJobRef.current = null;
              cleanContextRef.current = '';
            }}>Limpiar</button>
          </div>
          <div className="setup-grid">
            {whisperSetup && (
              <div className={whisperSetup.ok ? 'setup-status setup-ready' : 'setup-status setup-missing'}>
                <strong>{whisperSetup.ok ? 'Whisper listo' : 'Whisper no listo'}</strong>
                <span>{whisperSetup.ok
                  ? `final: ${whisperSetup.finalModelName ?? whisperSetup.activeModelName ?? '—'} | preview: ${whisperSetup.previewModelName ?? '—'} — ${whisperSetup.modelPath}`
                  : 'Ejecuta npm run whisper:setup:turbo'}</span>
              </div>
            )}
            {polisherSetup && (
              <div className={polisherSetup.ok ? 'setup-status setup-ready' : 'setup-status setup-missing'}>
                <strong>{polisherSetup.ok ? 'Gemma listo' : 'Gemma no listo'}</strong>
                <span>{polisherSetup.ok ? polisherSetup.model : polisherSetup.message}</span>
              </div>
            )}
          </div>

          <label className="field compact-field">
            <span>Idioma Whisper</span>
            <select value={whisperLanguage} onChange={(event) => setWhisperLanguage(event.target.value as 'es' | 'auto')} disabled={SAFE_BASELINE}>
              <option value="es">es (forzar español)</option>
              <option value="auto">auto (detección)</option>
            </select>
          </label>

          <label className="field compact-field checkbox-field">
            <span>
              <input
                type="checkbox"
                checked={allowWhisperContext}
                onChange={(event) => setAllowWhisperContext(event.target.checked)}
                disabled={SAFE_BASELINE}
              />
              Usar glosario + contexto en el prompt de Whisper (recomendado para calidad en reuniones técnicas)
            </span>
          </label>

          <label className="field compact-field">
            <span>Términos adicionales para Whisper (si contexto activo)</span>
            <textarea value={glossary} onChange={(event) => setGlossary(event.target.value)} disabled={!allowWhisperContext || SAFE_BASELINE} />
          </label>

          <label className="field compact-field">
            <span>Modo de prompt Whisper (si contexto activo)</span>
            <select value={promptMode} onChange={(event) => setPromptMode(event.target.value as WhisperPromptMode)} disabled={!allowWhisperContext || SAFE_BASELINE}>
              <option value="empty">sin prompt</option>
              <option value="minimal">compacto ASR (recomendado)</option>
              <option value="contextual">contextual compacto + términos</option>
            </select>
          </label>

          <div className="button-row">
            <button
              className={transcriptViewMode === 'clean' ? 'primary' : 'secondary'}
              onClick={() => setTranscriptViewMode('clean')}
              disabled={SAFE_BASELINE}
            >
              Transcripción limpia
            </button>
            <button
              className={transcriptViewMode === 'verbatim' ? 'primary' : 'secondary'}
              onClick={() => setTranscriptViewMode('verbatim')}
            >
              ASR crudo (Whisper)
            </button>
          </div>

          <div className={SAFE_BASELINE || liveTranscript.committedText || liveVisualDraft.visibleDraft.trim() || liveVisualDraft.pendingWords.length > 0 || captureMode || liveCleanText ? 'live-transcript' : 'live-transcript empty-clean'}>
            {!SAFE_BASELINE && transcriptViewMode === 'clean' ? (
              liveCleanText ? (
                <p><span>{liveCleanText}</span></p>
              ) : liveTranscript.committedText || liveTranscript.unstableSuffix ? (
                <p>
                  {polisherSetup?.ok ? (
                    <span className="muted">Refinando con Gemma… borrador Whisper: </span>
                  ) : (
                    <span className="muted">Ollama/Gemma no disponible; mostrando solo Whisper: </span>
                  )}
                  <span>{liveTranscript.committedText}</span>
                  {liveTranscript.unstableSuffix && <span className="unstable-text"> {liveTranscript.unstableSuffix}</span>}
                </p>
              ) : (
                'Sin transcripción todavía. Iniciá captura y hablá o reproducí audio.'
              )
            ) : SAFE_BASELINE ? (
              <div className="live-transcript-stack">
                <div
                  className="live-transcript-scroll"
                  ref={liveTranscriptScrollRef}
                  onScroll={onLiveTranscriptScroll}
                >
                  <div className="live-transcript-section-title">Transcripción</div>
                  <p className="live-transcript-text" aria-live="polite">
                    {liveTranscript.committedText.trim() ? (
                      <span>{liveTranscript.committedText}</span>
                    ) : (
                      <span className="live-transcript-placeholder">
                        Aún no hay texto confirmado. Aparece aquí cuando el VAD cierra un segmento.
                      </span>
                    )}
                    {ENABLE_LIVE_PREVIEW && liveVisualDraft.visibleDraft.trim() ? (
                      <>
                        {' '}
                        <span className="preview-draft">{liveVisualDraft.visibleDraft}</span>
                      </>
                    ) : null}
                    {ENABLE_LIVE_PREVIEW && (captureMode != null || liveVisualDraft.pendingWords.length > 0) ? (
                      <span className="typing-cursor" aria-hidden="true">
                        ▌
                      </span>
                    ) : null}
                    {ENABLE_LIVE_PREVIEW
                      && captureMode != null
                      && !liveTranscript.committedText.trim()
                      && !liveVisualDraft.visibleDraft.trim()
                      && liveVisualDraft.pendingWords.length === 0 ? (
                        <>
                          {' '}
                          <span className="live-transcript-placeholder">Esperando voz…</span>
                        </>
                      ) : null}
                  </p>
                </div>
              </div>
            ) : liveTranscript.committedText || liveTranscript.unstableSuffix ? (
              <p className="live-transcript-text">
                <span>{liveTranscript.committedText}</span>
                {liveTranscript.unstableSuffix && <span className="unstable-text"> {liveTranscript.unstableSuffix}</span>}
              </p>
            ) : (
              'Sin transcripción en vivo todavía. Iniciá captura y hablá o reproducí audio.'
            )}
          </div>

          <div className="live-meta">
            {SAFE_BASELINE && !showRawDebug ? (
              <span>
                Borrador visual con typewriter (cola interna ~{PREVIEW_HIDDEN_TAIL_WORDS} palabras ocultas al usuario). Scroll al fondo solo si ya estabas cerca (~{SCROLL_STICK_THRESHOLD_PX}px). Cola audio preview ≤{MAX_PREVIEW_AUDIO_MS / 1000}s. Idioma es · preview modelo: {PREVIEW_MODEL_POLICY === 'same-as-final' ? 'igual al final' : 'rápido'}.
              </span>
            ) : (
              <>
                <span>Estado: {liveTranscript.lastReason}</span>
                <span>Preview: {SAFE_BASELINE && !ENABLE_LIVE_PREVIEW ? 'off' : `cada ~${(PREVIEW_INTERVAL_MS / 1000).toFixed(1)}s (cola ≤${MAX_PREVIEW_AUDIO_MS / 1000}s)`}</span>
                <span>ASR: {SAFE_BASELINE ? 'VAD final directo (sin ledger en committed)' : 'ledger + VAD'}</span>
                <span>Idioma: {SAFE_BASELINE ? 'es (forzado)' : whisperLanguage}</span>
                {SAFE_BASELINE && ENABLE_LIVE_PREVIEW && (
                  <>
                    <span>lat preview: {asrLiveStats.previewLatencyMs != null ? `${asrLiveStats.previewLatencyMs}ms` : '—'}</span>
                    <span>lat final: {asrLiveStats.finalLatencyMs != null ? `${asrLiveStats.finalLatencyMs}ms` : '—'}</span>
                    <span>1er preview: {asrLiveStats.timeToFirstPreviewMs != null ? `${asrLiveStats.timeToFirstPreviewMs}ms` : '—'}</span>
                    <span>cola pv/fin: {asrLiveStats.previewQueueSize}/{asrLiveStats.finalQueueSize}</span>
                    <span>pv drop/reempl: {asrLiveStats.previewDroppedCount}/{asrLiveStats.previewReplacedCount}</span>
                    <span>finales ok: {asrLiveStats.finalAcceptedCount}</span>
                    {asrLiveStats.lastCancelReason && <span>cancel: {asrLiveStats.lastCancelReason}</span>}
                  </>
                )}
                <span>Whisper contexto: {SAFE_BASELINE ? 'no (safeBaseline)' : (allowWhisperContext ? `sí (${promptMode})` : 'no')}</span>
                <span>Vista: {SAFE_BASELINE ? 'verbatim (forzado)' : (transcriptViewMode === 'clean' ? 'limpia' : 'ASR crudo')}</span>
                <span>Gemma: {SAFE_BASELINE ? 'off' : (polisherSetup?.ok ? 'disponible' : 'no listo')}</span>
                {liveTranscript.lastUpdatedAt && <span>Última actualización: {new Date(liveTranscript.lastUpdatedAt).toLocaleTimeString()}</span>}
              </>
            )}
          </div>

          {(!SAFE_BASELINE || showRawDebug) && cleanSegments.length > 0 && (
            <details className="notes-panel">
              <summary>Fragmentos refinados ({cleanSegments.length})</summary>
              <div className="clean-transcript">
                {cleanSegments.map((segment) => (
                  <p key={segment.id}>
                    <time>{formatMs(segment.startMs)} - {formatMs(segment.endMs)}</time>
                    {segment.cleanText}
                  </p>
                ))}
              </div>
            </details>
          )}

          {(!SAFE_BASELINE || showRawDebug) && cleanSegments.length === 0 && (
            <div className="notes-hint">
              {polisherSetup?.ok
                ? 'El texto refinado se acumula aquí; no modifica el audio ni reemplaza términos en el ASR crudo.'
                : 'Instalá Ollama + Gemma para ver transcripción limpia; mientras tanto solo verás el borrador Whisper.'}
            </div>
          )}

          <button className="raw-toggle secondary" type="button" onClick={() => setShowRawDebug((current) => !current)}>
            {showRawDebug ? 'Ocultar debug avanzado' : 'Mostrar debug avanzado'}
            {(rawSegments.length > 0 || ledgerDebugGroups.length > 0) && !showRawDebug ? ` (${rawSegments.length + ledgerDebugGroups.length})` : ''}
          </button>

          {showRawDebug && (
            <>
              <p className="muted debug-advanced-hint">Debug avanzado: segmentos crudos, ledger y puntuaciones (no forma parte de la lectura principal).</p>
              {SAFE_BASELINE && ENABLE_LIVE_PREVIEW && (
                <details className="preview-visual-debug">
                  <summary>Preview visual / interno (safeBaseline)</summary>
                  <div className="preview-visual-debug-body">
                    <p><span className="muted">segmentId: </span><code>{liveVisualDraft.segmentId ?? '—'}</code></p>
                    <p><span className="muted">lastRawPreview: </span><code>{liveVisualDraft.lastRawPreview.trim() || '—'}</code></p>
                    <p><span className="muted">cola oculta (derivada): </span><code>{debugHiddenTailFromRaw(liveVisualDraft.lastRawPreview) || '—'}</code></p>
                    <p><span className="muted">visibleDraft: </span><code>{liveVisualDraft.visibleDraft.trim() || '—'}</code></p>
                    <p><span className="muted">pendingWords: </span><code>{liveVisualDraft.pendingWords.length > 0 ? liveVisualDraft.pendingWords.join(' ') : '—'}</code></p>
                    <p><span className="muted">unstableSuffix (transcript state): </span><code>{liveTranscript.unstableSuffix.trim() || '—'}</code></p>
                  </div>
                </details>
              )}
              {ledgerDebugGroups.length > 0 && (
                <div className="ledger-debug">
                  <h3>Alternativas ASR (debug)</h3>
                  <ol className="ledger-group-list">
                    {ledgerDebugGroups.map((group) => (
                      <li key={group.segmentId}>
                        <div className="segment-meta">
                          <time>{formatMs(group.startMs)} - {formatMs(group.endMs)}</time>
                          <span className={group.committed ? 'source-tag' : 'source-tag warning-tag'}>
                            {group.committed ? 'confirmado' : 'editable'}
                          </span>
                          {group.reasons.map((reason) => (
                            <span className="source-tag" key={reason}>{reason}</span>
                          ))}
                        </div>
                        <p className="ledger-choice">{group.chosenText}</p>
                        <ul className="ledger-candidate-list">
                          {group.candidates.map((candidate) => (
                            <li key={candidate.id} className={candidate.id === group.chosenCandidateId ? 'ledger-candidate chosen' : 'ledger-candidate'}>
                              <div className="segment-meta">
                                <span className="source-tag">{candidate.mode}</span>
                                <span className="source-tag">score {candidate.score}</span>
                                {candidate.modelName && <span className="source-tag">{candidate.modelName}</span>}
                                {candidate.reasons.map((reason) => (
                                  <span className="source-tag" key={`${candidate.id}-${reason}`}>{reason}</span>
                                ))}
                              </div>
                              <p>{candidate.text}</p>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <ol className="transcript-list raw-list">
                {rawSegments.map((segment) => (
                  <li key={segment.id}>
                    <div className="segment-meta">
                      <time>{formatMs(segment.startMs)} - {formatMs(segment.endMs)}</time>
                      <span className="source-tag">{segment.source}</span>
                      <span className="source-tag">{segment.status}</span>
                      <span className="source-tag">RMS {segment.rms.toFixed(3)}</span>
                      {segment.peak !== undefined && <span className="source-tag">Peak {segment.peak.toFixed(3)}</span>}
                      {segment.whisperGain !== undefined && segment.whisperGain !== 1 && <span className="source-tag">gain {segment.whisperGain.toFixed(3)}</span>}
                      {segment.sampleCount !== undefined && <span className="source-tag">{segment.sampleCount} samples</span>}
                      {segment.sampleRate !== undefined && <span className="source-tag">{segment.sampleRate}Hz</span>}
                      {segment.durationMs !== undefined && <span className="source-tag">{segment.durationMs}ms</span>}
                      {segment.modelName && <span className="source-tag">{segment.modelName}</span>}
                      {segment.asrMode && <span className="source-tag">{segment.asrMode}</span>}
                      {segment.language && <span className="source-tag">{segment.language}</span>}
                      {segment.segmentId && <span className="source-tag">{segment.segmentId}</span>}
                      {segment.stabilizationReason && <span className="source-tag">{segment.stabilizationReason}</span>}
                      {segment.whisperPromptLength !== undefined && <span className="source-tag">prompt {segment.whisperPromptLength}</span>}
                      {segment.coalesced && <span className="source-tag warning-tag">coalesced</span>}
                      {segment.suspicious && <span className="source-tag warning-tag">sospechoso</span>}
                      {segment.possibleClipping && <span className="source-tag warning-tag">possible clipping</span>}
                    </div>
                    <p>{segment.text}</p>
                    <p className="muted">rawText: {segment.rawText ?? segment.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function formatMs(value: number) {
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function shouldUseForLive(segment: TranscriptSegment) {
  const text = segment.text.trim();
  if (text.length < 4) return false;
  if (segment.suspicious) return false;
  if (/^(ah|eh|mmm|um|ok|vale|bueno)[\s.?!]*$/iu.test(text)) return false;
  return true;
}

function prepareWhisperSamples(samples: Float32Array) {
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  const gain = peak > WHISPER_PEAK_TARGET ? WHISPER_PEAK_TARGET / peak : 1;
  const processedSamples = gain === 1 ? samples : applyGain(samples, gain);
  return {
    rms: Math.sqrt(sum / Math.max(1, samples.length)),
    peak,
    gain,
    processedSamples,
  };
}

function applyGain(samples: Float32Array, gain: number) {
  const scaled = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    scaled[index] = Math.max(-1, Math.min(1, samples[index] * gain));
  }
  return scaled;
}

function samplesDurationMs(samples: Float32Array, sampleRate: number) {
  return (samples.length / sampleRate) * 1000;
}

function isSuspiciousTranscript(text: string, rms: number) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const phraseHit = SUSPICIOUS_PHRASES.some((phrase) => normalized.includes(phrase.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
  return phraseHit && rms < 0.04;
}

function PermissionBadge({ label, state }: { label: string; state: PermissionState | 'unknown' }) {
  return (
    <div className={`permission permission-${state}`}>
      <span>{label}</span>
      <strong>{state}</strong>
    </div>
  );
}

function MeterCard({ title, meter }: { title: string; meter: MeterState }) {
  const percent = Math.min(100, Math.round(meter.rms * 180));
  return (
    <div className="panel meter-card">
      <div className="meter-header">
        <div>
          <h2>{title}</h2>
          <p className="muted">{meter.sampleRate ? `${meter.sampleRate} Hz detectado` : 'sin sample rate'}</p>
        </div>
        <span className={`status status-${meter.status}`}>{meter.status}</span>
      </div>
      <div className="meter-bar" aria-label={title}>
        <div style={{ width: `${percent}%` }} />
      </div>
      <div className="meter-values">
        <span>RMS {meter.rms.toFixed(3)}</span>
        <span>Peak {meter.peak.toFixed(3)}</span>
      </div>
      <div className="signal-row">
        <span className={meter.silence ? 'signal active' : 'signal'}>Silencio</span>
        <span className={meter.clipping ? 'signal danger active' : 'signal danger'}>Clipping</span>
      </div>
      {meter.error && <p className="error-text">{meter.error}</p>}
    </div>
  );
}
