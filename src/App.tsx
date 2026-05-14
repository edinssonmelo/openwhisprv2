import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { encodeWav } from './audio/wav';
import { createVadEndpointing, type VadClosedSegment } from './audio/vadEndpointing';
import { createTranscriptCandidateLedger, type LedgerDebugGroup, type LedgerSnapshot } from './audio/transcriptCandidateLedger';
import {
  filterVirtualSystemInputCandidates,
  runSystemAudioEngine,
  SystemAudioEngineError,
  type SystemAudioDeviceCandidate,
  type SystemAudioProviderId,
  type SystemAudioStrategy,
} from './audio/systemAudioEngine';
import { LiveTranscriptView } from './components/LiveTranscriptView';
import {
  buildFinalTranscriptRefinementPrompt,
  shouldCreateRefinementBatch,
  type RefinementSegmentInput,
} from './transcription/finalTranscriptRefiner';
import { DashboardHome } from './components/DashboardHome';
import type { DashboardSessionSummary } from './types/dashboardSession';
import { HomeConfirmDialog } from './components/HomeConfirmDialog';
import { FloatingAssistantShell } from './components/FloatingAssistantShell';
import { SetupOnboarding } from './components/SetupOnboarding';
import { PremiumToast } from './components/PremiumToast';
import type { AssistantChatMessage } from './components/AssistantChatPanel';
import { copyToClipboard } from './utils/copyToClipboard';
import {
  getOnboardingSystemSkipped,
  isOnboardingComplete,
  loadCapturePreference,
  loadSelectedSystemInputId,
  loadSystemCaptureStrategy,
  markOnboardingComplete,
  persistCapturePreference,
  persistSelectedSystemInputId,
  persistSystemCaptureStrategy,
  type CapturePreference,
  type SystemCaptureStrategy,
} from './storage/appPreferences';
import { readDashboardTheme } from './storage/dashboardTheme';
import { createTranscriptStore } from './transcription/transcriptStore';
import type { AsrEngineName, AsrFinalEngineMode, AsrPipelineMode, TranscriptRefinementMode, TranscriptViewState } from './transcription/types';
type SourceKey = 'mic' | 'system' | 'mixed';
type CaptureMode = 'mic' | 'system' | 'both';
type AppMode = 'dashboard' | 'session-boot' | 'session';
type CaptureStatus = 'idle' | 'requesting_permission' | 'capturing' | 'silence' | 'failed' | 'stopped';
type CaptureHealth = 'ok' | 'silent' | 'audio-ended' | 'recovering' | 'failed';
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

interface CaptureHealthState {
  captureHealth: CaptureHealth;
  audioTrackReadyState: MediaStreamTrackState | 'none';
  audioTrackMuted: boolean;
  audioTrackEndedAt: number | null;
  lastAudioRmsAt: number | null;
  lastNonSilentAudioAt: number | null;
  lastCheckedAt: number | null;
  message: string | null;
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
  engineUsed?: AsrEngineName;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  whisperText?: string;
  qwenText?: string;
  whisperDurationMs?: number;
  qwenDurationMs?: number;
  qwenError?: string;
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
  pipelineMode?: AsrPipelineMode;
  moonshineConfigured?: boolean;
  qwenConfigured?: boolean;
  experimentalPreview?: boolean;
  finalEngine?: AsrFinalEngineMode;
  refinementMode?: TranscriptRefinementMode;
  refinerModel?: string;
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

interface RefinedTranscriptState {
  status: 'off' | 'idle' | 'generating' | 'ready' | 'error';
  text: string;
  error: string | null;
  model: string | null;
  mode: TranscriptRefinementMode;
  updatedAt: number | null;
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

const initialCaptureHealth: CaptureHealthState = {
  captureHealth: 'ok',
  audioTrackReadyState: 'none',
  audioTrackMuted: false,
  audioTrackEndedAt: null,
  lastAudioRmsAt: null,
  lastNonSilentAudioAt: null,
  lastCheckedAt: null,
  message: null,
};

/** Baseline estable: solo segmentos VAD cerrados transcritos con whisper.cpp (`ggml-large-v3-turbo.bin`); sin preview en vivo. */
const SAFE_BASELINE = true;
/** Observa finales reales del baseline con el store visual v2, sin afectar la vista principal. */
const V2_TRANSCRIPT_STORE_SHADOW = true;
/** Tamaño máximo de segmento VAD (final). No bajar por debajo de ~10s sin pruebas; opcional futuro 12_000 si el final se siente muy largo. */
const MAX_FINAL_SEGMENT_MS = 15_000;

const SILENCE_THRESHOLD = 0.01;
const CLIPPING_THRESHOLD = 0.98;
const WHISPER_PEAK_TARGET = 0.92;
const PREVIEW_INTERVAL_MS = 750;
const MAX_PREVIEW_QUEUE = 1;
/** Ventana mínima de audio por pasada de preview. */
const MIN_PREVIEW_AUDIO_MS = 900;
/**
 * Recorte de cola del segmento abierto para cada pasada de preview (velocidad).
 * Subir si el preview sigue muy inestable; bajar si el rendimiento pesa.
 */
const MAX_PREVIEW_AUDIO_MS = 2_500;
const MIN_FINAL_AUDIO_MS = 5_000;
/** Palabras del final de la hipótesis que no se encolan al usuario (zona inestable). */
const PREVIEW_HIDDEN_TAIL_WORDS = 1;
/** Mínimo de palabras en prefijo común draft↔final para fusionar revelado VAD (`planFinalRevealMerge`). */
const PREVIEW_MIN_COMMON_PREFIX_WORDS = 1;
/** Typewriter preview: un poco más vivo; visión estable anti-dup sigue con merge/dedupe. */
const TYPEWRITER_WORD_INTERVAL_MS = 55;
const TYPEWRITER_MAX_WORDS_PER_TICK = 1;
const TYPEWRITER_PENDING_CATCHUP_THRESHOLD = 999;
const TYPEWRITER_CATCHUP_WORDS_PER_TICK = 1;
/** Máximo de palabras nuevas a encolar por cada merge de hipótesis. */
const MAX_NEW_PREVIEW_WORDS_PER_MERGE = 4;
/** Tope duro de la cola `pendingWords` para evitar rachas largas en pantalla. */
const MAX_PENDING_PREVIEW_WORDS = 12;
/** Revelado visual del texto final VAD (oficial ya está entero en `committedText`). */
/** Revelado del final VAD hacia texto visible: un poco más ágil tras preview más frecuente. */
const FINAL_REVEAL_WORD_INTERVAL_MS = 38;
const FINAL_REVEAL_WORDS_PER_TICK = 2;
const FINAL_REVEAL_CATCHUP_THRESHOLD = 40;
const FINAL_REVEAL_CATCHUP_WORDS_PER_TICK = 3;
/** Máx palabras solapadas a detectar al anexar texto visible (evita “cuál era cuál era”). */
const VISIBLE_APPEND_MAX_OVERLAP = 12;
/** Autoscroll al confirmar o actualizar preview solo si el usuario estaba cerca del fondo. */
const SCROLL_STICK_THRESHOLD_PX = 72;
const MIN_WHISPER_RMS_MIC = 0.0008;
const MIN_WHISPER_RMS_SYSTEM = 0.003;
const MIN_WHISPER_RMS_HELPER = 0.003;
const NOTES_POLISH_INTERVAL_MS = 12_000;
const AUDIO_WATCHDOG_INTERVAL_MS = 1_500;
const AUDIO_SILENT_WARNING_MS = 12_000;
const SYSTEM_SIGNAL_CHECK_TIMEOUT_MS = 3500;
const SYSTEM_SIGNAL_CHECK_INTERVAL_MS = 200;
const SYSTEM_SIGNAL_CHECK_RMS = 0.003;
const SYSTEM_SIGNAL_CHECK_PEAK = 0.01;
const SYSTEM_SIGNAL_CHECK_REQUIRED_HITS = 2;
const MAX_AUTO_RECOVERY_ATTEMPTS_PER_MINUTE = 2;
/** Tras captura exitosa: no promover a `audio-ended` ni auto-recover (glitches loopback / transición). */
const CAPTURE_WATCHDOG_GRACE_MS = 4000;
/** Tras expandir overlay de sesión (además de la gracia de captura). */
const CAPTURE_OVERLAY_EXPAND_GRACE_MS = 2500;
/** Intervalos consecutivos con track primario `ended` antes de marcar `audio-ended` (fuera de gracia). */
const AUDIO_ENDED_DEBOUNCE_TICKS = 2;
const DEFAULT_GLOSSARY = 'Intel, TSMC, Taiwan, Apple, GPU, Anthropic, OpenAI, chips, servidores, inversión, burbuja, foundry, informática, startups, Silicon Valley, programación, productos, IA';
const DEFAULT_AI_CONTEXT_PROMPT = 'Con base en lo último que se ha dicho, dame una ayuda breve, útil y contextual.';
const SAVED_SESSIONS_STORAGE_KEY = 'openwhispr.savedSessions.v1';
const SUSPICIOUS_PHRASES = [
  'nos vemos en el próximo video',
  'gracias por ver el video',
  'subtítulos realizados',
  'suscríbete',
  'dale like',
];
const VERBOSE_CAPTURE_STORAGE = 'openwhispr.verboseCaptureDebug';
const TRANSCRIPTION_TRACE_STORAGE = 'openwhispr.transcriptionTrace';
const DEBUG_PREFIX = '[audio-diagnostics]';
const TRACE_PREFIX = '[transcription-trace]';
const CRITICAL_CAPTURE_PREFIX = '[openwhispr-capture]';

const viteEnv = import.meta as unknown as { env?: Record<string, string | undefined> };

/** Default on; set `VITE_OPENWHISPR_AUTO_RECOVER_AUDIO=false` to disable auto reconnect on `audio-ended`. */
function isAutoRecoverSystemAudioEnabled(): boolean {
  return viteEnv.env?.VITE_OPENWHISPR_AUTO_RECOVER_AUDIO !== 'false';
}

function isLowRmsDebugEnabled(): boolean {
  return viteEnv.env?.VITE_OPENWHISPR_LOW_RMS_DEBUG === 'true';
}

function isForceMicWindowsEnabled(): boolean {
  return viteEnv.env?.VITE_OPENWHISPR_FORCE_MIC_WINDOWS === 'true';
}

type WhisperRmsProfile = 'mic' | 'system' | 'helper';

function minWhisperRmsForProfile(profile: WhisperRmsProfile): number {
  if (isLowRmsDebugEnabled()) return 0;
  if (profile === 'mic') return MIN_WHISPER_RMS_MIC;
  if (profile === 'helper') return MIN_WHISPER_RMS_HELPER;
  return MIN_WHISPER_RMS_SYSTEM;
}

function whisperProfileForLiveSource(source: SourceKey): WhisperRmsProfile {
  if (source === 'system') return 'system';
  return 'mic';
}

/** Explicit opt-in/out for the display video sink. macOS also enables it by default below. */
function isDisplayVideoSinkEnabled(): boolean {
  return viteEnv.env?.VITE_OPENWHISPR_KEEP_DISPLAY_VIDEO_SINK === 'true';
}

/** macOS + display stream with a video track: always attach hidden sink unless explicitly disabled. */
function shouldAttachDisplayVideoSink(stream: MediaStream, platform: NodeJS.Platform | 'unknown'): boolean {
  if (viteEnv.env?.VITE_OPENWHISPR_KEEP_DISPLAY_VIDEO_SINK === 'false') return false;
  if (isDisplayVideoSinkEnabled()) return true;
  const darwin =
    platform === 'darwin' ||
    (typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent));
  return darwin && stream.getVideoTracks().length > 0;
}

/** Diagnostic escape hatch: keep the session in compact chrome-only mode to isolate macOS loopback vs overlay expansion. */
function shouldExpandSessionOverlay(): boolean {
  return viteEnv.env?.VITE_OPENWHISPR_DISABLE_OVERLAY_EXPAND !== 'true';
}

function toSystemAudioStrategy(strategy: SystemCaptureStrategy): SystemAudioStrategy {
  return strategy;
}

/** Opt-in: VITE_VERBOSE_CAPTURE_DEBUG=true or localStorage openwhispr.verboseCaptureDebug=1 (default off in dev). */
function isVerboseCaptureDebug(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      const override = localStorage.getItem(VERBOSE_CAPTURE_STORAGE);
      if (override === '0') return false;
      if (override === '1') return true;
    }
  } catch {
    /* ignore storage */
  }
  return viteEnv.env?.VITE_VERBOSE_CAPTURE_DEBUG === 'true';
}

/** Opt-in: VITE_TRANSCRIPTION_TRACE=true or localStorage openwhispr.transcriptionTrace=1 (default off). */
function isTranscriptionTraceEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      const override = localStorage.getItem(TRANSCRIPTION_TRACE_STORAGE);
      if (override === '0') return false;
      if (override === '1') return true;
    }
  } catch {
    /* ignore storage */
  }
  return viteEnv.env?.VITE_TRANSCRIPTION_TRACE === 'true';
}

function transcriptionTrace(scope: string, data?: unknown) {
  if (!isTranscriptionTraceEnabled()) return;
  if (data === undefined) {
    console.log(`${TRACE_PREFIX} ${scope}`);
    return;
  }
  console.log(`${TRACE_PREFIX} ${scope} ${safeJson(data)}`);
}

function debug(scope: string, data?: unknown) {
  if (!isVerboseCaptureDebug()) return;
  if (data === undefined) {
    console.log(`${DEBUG_PREFIX} ${scope}`);
    return;
  }
  console.log(`${DEBUG_PREFIX} ${scope} ${safeJson(data)}`);
}

function captureDiag(scope: string, data?: unknown) {
  if (!isVerboseCaptureDebug()) return;
  if (data === undefined) {
    console.log(`${CRITICAL_CAPTURE_PREFIX} ${scope}`);
    return;
  }
  console.log(`${CRITICAL_CAPTURE_PREFIX} ${scope} ${safeJson(data)}`);
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

function formatTimer(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function loadSavedSessions(): DashboardSessionSummary[] {
  try {
    const raw = localStorage.getItem(SAVED_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DashboardSessionSummary[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((session) => typeof session.id === 'string' && typeof session.createdAt === 'number')
      .slice(0, 20);
  } catch {
    return [];
  }
}

function persistSavedSessions(sessions: DashboardSessionSummary[]) {
  localStorage.setItem(SAVED_SESSIONS_STORAGE_KEY, JSON.stringify(sessions.slice(0, 20)));
}

function createSessionTitle(createdAt: number) {
  return `Meeting ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(createdAt))}`;
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

function tailWords(text: string, maxWords: number): string {
  const words = splitWords(text);
  if (words.length <= maxWords) return text.trim();
  return joinWords(words.slice(-maxWords));
}

/** Anexa palabras a texto existente eliminando solape inicial (preview + cola final). */
function appendWordsDeduped(existingText: string, wordsToAppend: string[], maxOverlap = VISIBLE_APPEND_MAX_OVERLAP): string {
  const existingWords = splitWords(existingText);
  if (wordsToAppend.length === 0) return existingText.trim();

  const max = Math.min(maxOverlap, existingWords.length, wordsToAppend.length);
  let overlap = 0;
  for (let n = max; n >= 1; n -= 1) {
    const tail = existingWords.slice(-n).map(normalizeWord);
    const head = wordsToAppend.slice(0, n).map(normalizeWord);
    if (tail.every((w, i) => w === head[i])) {
      overlap = n;
      break;
    }
  }
  const finalWords = wordsToAppend.slice(overlap);
  if (finalWords.length === 0) return existingText.trim();
  const base = existingText.trim();
  return base ? `${base} ${joinWords(finalWords)}` : joinWords(finalWords);
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^\p{P}+|\p{P}+$/gu, '');
}

/** Cola de palabras ya visibles/pending vs inicio del nuevo preview (ventana móvil). */
function findBestWordOverlap(leftWords: string[], rightWords: string[], maxOverlap = 12): number {
  const max = Math.min(maxOverlap, leftWords.length, rightWords.length);
  for (let n = max; n >= 1; n -= 1) {
    const leftTail = leftWords.slice(leftWords.length - n).map(normalizeWord);
    const rightHead = rightWords.slice(0, n).map(normalizeWord);
    if (leftTail.every((w, i) => w === rightHead[i])) return n;
  }
  return 0;
}

/** Cola oculta derivada solo para debug (no estado). */
function debugHiddenTailFromRaw(raw: string): string {
  const words = splitWords(raw);
  if (words.length === 0) return '';
  return joinWords(words.slice(-PREVIEW_HIDDEN_TAIL_WORDS));
}

function capPendingPreviewWords(words: string[]): string[] {
  if (words.length <= MAX_PENDING_PREVIEW_WORDS) return words;
  return words.slice(0, MAX_PENDING_PREVIEW_WORDS);
}

/**
 * Alinea revelado del final con el borrador preview: `previewWordsLine` suele ser
 * visibleDraft + pendingWords (misma hipótesis aunque el typewriter aún no la pintó). Prefijo común ≥ MIN_COMMON_PREFIX_WORDS se fusiona ya; el resto va a la cola visual.
 */
function planFinalRevealMerge(
  finalText: string,
  previewWordsLine: string,
): { mergePrefixWords: string[]; queueTailWords: string[] } {
  const finalWords = splitWords(finalText);
  if (finalWords.length === 0) return { mergePrefixWords: [], queueTailWords: [] };
  const draftWords = splitWords(previewWordsLine.trim());
  if (draftWords.length === 0) {
    return { mergePrefixWords: [], queueTailWords: finalWords };
  }
  const nFinal = finalWords.map(normalizeWord);
  const nDraft = draftWords.map(normalizeWord);
  let k = 0;
  while (k < nDraft.length && k < nFinal.length && nDraft[k] === nFinal[k]) {
    k += 1;
  }
  if (k < PREVIEW_MIN_COMMON_PREFIX_WORDS) {
    return { mergePrefixWords: [], queueTailWords: finalWords };
  }
  return {
    mergePrefixWords: finalWords.slice(0, k),
    queueTailWords: finalWords.slice(k),
  };
}

/** Encola solo palabras nuevas tras solape cola↔cabeza; no borra visibleDraft (ventana móvil ASR). */
function mergeLiveVisualDraft(prev: LiveVisualDraft, newPreview: string, segmentId: string): LiveVisualDraft {
  const wordsNew = splitWords(newPreview);
  const candidateWords = wordsNew.slice(0, Math.max(0, wordsNew.length - PREVIEW_HIDDEN_TAIL_WORDS));

  if (segmentId !== prev.segmentId) {
    const initialWords = candidateWords.slice(0, MAX_NEW_PREVIEW_WORDS_PER_MERGE);
    return {
      segmentId,
      lastRawPreview: newPreview,
      visibleDraft: '',
      pendingWords: capPendingPreviewWords(initialWords),
    };
  }

  const alreadyWords = [...splitWords(prev.visibleDraft.trim()), ...prev.pendingWords];
  const overlap = findBestWordOverlap(alreadyWords, candidateWords, VISIBLE_APPEND_MAX_OVERLAP);

  let appendWords: string[] = [];
  if (overlap > 0) {
    appendWords = candidateWords.slice(overlap, overlap + MAX_NEW_PREVIEW_WORDS_PER_MERGE);
  } else if (alreadyWords.length === 0) {
    appendWords = candidateWords.slice(0, MAX_NEW_PREVIEW_WORDS_PER_MERGE);
  }

  return {
    ...prev,
    lastRawPreview: newPreview,
    pendingWords: capPendingPreviewWords([...prev.pendingWords, ...appendWords]),
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
  const [appMode, setAppMode] = useState<AppMode>('dashboard');
  const appModeRef = useRef<AppMode>(appMode);
  appModeRef.current = appMode;
  const [pendingSessionStart, setPendingSessionStart] = useState(false);
  const [sessionCaptureStarting, setSessionCaptureStarting] = useState(false);
  const pendingSessionStartRef = useRef(false);
  const [savedSessions, setSavedSessions] = useState<DashboardSessionSummary[]>(() => loadSavedSessions());
  const [selectedSavedSessionId, setSelectedSavedSessionId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<NodeJS.Platform | 'unknown'>('unknown');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [desktopSources, setDesktopSources] = useState<DesktopSource[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [selectedSystemInputId, setSelectedSystemInputId] = useState<string>(() => loadSelectedSystemInputId());
  const [systemCaptureStrategy, setSystemCaptureStrategy] = useState<SystemCaptureStrategy>(() => loadSystemCaptureStrategy());
  const [selectedOutputId, setSelectedOutputId] = useState<string>('');
  const [selectedDesktopSourceId, setSelectedDesktopSourceId] = useState<string>('');
  const [micPermission, setMicPermission] = useState<PermissionState | 'unknown'>('unknown');
  const [systemPermission, setSystemPermission] = useState<PermissionState | 'unknown'>('unknown');
  const [nativeMediaAccess, setNativeMediaAccess] = useState<{ microphone: string; screen: string } | null>(null);
  const [systemAudioHelperCheck, setSystemAudioHelperCheck] = useState<{
    ok: boolean;
    path?: string;
    error?: string;
    running?: boolean;
  } | null>(null);
  const [coreAudioTapHelperCheck, setCoreAudioTapHelperCheck] = useState<{
    ok: boolean;
    path?: string;
    error?: string;
    running?: boolean;
  } | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMode | null>(null);
  useEffect(() => {
    debug('app-mode:state', {
      appMode,
      captureMode,
      health: captureHealthRef.current,
      timestampMs: Date.now(),
      performanceMs: Number(performance.now().toFixed(1)),
    });
  }, [appMode, captureMode]);
  /** Fuentes que realmente quedaron capturando (p. ej. modo `both` con solo mic). */
  const [sessionAudioSources, setSessionAudioSources] = useState<{ mic: boolean; system: boolean }>({
    mic: false,
    system: false,
  });
  const [meters, setMeters] = useState<Record<SourceKey, MeterState>>({
    mic: initialMeter,
    system: initialMeter,
    mixed: initialMeter,
  });
  const metersRef = useRef<Record<SourceKey, MeterState>>({
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
  const [refinedTranscript, setRefinedTranscript] = useState<RefinedTranscriptState>({
    status: 'off',
    text: '',
    error: null,
    model: null,
    mode: 'off',
    updatedAt: null,
  });
  const [transcriptView, setTranscriptView] = useState<'live' | 'refined'>('live');
  const [chatMessages, setChatMessages] = useState<AssistantChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [setupWizardOpen, setSetupWizardOpen] = useState(() => !isOnboardingComplete());
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [settingsAudioScrollNonce, setSettingsAudioScrollNonce] = useState(0);
  const [homeConfirmOpen, setHomeConfirmOpen] = useState(false);
  const [capturePreference, setCapturePreference] = useState<CapturePreference>(() => loadCapturePreference());
  const [overlayCollapsed, setOverlayCollapsed] = useState(false);
  const [captureStartedAt, setCaptureStartedAt] = useState<number | null>(null);
  const [captureElapsedSeconds, setCaptureElapsedSeconds] = useState(0);
  const [captureHealthState, setCaptureHealthState] = useState<CaptureHealthState>(initialCaptureHealth);
  const [ledgerDebugGroups, setLedgerDebugGroups] = useState<LedgerDebugGroup[]>([]);
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscriptState>({
    committedText: '',
    unstableSuffix: '',
    lastReason: 'waiting',
    lastUpdatedAt: null,
  });
  const [liveVisualDraft, setLiveVisualDraft] = useState<LiveVisualDraft>(INITIAL_LIVE_VISUAL_DRAFT);
  /** Texto confirmado ya mostrado en la vista principal (oficial = `liveTranscript.committedText`). */
  const [visibleCommittedText, setVisibleCommittedText] = useState('');
  const [finalRevealQueue, setFinalRevealQueue] = useState<string[]>([]);
  const [whisperSetup, setWhisperSetup] = useState<WhisperSetupState | null>(null);
  const [polisherSetup, setPolisherSetup] = useState<PolisherSetupState | null>(null);
  const [glossary, setGlossary] = useState(DEFAULT_GLOSSARY);
  const [showRawDebug, setShowRawDebug] = useState(false);
  const showRawDebugRef = useRef(showRawDebug);
  showRawDebugRef.current = showRawDebug;
  const [transcriptViewMode, setTranscriptViewMode] = useState<TranscriptViewMode>('verbatim');
  const [promptMode, setPromptMode] = useState<WhisperPromptMode>('empty');
  const [whisperLanguage, setWhisperLanguage] = useState<'es' | 'auto'>('es');
  const [allowWhisperContext, setAllowWhisperContext] = useState(false);
  const asrPipelineMode = whisperSetup?.pipelineMode ?? 'baseline-whisper';
  const v2Mode = asrPipelineMode === 'moonshine-qwen-v2';
  const baselineMode = !v2Mode;
  const asrFinalEngine = whisperSetup?.finalEngine ?? 'whisper';
  const refinementMode = whisperSetup?.refinementMode ?? 'off';

  const allowWhisperContextRef = useRef(allowWhisperContext);
  const whisperLanguageRef = useRef(whisperLanguage);
  const asrPipelineModeRef = useRef<AsrPipelineMode>(asrPipelineMode);
  const refinementModeRef = useRef<TranscriptRefinementMode>(refinementMode);
  const moonshineConfiguredRef = useRef(Boolean(whisperSetup?.moonshineConfigured));
  allowWhisperContextRef.current = allowWhisperContext;
  whisperLanguageRef.current = whisperLanguage;
  asrPipelineModeRef.current = asrPipelineMode;
  refinementModeRef.current = refinementMode;
  moonshineConfiguredRef.current = Boolean(whisperSetup?.moonshineConfigured);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamsRef = useRef<Partial<Record<SourceKey, MediaStream>>>({});
  const analysersRef = useRef<Partial<Record<SourceKey, AnalyserNode>>>({});
  const graphNodesRef = useRef<AudioNode[]>([]);
  const displayVideoSinkRef = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<Partial<Record<SourceKey, number>>>({});
  const recordingChunksRef = useRef<Float32Array[]>([]);
  const recordingProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const transcriptionProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptionFirstFrameLoggedRef = useRef(false);
  const lastProcessorFrameAtRef = useRef<number | null>(null);
  const lastProcessorRmsTraceAtRef = useRef(0);
  const captureWatchdogRef = useRef<number | null>(null);
  /** Hasta este timestamp (ms): no `audio-ended` definitivo ni auto-recovery por churn de loopback/overlay. */
  const captureWatchdogGraceUntilRef = useRef(0);
  const audioEndedWatchdogStreakRef = useRef(0);
  const captureHealthRef = useRef<CaptureHealthState>(initialCaptureHealth);
  const lastAudioRmsAtRef = useRef<number | null>(null);
  const lastNonSilentAudioAtRef = useRef<number | null>(null);
  const audioTrackEndedAtRef = useRef<number | null>(null);
  const lastCaptureModeRef = useRef<CaptureMode | null>(null);
  const recoveryInFlightRef = useRef(false);
  const recoveryAttemptTimesRef = useRef<number[]>([]);
  const captureStopInProgressRef = useRef(false);
  const captureStartInProgressRef = useRef(false);
  /** Serializes all capture teardown/start (stopCapture + startCapture) to avoid macOS loopback double-stop races. */
  const captureLifecycleRef = useRef(Promise.resolve());
  const captureGenerationRef = useRef(0);
  const stoppedTracksRef = useRef<WeakSet<MediaStreamTrack>>(new WeakSet());
  const transcriptionSampleCursorRef = useRef<number>(0);
  const enqueueTranscriptionRef = useRef<(request: TranscriptionWindow) => void>(() => undefined);
  const nativeHelperChunkUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeHelperStatusUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeHelperActiveRef = useRef(false);
  const nativeHelperLastChunkAtRef = useRef<number | null>(null);
  const nativeHelperLastNonSilentAtRef = useRef<number | null>(null);
  const nativeHelperLastRmsRef = useRef(0);
  const nativeHelperLastPeakRef = useRef(0);
  const nativeHelperSampleCursorRef = useRef(0);
  const nativeHelperSegmentStartMsRef = useRef<number | null>(null);
  const nativeHelperSamplesRef = useRef<Float32Array>(new Float32Array(0));
  const coreTapChunkUnsubscribeRef = useRef<(() => void) | null>(null);
  const coreTapStatusUnsubscribeRef = useRef<(() => void) | null>(null);
  const coreTapActiveRef = useRef(false);
  /** Last wall time we forced a VAD segment for mic-only debug (`VITE_OPENWHISPR_FORCE_MIC_WINDOWS`). */
  const forceMicWindowLastAtRef = useRef(0);
  /** Session uses native PCM helper as sole system path (no MediaStream transcription). */
  const systemPcmHelperOnlyRef = useRef(false);
  const transcriptionBusyRef = useRef<boolean>(false);
  /** Cola unificada solo para `!SAFE_BASELINE`; en safeBaseline solo cola final (`pendingFinalWindowsRef`). */
  const pendingTranscriptionWindowsRef = useRef<TranscriptionWindow[]>([]);
  const finalBusyRef = useRef(false);
  const pendingFinalWindowsRef = useRef<TranscriptionWindow[]>([]);
  const previewBlockedByFinalCountRef = useRef(0);
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
  const pendingFinalRefinementSegmentsRef = useRef<RefinementSegmentInput[]>([]);
  const finalRefinementBusyRef = useRef(false);
  const cleanContextRef = useRef<string>('');
  const lastClippingWarningAtRef = useRef<number>(0);
  /** Solo `preview` | `final` mientras transcribeBlock está en vuelo (para cancelar solo previews). */
  const transcriptionInFlightModeRef = useRef<'preview' | 'final' | null>(null);
  const previewDroppedCountRef = useRef(0);
  const previewReplacedCountRef = useRef(0);
  const finalAcceptedCountRef = useRef(0);
  const previewSegmentOpenedAtRef = useRef<Map<string, number>>(new Map());
  const previewFirstSuccessRef = useRef<Set<string>>(new Set());
  /** Segmentos VAD ya cerrados con final aceptado (o descartado). */
  const finalizedSegmentIdsRef = useRef<Set<string>>(new Set());
  const liveTranscriptScrollRef = useRef<HTMLDivElement>(null);
  const stickNearBottomRef = useRef(true);
  const liveVisualDraftRef = useRef<LiveVisualDraft>(INITIAL_LIVE_VISUAL_DRAFT);
  const liveTranscriptRef = useRef<LiveTranscriptState>({
    committedText: '',
    unstableSuffix: '',
    lastReason: 'waiting',
    lastUpdatedAt: null,
  });
  const v2DemoStoreRef = useRef<ReturnType<typeof createTranscriptStore> | null>(null);
  if (v2DemoStoreRef.current === null) {
    v2DemoStoreRef.current = createTranscriptStore();
  }
  const [v2DemoTranscript, setV2DemoTranscript] = useState<TranscriptViewState>(() => v2DemoStoreRef.current!.getState());
  const v2MainStoreRef = useRef<ReturnType<typeof createTranscriptStore> | null>(null);
  if (v2MainStoreRef.current === null) {
    v2MainStoreRef.current = createTranscriptStore();
  }
  const [v2MainTranscript, setV2MainTranscript] = useState<TranscriptViewState>(() => v2MainStoreRef.current!.getState());
  const [v2MainFinalCount, setV2MainFinalCount] = useState(0);
  const [v2MainLastSegmentId, setV2MainLastSegmentId] = useState<string | null>(null);
  const v2ShadowStoreRef = useRef<ReturnType<typeof createTranscriptStore> | null>(null);
  if (v2ShadowStoreRef.current === null) {
    v2ShadowStoreRef.current = createTranscriptStore();
  }
  const [v2ShadowTranscript, setV2ShadowTranscript] = useState<TranscriptViewState>(() => v2ShadowStoreRef.current!.getState());
  const [v2ShadowFinalCount, setV2ShadowFinalCount] = useState(0);
  const [v2ShadowLastSegmentId, setV2ShadowLastSegmentId] = useState<string | null>(null);

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
    previewBusyLive: false,
    finalBusyLive: false,
    previewBlockedByFinalCount: 0,
  });

  const syncAsrLiveStats = useCallback((patch: Partial<typeof asrLiveStats>) => {
    setAsrLiveStats((prev) => {
      const p = pendingTranscriptionWindowsRef.current;
      const fq = pendingFinalWindowsRef.current;
      const isV2Pipeline = asrPipelineModeRef.current === 'moonshine-qwen-v2';
      return {
        ...prev,
        ...patch,
        previewQueueSize: SAFE_BASELINE && !isV2Pipeline ? 0 : p.filter((w) => w.mode === 'preview').length,
        finalQueueSize: SAFE_BASELINE && !isV2Pipeline ? fq.length : p.filter((w) => w.mode === 'final').length,
        previewDroppedCount: previewDroppedCountRef.current,
        previewReplacedCount: previewReplacedCountRef.current,
        finalAcceptedCount: finalAcceptedCountRef.current,
        previewBusyLive: SAFE_BASELINE && !isV2Pipeline ? false : (transcriptionBusyRef.current && transcriptionInFlightModeRef.current === 'preview'),
        finalBusyLive: SAFE_BASELINE && !isV2Pipeline ? finalBusyRef.current : (transcriptionBusyRef.current && transcriptionInFlightModeRef.current === 'final'),
        previewBlockedByFinalCount: previewBlockedByFinalCountRef.current,
      };
    });
  }, []);

  const updateV2DemoTranscript = useCallback((next: TranscriptViewState) => {
    setV2DemoTranscript(next);
  }, []);

  const runV2DemoPreviewOne = useCallback(() => {
    updateV2DemoTranscript(v2DemoStoreRef.current!.acceptPreview({
      segmentId: 'demo-segment-1',
      text: 'hola como estas ahora mismo',
    }));
  }, [updateV2DemoTranscript]);

  const runV2DemoPreviewTwo = useCallback(() => {
    updateV2DemoTranscript(v2DemoStoreRef.current!.acceptPreview({
      segmentId: 'demo-segment-1',
      text: 'hola como estas bien ahora',
    }));
  }, [updateV2DemoTranscript]);

  const runV2DemoDifferentPreview = useCallback(() => {
    updateV2DemoTranscript(v2DemoStoreRef.current!.acceptPreview({
      segmentId: 'demo-segment-1',
      text: 'esto cambio demasiado y no deberia reemplazar',
    }));
  }, [updateV2DemoTranscript]);

  const runV2DemoFinal = useCallback(() => {
    updateV2DemoTranscript(v2DemoStoreRef.current!.acceptFinal({
      segmentId: 'demo-segment-1',
      text: 'hola como estas bien',
    }));
  }, [updateV2DemoTranscript]);

  const resetV2Demo = useCallback(() => {
    updateV2DemoTranscript(v2DemoStoreRef.current!.reset());
  }, [updateV2DemoTranscript]);

  const resetV2Main = useCallback(() => {
    setV2MainTranscript(v2MainStoreRef.current!.reset());
    setV2MainFinalCount(0);
    setV2MainLastSegmentId(null);
  }, []);

  const acceptV2MainPreview = useCallback((segment: TranscriptSegment, segmentId: string) => {
    try {
      const next = v2MainStoreRef.current!.acceptPreview({
        segmentId,
        text: segment.text,
        engine: segment.engineUsed ?? 'moonshine',
      });
      setV2MainTranscript(next);
      setV2MainLastSegmentId(segmentId);
    } catch (error) {
      debug('v2-main-preview:error', {
        segmentId,
        error: String(error),
      });
    }
  }, []);

  const acceptV2MainFinal = useCallback((segment: TranscriptSegment, segmentId: string) => {
    try {
      const next = v2MainStoreRef.current!.acceptFinal({
        segmentId,
        text: segment.text,
        engine: segment.engineUsed ?? 'whisper-large-v3-turbo',
      });
      setV2MainTranscript(next);
      setV2MainFinalCount((count) => count + 1);
      setV2MainLastSegmentId(segmentId);
    } catch (error) {
      debug('v2-main-final:error', {
        segmentId,
        error: String(error),
      });
    }
  }, []);

  const runFinalRefinementBatch = useCallback((segments: RefinementSegmentInput[], mode: Exclude<TranscriptRefinementMode, 'off'>) => {
    if (segments.length === 0) return;
    if (!polisherSetup?.ok) {
      setRefinedTranscript((current) => ({
        ...current,
        status: 'error',
        mode,
        model: whisperSetup?.refinerModel ?? polisherSetup?.model ?? null,
        error: polisherSetup?.message ?? 'Refiner no disponible.',
      }));
      return;
    }
    finalRefinementBusyRef.current = true;
    const batchId = `final-refine-${Date.now()}-${segments.at(-1)?.endMs ?? 0}`;
    const prompt = buildFinalTranscriptRefinementPrompt({
      batchId,
      segments,
      mode,
      glossary,
      context: cleanContextRef.current.slice(-1400),
      language: 'Spanish',
    });
    setRefinedTranscript((current) => ({
      ...current,
      status: 'generating',
      mode,
      model: whisperSetup?.refinerModel ?? polisherSetup.model,
      error: null,
    }));
    window.meetingAssistant.polisher.polishSegment({
      batchId,
      rawSegments: segments.map((segment) => ({
        id: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.whisperText,
        qwenText: segment.qwenText,
        source: segment.source,
        rms: 0.1,
      })),
      context: cleanContextRef.current.slice(-1400),
      glossary,
      refinementMode: mode,
      prompt,
    }).then((result) => {
      if (!result.ok || !(result.text ?? '').trim()) {
        setRefinedTranscript((current) => ({
          ...current,
          status: 'error',
          error: result.error ?? 'Refiner sin texto.',
          updatedAt: Date.now(),
        }));
        return;
      }
      const text = (result.text ?? '').trim();
      cleanContextRef.current = `${cleanContextRef.current} ${text}`.trim();
      setRefinedTranscript((current) => ({
        status: 'ready',
        text: `${current.text} ${text}`.trim(),
        error: null,
        model: whisperSetup?.refinerModel ?? polisherSetup.model,
        mode,
        updatedAt: Date.now(),
      }));
    }).catch((error) => {
      setRefinedTranscript((current) => ({
        ...current,
        status: 'error',
        error: String(error),
        updatedAt: Date.now(),
      }));
    }).finally(() => {
      finalRefinementBusyRef.current = false;
      const pending = pendingFinalRefinementSegmentsRef.current;
      if (shouldCreateRefinementBatch({
        mode: refinementModeRef.current,
        pendingSegmentCount: pending.length,
        pendingDurationMs: pending.length > 0 ? pending[pending.length - 1].endMs - pending[0].startMs : 0,
      })) {
        pendingFinalRefinementSegmentsRef.current = [];
        runFinalRefinementBatch(pending, refinementModeRef.current as Exclude<TranscriptRefinementMode, 'off'>);
      }
    });
  }, [glossary, polisherSetup, whisperSetup?.refinerModel]);

  const queueFinalRefinementSegment = useCallback((segment: TranscriptSegment, segmentId: string) => {
    const mode = refinementModeRef.current;
    if (mode === 'off') {
      setRefinedTranscript((current) => current.status === 'off' ? current : { ...current, status: 'off', mode, error: null });
      return;
    }
    const whisperText = (segment.whisperText ?? segment.text).trim();
    if (!whisperText) return;
    const nextSegment: RefinementSegmentInput = {
      id: segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      whisperText,
      qwenText: mode === 'whisper-qwen' ? segment.qwenText : undefined,
      source: segment.source,
    };
    pendingFinalRefinementSegmentsRef.current = [...pendingFinalRefinementSegmentsRef.current, nextSegment];
    const pending = pendingFinalRefinementSegmentsRef.current;
    const pendingDurationMs = pending[pending.length - 1].endMs - pending[0].startMs;
    setRefinedTranscript((current) => ({
      ...current,
      status: current.text ? current.status : 'idle',
      mode,
      model: whisperSetup?.refinerModel ?? polisherSetup?.model ?? null,
      error: null,
    }));
    if (finalRefinementBusyRef.current) return;
    if (!shouldCreateRefinementBatch({ mode, pendingSegmentCount: pending.length, pendingDurationMs })) return;
    pendingFinalRefinementSegmentsRef.current = [];
    runFinalRefinementBatch(pending, mode);
  }, [polisherSetup?.model, runFinalRefinementBatch, whisperSetup?.refinerModel]);

  const resetV2Shadow = useCallback(() => {
    setV2ShadowTranscript(v2ShadowStoreRef.current!.reset());
    setV2ShadowFinalCount(0);
    setV2ShadowLastSegmentId(null);
  }, []);

  const acceptV2ShadowFinal = useCallback((segment: TranscriptSegment, segmentId: string) => {
    if (!V2_TRANSCRIPT_STORE_SHADOW) return;
    try {
      const next = v2ShadowStoreRef.current!.acceptFinal({
        segmentId,
        text: segment.text,
        engine: 'whisper-large-v3-turbo',
      });
      setV2ShadowTranscript(next);
      setV2ShadowFinalCount((count) => count + 1);
      setV2ShadowLastSegmentId(segmentId);
    } catch (error) {
      debug('v2-shadow:error', {
        segmentId,
        error: String(error),
      });
    }
  }, []);

  const macSystemFallbackText =
    'Para capturar audio del sistema en este Mac cuando Electron loopback falla, instala BlackHole, enruta la salida del sistema hacia BlackHole y selecciona BlackHole como entrada virtual.';

  const virtualSystemInputs = useMemo(() => {
    const candidates: SystemAudioDeviceCandidate[] = inputDevices.map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label || '',
    }));
    const allowedIds = new Set(filterVirtualSystemInputCandidates(candidates).map((c) => c.deviceId));
    return inputDevices.filter((device) => allowedIds.has(device.deviceId));
  }, [inputDevices]);

  useEffect(() => {
    persistSelectedSystemInputId(selectedSystemInputId);
  }, [selectedSystemInputId]);

  useEffect(() => {
    if (!selectedSystemInputId) return;
    if (!virtualSystemInputs.some((d) => d.deviceId === selectedSystemInputId)) {
      setSelectedSystemInputId('');
    }
  }, [selectedSystemInputId, virtualSystemInputs]);

  useEffect(() => {
    persistSystemCaptureStrategy(systemCaptureStrategy);
  }, [systemCaptureStrategy]);

  const liveCleanText = useMemo(() => cleanSegments.map((segment) => segment.cleanText).join(' ').trim(), [cleanSegments]);

  const addLog = useCallback((message: string) => {
    debug('ui-log', message);
    setDiagnosticLog((current) => [`${new Date().toLocaleTimeString()} - ${message}`, ...current].slice(0, 50));
  }, []);

  const patchCaptureHealth = useCallback((patch: Partial<CaptureHealthState>) => {
    const next = { ...captureHealthRef.current, ...patch };
    captureHealthRef.current = next;
    setCaptureHealthState(next);
  }, []);

  const visibleTranscriptText = useMemo(() => {
    if (v2Mode) return v2MainTranscript.visibleText.trim();
    const baselineText = [visibleCommittedText, liveVisualDraft.visibleDraft].filter(Boolean).join(' ').trim();
    return baselineText || liveTranscript.committedText.trim() || liveCleanText;
  }, [liveCleanText, liveTranscript.committedText, liveVisualDraft.visibleDraft, v2MainTranscript.visibleText, v2Mode, visibleCommittedText]);

  const askLocalAssistant = useCallback((questionOverride?: string) => {
    const question = (questionOverride ?? chatInput).trim() || DEFAULT_AI_CONTEXT_PROMPT;
    if (!question || chatBusy) return;
    const userMessage: AssistantChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: question,
    };
    setChatMessages((current) => [...current, userMessage]);
    setChatInput('');
    setAiPanelOpen(true);
    setChatError(null);
    setChatBusy(true);
    const startedAt = Date.now();
    debug('assistant:ask-start', {
      recording: Boolean(captureMode),
      captureHealth: captureHealthRef.current.captureHealth,
    });
    const rawContext = [
      visibleTranscriptText,
      rawSegments.slice(-10).map((segment) => segment.whisperText ?? segment.text).join(' '),
    ].join(' ').replace(/\s+/g, ' ').trim().slice(-8000);
    window.meetingAssistant.assistant.ask({
      question,
      transcriptContext: rawContext,
      refinedContext: refinedTranscript.text.slice(-4000),
    }).then((result) => {
      if (!result.ok || !(result.text ?? '').trim()) {
        debug('assistant:ask-error', {
          durationMs: Date.now() - startedAt,
          recording: Boolean(captureMode),
          captureHealth: captureHealthRef.current.captureHealth,
          error: result.error ?? 'empty-response',
        });
        setChatError(result.error ?? 'No pude responder con la IA local. Revisa que Gemma esté disponible.');
        return;
      }
      setChatMessages((current) => [...current, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: (result.text ?? '').trim(),
      }]);
      debug('assistant:ask-end', {
        durationMs: Date.now() - startedAt,
        recording: Boolean(captureMode),
        captureHealth: captureHealthRef.current.captureHealth,
      });
    }).catch(() => {
      debug('assistant:ask-error', {
        durationMs: Date.now() - startedAt,
        recording: Boolean(captureMode),
        captureHealth: captureHealthRef.current.captureHealth,
      });
      setChatError('No pude responder con la IA local. Revisa que Gemma esté disponible.');
    }).finally(() => {
      setChatBusy(false);
    });
  }, [captureMode, chatBusy, chatInput, rawSegments, refinedTranscript.text, visibleTranscriptText]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
  }, []);

  const copyTranscript = useCallback(async () => {
    const useRefined = transcriptView === 'refined' && Boolean(refinedTranscript.text.trim());
    const text = useRefined ? refinedTranscript.text.trim() : visibleTranscriptText.trim();
    if (!text) {
      showToast('Aún no hay transcripción');
      return;
    }
    const ok = await copyToClipboard(text);
    if (ok) {
      showToast('Transcripción copiada al portapapeles');
    } else {
      debug('clipboard:transcript-failed');
      showToast('No se pudo copiar. Prueba de nuevo tras hacer clic en la ventana.');
    }
  }, [refinedTranscript.text, showToast, transcriptView, visibleTranscriptText]);

  const copyLastAiResponse = useCallback(async () => {
    const lastResponse = [...chatMessages].reverse().find((message) => message.role === 'assistant')?.text.trim();
    if (!lastResponse) return;
    const ok = await copyToClipboard(lastResponse);
    if (!ok) {
      debug('clipboard:ai-error');
    }
  }, [chatMessages]);

  const clearSavedSessions = useCallback(() => {
    setSavedSessions([]);
    setSelectedSavedSessionId(null);
  }, []);

  const patchMeter = useCallback((source: SourceKey, patch: Partial<MeterState>) => {
    setMeters((current) => {
      const next = {
        ...current,
        [source]: {
          ...current[source],
          ...patch,
        },
      };
      metersRef.current = next;
      return next;
    });
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
      setSelectedDesktopSourceId((current) => {
        if (current?.startsWith('screen:')) return current;
        return sources.find((source) => source.id.startsWith('screen:'))?.id || '';
      });
      if (error) addLog(error);
    } catch (error) {
      addLog(`system: no se pudieron listar fuentes de pantalla (${String(error)})`);
    }
  }, [addLog]);

  useEffect(() => {
    if (selectedDesktopSourceId && !selectedDesktopSourceId.startsWith('screen:')) {
      debug('display-capture:renderer-ignore-window-source', { selectedDesktopSourceId });
      window.meetingAssistant.displayCapture.setPreferredSourceId(null);
      return;
    }
    window.meetingAssistant.displayCapture.setPreferredSourceId(
      selectedDesktopSourceId.trim() ? selectedDesktopSourceId : null,
    );
  }, [selectedDesktopSourceId]);

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

  const refreshSystemAudioHelperCheck = useCallback(async () => {
    try {
      const result = await window.meetingAssistant.systemAudioHelper.check();
      setSystemAudioHelperCheck(result);
      debug('system-audio-helper:check-ui', result);
    } catch (error) {
      const result = { ok: false, error: String(error) };
      setSystemAudioHelperCheck(result);
      debug('system-audio-helper:check-ui-error', String(error));
    }
  }, []);

  const refreshCoreAudioTapHelperCheck = useCallback(async () => {
    try {
      const result = await window.meetingAssistant.coreAudioTapHelper.check();
      setCoreAudioTapHelperCheck(result);
      debug('core-audio-tap-helper:check-ui', result);
    } catch (error) {
      const result = { ok: false, error: String(error) };
      setCoreAudioTapHelperCheck(result);
      debug('core-audio-tap-helper:check-ui-error', String(error));
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
    void refreshSystemAudioHelperCheck();
    void refreshCoreAudioTapHelperCheck();
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
  }, [addLog, refreshCoreAudioTapHelperCheck, refreshDesktopSources, refreshDevices, refreshPermissions, refreshSystemAudioHelperCheck]);

  useLayoutEffect(() => {
    if (!SAFE_BASELINE) return;
    const el = liveTranscriptScrollRef.current;
    if (!el || !stickNearBottomRef.current) return;
    requestAnimationFrame(() => {
      const box = liveTranscriptScrollRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    });
  }, [liveTranscript.committedText, visibleCommittedText, liveVisualDraft.visibleDraft, liveVisualDraft.pendingWords.length, liveVisualDraft.segmentId, finalRevealQueue.length]);

  useEffect(() => {
    if (SAFE_BASELINE) return;
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
  }, [liveVisualDraft.pendingWords.length, SAFE_BASELINE]);

  useEffect(() => {
    liveVisualDraftRef.current = liveVisualDraft;
  }, [liveVisualDraft]);

  useEffect(() => {
    liveTranscriptRef.current = liveTranscript;
  }, [liveTranscript]);

  useEffect(() => {
    captureHealthRef.current = captureHealthState;
  }, [captureHealthState]);

  useEffect(() => {
    persistSavedSessions(savedSessions);
  }, [savedSessions]);

  useLayoutEffect(() => {
    const t = readDashboardTheme();
    const html = document.documentElement;
    if (t === 'dark') {
      html.setAttribute('data-dashboard-theme', 'dark');
      html.style.colorScheme = 'dark';
    } else {
      html.removeAttribute('data-dashboard-theme');
      html.style.colorScheme = 'light';
    }
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const overlayCapable = window.meetingAssistant.overlayWindow;

    if (appMode === 'session' && overlayCapable) {
      root.classList.remove('openwhispr-dashboard-window');
      body.classList.remove('openwhispr-dashboard-window');
      root.classList.remove('openwhispr-session-boot-window');
      body.classList.remove('openwhispr-session-boot-window');
      root.classList.add('openwhispr-overlay-window');
      body.classList.add('openwhispr-overlay-window');
      transcriptionTrace('layout:session', {
        htmlClass: root.className,
        overlayCapable,
      });
    } else if (appMode === 'session-boot' && overlayCapable) {
      root.classList.remove('openwhispr-overlay-window');
      body.classList.remove('openwhispr-overlay-window');
      root.classList.remove('openwhispr-dashboard-window');
      body.classList.remove('openwhispr-dashboard-window');
      root.classList.add('openwhispr-session-boot-window');
      body.classList.add('openwhispr-session-boot-window');
      void window.meetingAssistant.windowControls.setAppMode('session-boot');
      try {
        performance.clearMarks('openwhispr-session-boot-render');
        performance.mark('openwhispr-session-boot-render');
      } catch {
        /* ignore */
      }
      transcriptionTrace('layout:session-boot', { htmlClass: root.className, overlayCapable });
    } else {
      root.classList.remove('openwhispr-overlay-window');
      body.classList.remove('openwhispr-overlay-window');
      root.classList.remove('openwhispr-session-boot-window');
      body.classList.remove('openwhispr-session-boot-window');
      if (overlayCapable) {
        root.classList.add('openwhispr-dashboard-window');
        body.classList.add('openwhispr-dashboard-window');
        window.meetingAssistant.overlay.setPointerPassthrough(false);
        void window.meetingAssistant.windowControls.setAppMode('dashboard');
      } else {
        root.classList.remove('openwhispr-dashboard-window');
        body.classList.remove('openwhispr-dashboard-window');
      }
      transcriptionTrace('layout:dashboard', { appMode, overlayCapable });
    }
  }, [appMode]);

  useEffect(() => {
    if (!captureMode || captureStartedAt === null) {
      setCaptureElapsedSeconds(0);
      return undefined;
    }
    const updateElapsed = () => {
      setCaptureElapsedSeconds(Math.max(0, Math.floor((Date.now() - captureStartedAt) / 1000)));
    };
    updateElapsed();
    const id = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(id);
  }, [captureMode, captureStartedAt]);

  useEffect(() => {
    if (SAFE_BASELINE) return;
    if (finalRevealQueue.length === 0) return;
    const id = window.setInterval(() => {
      setFinalRevealQueue((q) => {
        if (q.length === 0) return q;
        const n =
          q.length > FINAL_REVEAL_CATCHUP_THRESHOLD
            ? FINAL_REVEAL_CATCHUP_WORDS_PER_TICK
            : FINAL_REVEAL_WORDS_PER_TICK;
        const take = q.slice(0, n);
        const rest = q.slice(n);
        const chunk = take.join(' ');
        queueMicrotask(() => {
          setVisibleCommittedText((vc) => appendWordsDeduped(vc, take));
        });
        return rest;
      });
    }, FINAL_REVEAL_WORD_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [finalRevealQueue.length, SAFE_BASELINE]);

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

  async function ensureRunningAudioContext() {
    const ctx = ensureAudioContext();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
        debug('audio-context:resumed', { state: ctx.state });
      } catch (error) {
        debug('audio-context:resume-error', String(error));
      }
    }
    return ctx;
  }

  const connectAnalyser = useCallback(
    (stream: MediaStream, source: SourceKey) => {
      const audioContext = ensureAudioContext();
      debug(`stream:${source}:connect-analyser`, describeStream(stream));
      stream.getTracks().forEach((track) => {
        const trackPayload = (eventName: string) => ({
          eventName,
          source,
          appMode: appModeRef.current,
          captureMode: lastCaptureModeRef.current,
          generation: captureGenerationRef.current,
          stopInProgress: captureStopInProgressRef.current,
          recoveryInFlight: recoveryInFlightRef.current,
          timestampMs: Date.now(),
          performanceMs: Number(performance.now().toFixed(1)),
          stream: describeStream(stream),
          track: describeTrack(track),
        });
        track.addEventListener('mute', () => {
          const payload = trackPayload('mute');
          debug(`track:${source}:mute`, payload);
          if (track.kind === 'audio') {
            patchCaptureHealth({
              audioTrackMuted: true,
              audioTrackReadyState: track.readyState,
              lastCheckedAt: Date.now(),
              message: 'El audio está silenciado.',
            });
            addLog(`${source}: audio muted (${track.label || track.id})`);
          }
        });
        track.addEventListener('unmute', () => {
          const payload = trackPayload('unmute');
          debug(`track:${source}:unmute`, payload);
          if (track.kind === 'audio') {
            patchCaptureHealth({
              audioTrackMuted: false,
              audioTrackReadyState: track.readyState,
              captureHealth: ['failed', 'recovering', 'audio-ended'].includes(captureHealthRef.current.captureHealth)
                ? captureHealthRef.current.captureHealth
                : 'ok',
              lastCheckedAt: Date.now(),
              message: captureHealthRef.current.captureHealth === 'audio-ended' ? captureHealthRef.current.message : null,
            });
            addLog(`${source}: audio activo (${track.label || track.id})`);
          }
        });
        track.addEventListener('ended', () => {
          const payload = trackPayload('ended');
          captureDiag(`track:${source}:ended`, payload);
          debug(`track:${source}:ended`, payload);
          if (track.kind === 'audio') {
            const endedAt = Date.now();
            audioTrackEndedAtRef.current = endedAt;
            const inGrace = endedAt < captureWatchdogGraceUntilRef.current;
            patchCaptureHealth({
              audioTrackReadyState: 'ended',
              audioTrackMuted: track.muted,
              audioTrackEndedAt: endedAt,
              lastCheckedAt: endedAt,
              message: inGrace || captureStopInProgressRef.current
                ? captureHealthRef.current.message
                : 'El audio parece haberse interrumpido; verificando la mezcla antes de reconectar.',
            });
            addLog(`${source}: audio finalizó (${track.label || track.id})`);
          }
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
    [addLog, ensureAudioContext, patchCaptureHealth, patchMeter],
  );

  const startMeterLoop = useCallback(() => {
    if (animationFrameRef.current) return;
    let lastMeterDebugAt = 0;
    const tick = () => {
      const now = performance.now();
      const nowWall = Date.now();
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
        const mode = lastCaptureModeRef.current;
        const watchesSystem = mode === 'system' || mode === 'both';
        const isPrimaryAudioMeter =
          source === liveTranscriptionSourceRef.current ||
          (watchesSystem && source === 'system') ||
          (mode === 'mic' && source === 'mic');
        if (isPrimaryAudioMeter) {
          lastAudioRmsAtRef.current = nowWall;
          if (rms >= SILENCE_THRESHOLD) {
            lastNonSilentAudioAtRef.current = nowWall;
          }
        }
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

  function runCaptureLifecycle<T>(label: string, task: () => Promise<T>): Promise<T> {
    const run = captureLifecycleRef.current
      .catch(() => undefined)
      .then(async () => {
        debug(`capture:lifecycle:${label}:start`);
        try {
          const result = await task();
          debug(`capture:lifecycle:${label}:end`);
          return result;
        } catch (error) {
          debug(`capture:lifecycle:${label}:error`, String(error));
          throw error;
        }
      });
    captureLifecycleRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function stopTrackOnce(track: MediaStreamTrack, source: string) {
    if (stoppedTracksRef.current.has(track)) return;
    stoppedTracksRef.current.add(track);
    if (track.readyState === 'ended') {
      debug(`track:${source}:stop-skip-ended`, describeTrack(track));
      return;
    }
    try {
      track.stop();
      debug(`track:${source}:stopped`, describeTrack(track));
    } catch (error) {
      debug(`track:${source}:stop-error`, String(error));
    }
  }

  async function closeAudioContextOnce() {
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (!ctx || ctx.state === 'closed') return;
    try {
      await ctx.close();
      debug('audio-context:closed');
    } catch (error) {
      debug('audio-context:close-error', String(error));
    }
  }

  function detachDisplayVideoSink(reason: string) {
    const sink = displayVideoSinkRef.current;
    displayVideoSinkRef.current = null;
    if (!sink) return;
    try {
      sink.pause();
      sink.srcObject = null;
      sink.remove();
      debug('capture:system:video-sink:detached', { reason });
    } catch (error) {
      debug('capture:system:video-sink:detach-error', { reason, error: String(error) });
    }
  }

  function attachDisplayVideoSink(stream: MediaStream) {
    if (!shouldAttachDisplayVideoSink(stream, platform)) return;
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      debug('capture:system:video-sink:skip', { reason: 'no-video-track', stream: describeStream(stream) });
      return;
    }
    detachDisplayVideoSink('replace');
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.position = 'fixed';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.style.left = '-10px';
    video.style.top = '-10px';
    video.srcObject = stream;
    document.body.appendChild(video);
    displayVideoSinkRef.current = video;
    void video.play()
      .then(() => {
        captureDiag('capture:system:video-sink:playing', { stream: describeStream(stream) });
        debug('capture:system:video-sink:playing', { stream: describeStream(stream) });
      })
      .catch((error) => {
        captureDiag('capture:system:video-sink:play-error', String(error));
        debug('capture:system:video-sink:play-error', String(error));
      });
  }

  const stopCaptureCore = useCallback(async (options?: { preserveSession?: boolean; reason?: string }) => {
    const startedAt = Date.now();
    captureStopInProgressRef.current = true;
    const stopPayload = {
      reason: options?.reason ?? null,
      preserveSession: Boolean(options?.preserveSession),
      generation: captureGenerationRef.current,
      streams: Object.fromEntries(
        Object.entries(streamsRef.current).map(([source, stream]) => [source, stream ? describeStream(stream) : null]),
      ),
    };
    captureDiag('capture:stop-core:start', stopPayload);
    debug('capture:stop-core:start', stopPayload);
    if (nativeHelperActiveRef.current || nativeHelperChunkUnsubscribeRef.current || nativeHelperStatusUnsubscribeRef.current) {
      nativeHelperChunkUnsubscribeRef.current?.();
      nativeHelperChunkUnsubscribeRef.current = null;
      nativeHelperStatusUnsubscribeRef.current?.();
      nativeHelperStatusUnsubscribeRef.current = null;
      nativeHelperActiveRef.current = false;
      nativeHelperSamplesRef.current = new Float32Array(0);
      nativeHelperSampleCursorRef.current = 0;
      nativeHelperSegmentStartMsRef.current = null;
      nativeHelperLastChunkAtRef.current = null;
      nativeHelperLastNonSilentAtRef.current = null;
      nativeHelperLastRmsRef.current = 0;
      nativeHelperLastPeakRef.current = 0;
      void window.meetingAssistant.systemAudioHelper.stop().catch((error) => {
        debug('system-audio-helper:stop-error', String(error));
      });
    }
    if (coreTapActiveRef.current || coreTapChunkUnsubscribeRef.current || coreTapStatusUnsubscribeRef.current) {
      coreTapChunkUnsubscribeRef.current?.();
      coreTapChunkUnsubscribeRef.current = null;
      coreTapStatusUnsubscribeRef.current?.();
      coreTapStatusUnsubscribeRef.current = null;
      coreTapActiveRef.current = false;
      nativeHelperSamplesRef.current = new Float32Array(0);
      nativeHelperSampleCursorRef.current = 0;
      nativeHelperSegmentStartMsRef.current = null;
      nativeHelperLastChunkAtRef.current = null;
      nativeHelperLastNonSilentAtRef.current = null;
      nativeHelperLastRmsRef.current = 0;
      nativeHelperLastPeakRef.current = 0;
      void window.meetingAssistant.coreAudioTapHelper.stop().catch((error) => {
        debug('core-audio-tap-helper:stop-error', String(error));
      });
    }
    stopMeterLoop();
    if (captureWatchdogRef.current !== null) {
      window.clearInterval(captureWatchdogRef.current);
      captureWatchdogRef.current = null;
    }

    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;

    try {
      recordingProcessorRef.current?.disconnect();
    } catch {
      /* noop */
    }
    recordingProcessorRef.current = null;

    try {
      transcriptionProcessorRef.current?.disconnect();
    } catch {
      /* noop */
    }
    transcriptionProcessorRef.current = null;
    transcriptionSampleCursorRef.current = 0;
    lastProcessorFrameAtRef.current = null;
    lastProcessorRmsTraceAtRef.current = 0;
    transcriptionBusyRef.current = false;
    transcriptionInFlightModeRef.current = null;
    pendingTranscriptionWindowsRef.current = [];
    pendingFinalWindowsRef.current = [];
    finalBusyRef.current = false;
    previewBlockedByFinalCountRef.current = 0;
    vadRef.current.reset();
    vadShortAccumRef.current = null;
    activeSegmentIdRef.current = null;
    lastPreviewPerfMsRef.current = 0;
    previewSegmentOpenedAtRef.current.clear();
    previewFirstSuccessRef.current.clear();
    finalizedSegmentIdsRef.current.clear();
    if (!options?.preserveSession) {
      setVisibleCommittedText(liveTranscriptRef.current.committedText);
      setFinalRevealQueue([]);
      setLiveVisualDraft(INITIAL_LIVE_VISUAL_DRAFT);
    }
    pendingPolishJobRef.current = null;
    void window.meetingAssistant.transcription.cancelPending().catch((error) => {
      debug('transcription:cancel:error', String(error));
    });
    setRecording(false);
    lastCaptureModeRef.current = null;
    if (!options?.preserveSession) {
      setCaptureStartedAt(null);
      setCaptureElapsedSeconds(0);
    }

    const streams = streamsRef.current;
    streamsRef.current = {};
    analysersRef.current = {};
    silenceStartRef.current = {};
    detachDisplayVideoSink('stop-capture-core');

    Object.entries(streams).forEach(([source, stream]) => {
      stream?.getTracks().forEach((track) => stopTrackOnce(track, source));
    });

    graphNodesRef.current.forEach((node) => {
      try {
        node.disconnect();
      } catch {
        /* noop */
      }
    });
    graphNodesRef.current = [];

    await closeAudioContextOnce();

    setCaptureMode(null);
    const stoppedMeters: Record<SourceKey, MeterState> = {
      mic: { ...initialMeter, status: 'stopped' },
      system: { ...initialMeter, status: 'stopped' },
      mixed: { ...initialMeter, status: 'stopped' },
    };
    metersRef.current = stoppedMeters;
    setMeters(stoppedMeters);
    setSessionAudioSources({ mic: false, system: false });
    systemPcmHelperOnlyRef.current = false;
    captureWatchdogGraceUntilRef.current = 0;
    audioEndedWatchdogStreakRef.current = 0;
    if (!options?.preserveSession) {
      patchCaptureHealth({ ...initialCaptureHealth, lastCheckedAt: Date.now() });
      lastAudioRmsAtRef.current = null;
      lastNonSilentAudioAtRef.current = null;
      audioTrackEndedAtRef.current = null;
      recoveryAttemptTimesRef.current = [];
    }
    addLog(options?.reason ?? 'captura detenida');
    const stopEndPayload = {
      reason: options?.reason ?? null,
      durationMs: Date.now() - startedAt,
      preserveSession: Boolean(options?.preserveSession),
    };
    captureDiag('capture:stop-core:end', stopEndPayload);
    debug('capture:stop-core:end', stopEndPayload);
    captureStopInProgressRef.current = false;
  }, [addLog, patchCaptureHealth, stopMeterLoop]);

  const stopCapture = useCallback(
    (options?: { preserveSession?: boolean; reason?: string }) =>
      runCaptureLifecycle('stop', () => stopCaptureCore(options)),
    [stopCaptureCore],
  );

  const captureMic = useCallback(async () => {
    patchMeter('mic', { status: 'requesting_permission', error: null });

    const knownMic = selectedMicId
      ? inputDevices.find((device) => device.kind === 'audioinput' && device.deviceId === selectedMicId)
      : undefined;

    const makeConstraints = (deviceId?: string): MediaStreamConstraints => ({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });

    const attempts: Array<{ label: string; constraints: MediaStreamConstraints }> = [];

    if (knownMic?.deviceId) {
      attempts.push({ label: 'selected-exact', constraints: makeConstraints(knownMic.deviceId) });
    } else if (selectedMicId) {
      debug('capture:mic:selected-device-missing', { selectedMicId });
    }

    attempts.push({ label: 'default', constraints: makeConstraints() });

    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        debug('capture:mic:constraints', { attempt: attempt.label, constraints: attempt.constraints });
        const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
        debug('capture:mic:stream', describeStream(stream));
        if (stream.getAudioTracks().length === 0) {
          throw new Error('empty-stream: no audio tracks returned for microphone');
        }
        streamsRef.current.mic = stream;
        connectAnalyser(stream, 'mic');
        await refreshDevices();
        await refreshPermissions();
        addLog(
          attempt.label === 'default'
            ? 'mic: captura iniciada con micrófono por defecto'
            : 'mic: captura iniciada',
        );
        return stream;
      } catch (error) {
        lastError = error;
        debug('capture:mic:attempt-error', { attempt: attempt.label, error: String(error) });
      }
    }

    const message = `permission/device: no se pudo capturar micrófono (${String(lastError)})`;
    patchMeter('mic', { status: 'failed', error: message });
    addLog(message);
    throw lastError;
  }, [addLog, connectAnalyser, inputDevices, patchMeter, refreshDevices, refreshPermissions, selectedMicId]);

  const resetNativeHelperBuffers = useCallback(() => {
    nativeHelperSamplesRef.current = new Float32Array(0);
    nativeHelperSampleCursorRef.current = 0;
    nativeHelperSegmentStartMsRef.current = null;
    nativeHelperLastChunkAtRef.current = null;
    nativeHelperLastNonSilentAtRef.current = null;
    nativeHelperLastRmsRef.current = 0;
    nativeHelperLastPeakRef.current = 0;
  }, []);

  const stopNativeSystemAudioHelper = useCallback((reason: string) => {
    nativeHelperChunkUnsubscribeRef.current?.();
    nativeHelperChunkUnsubscribeRef.current = null;
    nativeHelperStatusUnsubscribeRef.current?.();
    nativeHelperStatusUnsubscribeRef.current = null;
    nativeHelperActiveRef.current = false;
    resetNativeHelperBuffers();
    captureDiag('system-audio-helper:stop-request', { reason, generation: captureGenerationRef.current });
    debug('system-audio-helper:stop-request', { reason, generation: captureGenerationRef.current });
    void window.meetingAssistant.systemAudioHelper.stop().catch((error) => {
      debug('system-audio-helper:stop-error', String(error));
    });
  }, [resetNativeHelperBuffers]);

  const stopCoreAudioTapHelper = useCallback((reason: string) => {
    coreTapChunkUnsubscribeRef.current?.();
    coreTapChunkUnsubscribeRef.current = null;
    coreTapStatusUnsubscribeRef.current?.();
    coreTapStatusUnsubscribeRef.current = null;
    coreTapActiveRef.current = false;
    resetNativeHelperBuffers();
    captureDiag('core-audio-tap-helper:stop-request', { reason, generation: captureGenerationRef.current });
    debug('core-audio-tap-helper:stop-request', { reason, generation: captureGenerationRef.current });
    void window.meetingAssistant.coreAudioTapHelper.stop().catch((error) => {
      debug('core-audio-tap-helper:stop-error', String(error));
    });
  }, [resetNativeHelperBuffers]);

  const flushNativeHelperWindow = useCallback((force = false) => {
    const sampleRate = 48_000;
    const minSamples = Math.floor((MIN_FINAL_AUDIO_MS / 1000) * sampleRate);
    const targetSamples = Math.floor(6 * sampleRate);
    const samples = nativeHelperSamplesRef.current;
    if (samples.length === 0) return;
    if (!force && samples.length < targetSamples) return;
    if (samples.length < minSamples) return;

    const windowSamples = force ? samples : samples.slice(0, targetSamples);
    nativeHelperSamplesRef.current = force ? new Float32Array(0) : samples.slice(targetSamples);

    const startMs = nativeHelperSegmentStartMsRef.current
      ?? ((Math.max(0, nativeHelperSampleCursorRef.current - windowSamples.length) / sampleRate) * 1000);
    const endMs = startMs + samplesDurationMs(windowSamples, sampleRate);
    nativeHelperSegmentStartMsRef.current = force
      ? null
      : endMs;

    const { rms, peak, gain, processedSamples } = prepareWhisperSamples(windowSamples, { lowRmsDebug: isLowRmsDebugEnabled() });
    const durationMs = samplesDurationMs(processedSamples, sampleRate);
    const minRms = minWhisperRmsForProfile('helper');
    if (isLowRmsDebugEnabled()) {
      debug('system-audio-helper:window-rms-debug', { rms, peak, minRms, durationMs, sampleCount: processedSamples.length });
    }
    if (rms < minRms || durationMs < MIN_FINAL_AUDIO_MS) {
      debug('system-audio-helper:skip-low-quality-window', {
        rms,
        peak,
        durationMs,
        sampleCount: processedSamples.length,
      });
      return;
    }

    const segmentId = `system-helper-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const blockId = `final-${segmentId}-${Math.round(startMs)}-${Math.round(endMs)}`;
    captureDiag('system-audio-helper:transcription-window', {
      blockId,
      segmentId,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      rms,
      peak,
      whisperGain: gain,
      sampleCount: processedSamples.length,
      generation: captureGenerationRef.current,
    });
    debug('system-audio-helper:transcription-window', {
      blockId,
      segmentId,
      rms,
      peak,
      sampleCount: processedSamples.length,
    });
    enqueueTranscriptionRef.current({
      blockId,
      wavBytes: encodeWav(processedSamples, sampleRate),
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      rms,
      peak,
      source: 'system',
      sampleRate,
      sampleCount: processedSamples.length,
      possibleClipping: peak >= CLIPPING_THRESHOLD,
      whisperGain: gain,
      mode: 'final',
      segmentId,
      verbatimOnly: true,
      language: 'es',
    });
  }, []);

  const handleNativeHelperChunk = useCallback((payload: {
    sequence: number;
    version: number;
    sampleRate: number;
    channels: number;
    frameCount: number;
    pcm: Uint8Array;
  }) => {
    const bytes = payload.pcm.byteOffset % 4 === 0
      ? payload.pcm
      : payload.pcm.slice();
    const floatCount = Math.floor(bytes.byteLength / 4);
    const stereo = new Float32Array(bytes.buffer, bytes.byteOffset, floatCount);
    const channels = Math.max(1, payload.channels || 2);
    const frameCount = Math.min(payload.frameCount, Math.floor(stereo.length / channels));
    const mono = new Float32Array(frameCount);
    let sumSq = 0;
    let peak = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let value = 0;
      const base = frame * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        value += stereo[base + channel] ?? 0;
      }
      value /= channels;
      mono[frame] = value;
      const absolute = Math.abs(value);
      if (absolute > peak) peak = absolute;
      sumSq += value * value;
    }
    const rms = frameCount > 0 ? Math.sqrt(sumSq / frameCount) : 0;
    const now = Date.now();
    nativeHelperLastChunkAtRef.current = now;
    nativeHelperLastRmsRef.current = rms;
    nativeHelperLastPeakRef.current = peak;
    lastAudioRmsAtRef.current = now;
    if (rms >= SYSTEM_SIGNAL_CHECK_RMS || peak >= SYSTEM_SIGNAL_CHECK_PEAK) {
      nativeHelperLastNonSilentAtRef.current = now;
      lastNonSilentAudioAtRef.current = now;
    }

    patchMeter('system', {
      rms,
      peak,
      sampleRate: payload.sampleRate,
      status: rms < SILENCE_THRESHOLD ? 'silence' : 'capturing',
      silence: rms < SILENCE_THRESHOLD,
      clipping: peak >= CLIPPING_THRESHOLD,
      error: null,
    });

    if (isVerboseCaptureDebug() && (payload.sequence === 1 || payload.sequence % 100 === 0)) {
      captureDiag('system-audio-helper:chunk', {
        sequence: payload.sequence,
        sampleRate: payload.sampleRate,
        channels,
        frameCount,
        rms: Number(rms.toFixed(6)),
        peak: Number(peak.toFixed(6)),
        generation: captureGenerationRef.current,
      });
    }

    const current = nativeHelperSamplesRef.current;
    const next = new Float32Array(current.length + mono.length);
    next.set(current, 0);
    next.set(mono, current.length);
    if (nativeHelperSegmentStartMsRef.current === null) {
      nativeHelperSegmentStartMsRef.current = (nativeHelperSampleCursorRef.current / (payload.sampleRate || 48_000)) * 1000;
    }
    nativeHelperSampleCursorRef.current += mono.length;
    nativeHelperSamplesRef.current = next;
    flushNativeHelperWindow(false);
  }, [flushNativeHelperWindow, patchMeter]);

  const startNativeSystemAudioHelper = useCallback(async (reason: string) => {
    stopCoreAudioTapHelper('before-native-helper');
    const check = await window.meetingAssistant.systemAudioHelper.check();
    captureDiag('system-audio-helper:check', { reason, ...check, generation: captureGenerationRef.current });
    debug('system-audio-helper:check', { reason, ...check });
    if (!check.ok) {
      throw new SystemAudioEngineError(check.error ?? 'Native macOS helper is not built.', {
        status: 'needs-helper',
        providerId: 'native-helper',
        setupHint: check.error ?? 'Native macOS helper is not built. Run npm run build:macos-audio-helper.',
      });
    }

    resetNativeHelperBuffers();
    nativeHelperChunkUnsubscribeRef.current?.();
    nativeHelperStatusUnsubscribeRef.current?.();
    nativeHelperChunkUnsubscribeRef.current = window.meetingAssistant.systemAudioHelper.onChunk(handleNativeHelperChunk);
    nativeHelperStatusUnsubscribeRef.current = window.meetingAssistant.systemAudioHelper.onStatus((status) => {
      captureDiag('system-audio-helper:status', { ...status, generation: captureGenerationRef.current });
      debug('system-audio-helper:status', status);
      if (status.status === 'failed') {
        patchMeter('system', {
          status: 'failed',
          error: status.error ?? 'Native macOS helper stopped unexpectedly.',
        });
      }
    });

    const started = await window.meetingAssistant.systemAudioHelper.start();
    captureDiag('system-audio-helper:start-result', { reason, ...started, generation: captureGenerationRef.current });
    debug('system-audio-helper:start-result', { reason, ...started });
    if (!started.ok) {
      nativeHelperChunkUnsubscribeRef.current?.();
      nativeHelperChunkUnsubscribeRef.current = null;
      nativeHelperStatusUnsubscribeRef.current?.();
      nativeHelperStatusUnsubscribeRef.current = null;
      resetNativeHelperBuffers();
      void window.meetingAssistant.systemAudioHelper.stop().catch(() => undefined);
      throw new SystemAudioEngineError(started.error ?? 'Native macOS helper failed to start.', {
        status: 'failed',
        providerId: 'native-helper',
        setupHint:
          started.error
          ?? 'ScreenCaptureKit startCapture timed out. Grant Screen Recording permission to Terminal/Electron/Openwhispr and restart.',
      });
    }

    nativeHelperActiveRef.current = true;
    patchMeter('system', { status: 'requesting_permission', error: null, rms: 0, peak: 0 });
    addLog('system: captura nativa macOS iniciada (PCM vía helper; sin MediaStream)');
    return {
      providerId: 'native-helper' as const,
      kind: 'pcm-helper' as const,
    };
  }, [
    addLog,
    handleNativeHelperChunk,
    patchMeter,
    resetNativeHelperBuffers,
    stopCoreAudioTapHelper,
  ]);

  const startCoreAudioTapHelper = useCallback(async (reason: string) => {
    stopNativeSystemAudioHelper('before-coreaudio-tap-helper');
    const check = await window.meetingAssistant.coreAudioTapHelper.check();
    captureDiag('core-audio-tap-helper:check', { reason, ...check, generation: captureGenerationRef.current });
    debug('core-audio-tap-helper:check', { reason, ...check });
    if (!check.ok) {
      throw new SystemAudioEngineError(check.error ?? 'CoreAudio Tap helper is not built.', {
        status: 'needs-helper',
        providerId: 'coreaudio-tap',
        setupHint: check.error ?? 'Run npm run build:macos-coreaudio-tap-helper.',
      });
    }

    resetNativeHelperBuffers();
    coreTapChunkUnsubscribeRef.current?.();
    coreTapStatusUnsubscribeRef.current?.();
    coreTapChunkUnsubscribeRef.current = window.meetingAssistant.coreAudioTapHelper.onChunk(handleNativeHelperChunk);
    coreTapStatusUnsubscribeRef.current = window.meetingAssistant.coreAudioTapHelper.onStatus((status) => {
      captureDiag('core-audio-tap-helper:status', { ...status, generation: captureGenerationRef.current });
      debug('core-audio-tap-helper:status', status);
      if (status.status === 'failed') {
        patchMeter('system', {
          status: 'failed',
          error: status.error ?? 'CoreAudio Tap helper stopped unexpectedly.',
        });
      }
    });

    const started = await window.meetingAssistant.coreAudioTapHelper.start();
    captureDiag('core-audio-tap-helper:start-result', { reason, ...started, generation: captureGenerationRef.current });
    debug('core-audio-tap-helper:start-result', { reason, ...started });
    if (!started.ok) {
      coreTapChunkUnsubscribeRef.current?.();
      coreTapChunkUnsubscribeRef.current = null;
      coreTapStatusUnsubscribeRef.current?.();
      coreTapStatusUnsubscribeRef.current = null;
      resetNativeHelperBuffers();
      void window.meetingAssistant.coreAudioTapHelper.stop().catch(() => undefined);
      throw new SystemAudioEngineError(started.error ?? 'CoreAudio Tap helper failed to start.', {
        status: 'failed',
        providerId: 'coreaudio-tap',
        setupHint: started.error ?? 'CoreAudio Tap helper failed to start.',
      });
    }

    coreTapActiveRef.current = true;
    patchMeter('system', { status: 'requesting_permission', error: null, rms: 0, peak: 0 });
    addLog('system: CoreAudio Tap helper iniciado (PCM vía helper; sin MediaStream)');
    return {
      providerId: 'coreaudio-tap' as const,
      kind: 'pcm-helper' as const,
    };
  }, [
    addLog,
    handleNativeHelperChunk,
    patchMeter,
    resetNativeHelperBuffers,
    stopNativeSystemAudioHelper,
  ]);

  const waitForUsableAudioSignal = useCallback(async (
    source: SourceKey,
    timeoutMs = SYSTEM_SIGNAL_CHECK_TIMEOUT_MS,
    providerId?: SystemAudioProviderId,
  ): Promise<boolean> => {
    const startedAt = Date.now();
    let hitCount = 0;
    const startPayload = {
      source,
      timeoutMs,
      rmsThreshold: SYSTEM_SIGNAL_CHECK_RMS,
      peakThreshold: SYSTEM_SIGNAL_CHECK_PEAK,
      requiredHits: SYSTEM_SIGNAL_CHECK_REQUIRED_HITS,
      generation: captureGenerationRef.current,
      providerId: providerId ?? null,
    };
    captureDiag('capture:system:signal-check:start', startPayload);
    debug('capture:system:signal-check:start', startPayload);

    return new Promise((resolve) => {
      const sample = () => {
        if (providerId === 'native-helper' || providerId === 'coreaudio-tap') {
          const elapsedMs = Date.now() - startedAt;
          const rms = nativeHelperLastRmsRef.current;
          const peak = nativeHelperLastPeakRef.current;
          const hasChunk = nativeHelperLastChunkAtRef.current !== null && nativeHelperLastChunkAtRef.current >= startedAt;
          const usable = Boolean(nativeHelperLastNonSilentAtRef.current && nativeHelperLastNonSilentAtRef.current >= startedAt);
          if (usable) hitCount += 1;
          else hitCount = 0;
          const samplePayload = {
            source,
            providerId,
            elapsedMs,
            rms: Number(rms.toFixed(6)),
            peak: Number(peak.toFixed(6)),
            usable,
            hasChunk,
            hitCount,
            generation: captureGenerationRef.current,
          };
          captureDiag('capture:system:signal-check:sample', samplePayload);
          debug('capture:system:signal-check:sample', samplePayload);
          if (hitCount >= SYSTEM_SIGNAL_CHECK_REQUIRED_HITS) {
            captureDiag('capture:system:signal-check:ok', samplePayload);
            debug('capture:system:signal-check:ok', samplePayload);
            resolve(true);
            return;
          }
          if (elapsedMs >= timeoutMs) {
            const failedPayload = {
              ...samplePayload,
              reason: hasChunk ? 'timeout-silent-pcm-helper' : 'timeout-no-pcm-helper-chunks',
            };
            captureDiag('capture:system:signal-check:failed', failedPayload);
            debug('capture:system:signal-check:failed', failedPayload);
            resolve(false);
            return;
          }
          window.setTimeout(sample, SYSTEM_SIGNAL_CHECK_INTERVAL_MS);
          return;
        }

        const analyser = analysersRef.current[source];
        const elapsedMs = Date.now() - startedAt;
        if (!analyser) {
          const failedPayload = {
            source,
            providerId: providerId ?? null,
            elapsedMs,
            reason: 'missing-analyser',
            generation: captureGenerationRef.current,
          };
          captureDiag('capture:system:signal-check:failed', failedPayload);
          debug('capture:system:signal-check:failed', failedPayload);
          resolve(false);
          return;
        }

        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const value = data[i];
          const absolute = Math.abs(value);
          sum += value * value;
          peak = Math.max(peak, absolute);
        }
        const rms = Math.sqrt(sum / data.length);
        const usable = rms >= SYSTEM_SIGNAL_CHECK_RMS || peak >= SYSTEM_SIGNAL_CHECK_PEAK;
        if (usable) hitCount += 1;
        else hitCount = 0;

        const samplePayload = {
          source,
          providerId: providerId ?? null,
          elapsedMs,
          rms: Number(rms.toFixed(6)),
          peak: Number(peak.toFixed(6)),
          usable,
          hitCount,
          generation: captureGenerationRef.current,
        };
        captureDiag('capture:system:signal-check:sample', samplePayload);
        debug('capture:system:signal-check:sample', samplePayload);

        if (hitCount >= SYSTEM_SIGNAL_CHECK_REQUIRED_HITS) {
          const okPayload = {
            source,
            providerId: providerId ?? null,
            elapsedMs,
            rms: Number(rms.toFixed(6)),
            peak: Number(peak.toFixed(6)),
            hitCount,
            generation: captureGenerationRef.current,
          };
          captureDiag('capture:system:signal-check:ok', okPayload);
          debug('capture:system:signal-check:ok', okPayload);
          resolve(true);
          return;
        }

        if (elapsedMs >= timeoutMs) {
          const failedPayload = {
            source,
            providerId: providerId ?? null,
            elapsedMs,
            rms: Number(rms.toFixed(6)),
            peak: Number(peak.toFixed(6)),
            hitCount,
            reason: 'timeout-silent',
            generation: captureGenerationRef.current,
          };
          captureDiag('capture:system:signal-check:failed', failedPayload);
          debug('capture:system:signal-check:failed', failedPayload);
          resolve(false);
          return;
        }

        window.setTimeout(sample, SYSTEM_SIGNAL_CHECK_INTERVAL_MS);
      };

      sample();
    });
  }, []);

  const captureSystemFromVirtualInput = useCallback(async (deviceId: string, reason: string) => {
    if (!deviceId) {
      throw new Error('missing-virtual-input: select a BlackHole/Loopback virtual input in Audio settings');
    }

    const virtualConstraints = {
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    } satisfies MediaStreamConstraints;
    const device = inputDevices.find((input) => input.deviceId === deviceId);
    const candidate: SystemAudioDeviceCandidate = {
      deviceId,
      groupId: device?.groupId,
      label: device?.label ?? '',
    };
    if (filterVirtualSystemInputCandidates([candidate]).length === 0) {
      throw new Error(
        'invalid-virtual-input: select a BlackHole / Loopback / VB-CABLE style virtual input in Settings (not Default / headset)',
      );
    }
    const beforePayload = {
      reason,
      deviceId,
      deviceLabel: device?.label ?? null,
      constraints: virtualConstraints,
      generation: captureGenerationRef.current,
    };
    captureDiag('capture:system:virtual:before', beforePayload);
    debug('capture:system:virtual:before', beforePayload);

    const stream = await navigator.mediaDevices.getUserMedia(virtualConstraints);
    const streamPayload = {
      reason,
      deviceId,
      deviceLabel: device?.label ?? null,
      stream: describeStream(stream),
      generation: captureGenerationRef.current,
    };
    captureDiag('capture:system:virtual:stream', streamPayload);
    debug('capture:system:virtual:stream', streamPayload);
    if (stream.getAudioTracks().length === 0) {
      throw new Error('empty-stream: virtual system input returned no audio track');
    }
    streamsRef.current.system = stream;
    connectAnalyser(stream, 'system');
    addLog(`system: captura iniciada desde entrada virtual${device?.label ? ` (${device.label})` : ''}`);
    return stream;
  }, [addLog, connectAnalyser, inputDevices]);

  const captureSystem = useCallback(async () => {
    patchMeter('system', { status: 'requesting_permission', error: null });
    const virtualCandidates = filterVirtualSystemInputCandidates(
      inputDevices.map((device) => ({
        deviceId: device.deviceId,
        groupId: device.groupId,
        label: device.label ?? '',
      })),
    );
    const stopProviderStream = (stream: MediaStream, reason: string) => {
      captureDiag('system-audio:provider:stop', { reason, stream: describeStream(stream) });
      debug('system-audio:provider:stop', { reason, stream: describeStream(stream) });
      if (streamsRef.current.system === stream) {
        delete streamsRef.current.system;
      }
      stream.getTracks().forEach((track) => stopTrackOnce(track, `system-${reason}`));
      detachDisplayVideoSink(reason);
      if (analysersRef.current.system) {
        delete analysersRef.current.system;
      }
      patchMeter('system', {
        status: 'stopped',
        rms: 0,
        peak: 0,
        silence: false,
        error: null,
      });
    };
    const captureElectronLoopback = async () => {
      const displayConstraints = {
        audio: {
          systemAudio: 'include',
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
        },
        video: true,
      } as DisplayMediaStreamOptions & {
        audio: MediaTrackConstraints & {
          systemAudio: 'include';
          suppressLocalAudioPlayback: false;
        };
      };
      const getDisplayBeforePayload = {
        constraints: displayConstraints,
        appMode: appModeRef.current,
        captureMode: lastCaptureModeRef.current,
        generation: captureGenerationRef.current,
        selectedDesktopSourceId,
        timestampMs: Date.now(),
        performanceMs: Number(performance.now().toFixed(1)),
      };
      captureDiag('capture:system:getDisplayMedia:before', getDisplayBeforePayload);
      debug('capture:system:getDisplayMedia:before', getDisplayBeforePayload);
      const displayStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
      const getDisplayStreamPayload = {
        appMode: appModeRef.current,
        captureMode: lastCaptureModeRef.current,
        generation: captureGenerationRef.current,
        timestampMs: Date.now(),
        performanceMs: Number(performance.now().toFixed(1)),
        stream: describeStream(displayStream),
      };
      captureDiag('capture:system:getDisplayMedia:stream', getDisplayStreamPayload);
      debug('capture:system:getDisplayMedia:stream', getDisplayStreamPayload);
      if (displayStream.getAudioTracks().length === 0) {
        throw new Error('empty-stream: display capture returned no audio track');
      }
      streamsRef.current.system = displayStream;
      attachDisplayVideoSink(displayStream);
      connectAnalyser(displayStream, 'system');
      await refreshPermissions();
      addLog('system: captura display/system iniciada');
      return {
        providerId: 'electron-loopback' as const,
        kind: 'media-stream' as const,
        stream: displayStream,
      };
    };
    try {
      const result = await runSystemAudioEngine({
        platform: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'unknown',
        strategy: toSystemAudioStrategy(systemCaptureStrategy),
        selectedOutputDevice: selectedOutputId,
        selectedMicDevice: selectedMicId,
        selectedSystemInputId,
        virtualInputCandidates: virtualCandidates,
        providers: {
          electronLoopback: {
            id: 'electron-loopback',
            available: () => true,
            start: () => captureElectronLoopback(),
          },
          nativeHelper: {
            id: 'native-helper',
            available: async () => {
              const check = await window.meetingAssistant.systemAudioHelper.check();
              return Boolean(check.ok);
            },
            start: (reason) => startNativeSystemAudioHelper(reason),
          },
          coreAudioTap: {
            id: 'coreaudio-tap',
            available: async () => {
              const check = await window.meetingAssistant.coreAudioTapHelper.check();
              return Boolean(check.ok);
            },
            start: (reason) => startCoreAudioTapHelper(reason),
          },
          virtualInput: (deviceId) => ({
            id: 'virtual-input',
            available: () => Boolean(deviceId),
            start: async (reason) => ({
              providerId: 'virtual-input' as const,
              kind: 'media-stream' as const,
              stream: await captureSystemFromVirtualInput(deviceId, reason),
            }),
          }),
        },
        probeUsableAudio: (_stream, providerId) => waitForUsableAudioSignal('system', SYSTEM_SIGNAL_CHECK_TIMEOUT_MS, providerId),
        stopPcmHelper: (providerId, reason) => {
          if (providerId === 'native-helper') stopNativeSystemAudioHelper(reason);
          else stopCoreAudioTapHelper(reason);
        },
        probePcmHelper: (providerId) => waitForUsableAudioSignal('system', SYSTEM_SIGNAL_CHECK_TIMEOUT_MS, providerId),
        stopStream: stopProviderStream,
        log: (eventName, payload) => {
          captureDiag(eventName, {
            ...payload,
            generation: captureGenerationRef.current,
          });
          debug(eventName, payload);
        },
      });

      if (result.kind === 'pcm-helper') {
        if (result.providerId === 'coreaudio-tap') {
          addLog('system: CoreAudio Tap helper validado con señal audible (PCM)');
        } else {
          addLog('system: ScreenCaptureKit helper validado con señal audible (PCM; experimental)');
        }
      } else if (result.providerId === 'electron-loopback') {
        addLog('system: loopback nativo validado con señal audible');
      } else if (result.providerId === 'virtual-input') {
        addLog('system: entrada virtual validada con señal audible');
      }

      return result;
    } catch (error) {
      const engineError = error instanceof SystemAudioEngineError ? error : null;
      const fallback = platform === 'darwin' ? ` ${macSystemFallbackText}` : '';
      const message = engineError?.setupHint
        ? engineError.setupHint
        : `system: falló captura de audio del sistema (${String(error)}).${fallback}`;
      patchMeter('system', { status: 'failed', error: message });
      patchCaptureHealth({
        captureHealth: engineError?.status === 'silent' ? 'silent' : 'failed',
        audioTrackReadyState: engineError?.status === 'silent' ? 'live' : captureHealthRef.current.audioTrackReadyState,
        lastCheckedAt: Date.now(),
        message,
      });
      addLog(`system: ${message}`);
      throw error;
    }
  }, [
    addLog,
    captureSystemFromVirtualInput,
    connectAnalyser,
    inputDevices,
    macSystemFallbackText,
    patchMeter,
    patchCaptureHealth,
    platform,
    refreshPermissions,
    selectedDesktopSourceId,
    selectedMicId,
    selectedOutputId,
    selectedSystemInputId,
    startCoreAudioTapHelper,
    startNativeSystemAudioHelper,
    stopCoreAudioTapHelper,
    stopNativeSystemAudioHelper,
    systemCaptureStrategy,
    waitForUsableAudioSignal,
  ]);

  const buildMixedStream = useCallback((sources: MediaStream[]) => {
    const audioContext = ensureAudioContext();
    const destination = audioContext.createMediaStreamDestination();
    const mixedBuildPayload = {
      sourceCount: sources.length,
      generation: captureGenerationRef.current,
      audioContextState: audioContext.state,
      inputStreams: sources.map(describeStream),
    };
    captureDiag('capture:mixed:build:start', mixedBuildPayload);
    debug('capture:mixed:build:start', mixedBuildPayload);
    sources.forEach((stream, index) => {
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      if (SAFE_BASELINE) {
        if (sources.length > 1) {
          /* Slightly louder loopback/display: it often sits below mic in RMS on macOS. */
          gain.gain.value = index === 0 ? 0.32 : 0.58;
        } else {
          gain.gain.value = 0.7;
        }
      } else {
        gain.gain.value = Math.max(0.45, 1 / Math.max(1, sources.length));
      }
      source.connect(gain);
      gain.connect(destination);
      graphNodesRef.current.push(source, gain);
      debug('capture:mixed:input-connected', {
        index,
        gain: gain.gain.value,
        stream: describeStream(stream),
      });
    });
    streamsRef.current.mixed = destination.stream;
    captureDiag('capture:mixed:destination', describeStream(destination.stream));
    debug('capture:mixed:destination', describeStream(destination.stream));
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
    const isV2Pipeline = asrPipelineModeRef.current === 'moonshine-qwen-v2';
    if (SAFE_BASELINE && !isV2Pipeline) return;

    if (!shouldUseForLive(segment)) {
      setRawSegments((current) => [...current, { ...segment, stabilizationReason: 'filtered' }].slice(-120));
      return;
    }
    setRawSegments((current) => [...current, { ...segment, asrMode: 'preview' as const, segmentId }].slice(-120));
    if (isV2Pipeline) {
      acceptV2MainPreview(segment, segmentId);
      return;
    }
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
  }, [acceptV2MainPreview, applyLedgerSnapshot, showRawDebug]);

  const handleFinalSegment = useCallback((segment: TranscriptSegment, segmentId: string) => {
    const finalText = segment.text.trim();
    if (!finalText) return;
    const isV2Pipeline = asrPipelineModeRef.current === 'moonshine-qwen-v2';

    if (SAFE_BASELINE && !isV2Pipeline) {
      const pk = segment.peak ?? 0;
      if (pk >= CLIPPING_THRESHOLD) {
        finalizedSegmentIdsRef.current.add(segmentId);
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
      finalizedSegmentIdsRef.current.add(segmentId);
      setLiveTranscript((prev) => ({
        committedText: `${prev.committedText} ${finalText}`.trim(),
        unstableSuffix: '',
        lastReason: 'vad-final-direct',
        lastUpdatedAt: Date.now(),
      }));
      setVisibleCommittedText((vc) => appendWordsDeduped(vc, splitWords(finalText)));
      setFinalRevealQueue([]);
      setLiveVisualDraft(INITIAL_LIVE_VISUAL_DRAFT);
      acceptV2ShadowFinal(segment, segmentId);
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

    if (isV2Pipeline) {
      setRawSegments((current) => [...current, {
        ...segment,
        status: 'final' as const,
        asrMode: 'final' as const,
        segmentId,
        stabilizationReason: segment.fallbackUsed ? 'v2-final-fallback' : 'v2-final',
      }].slice(-120));
      finalizedSegmentIdsRef.current.add(segmentId);
      acceptV2MainFinal(segment, segmentId);
      queueFinalRefinementSegment(segment, segmentId);
      finalAcceptedCountRef.current += 1;
      syncAsrLiveStats({});
      debug('transcription:v2-final-accepted', {
        segmentId,
        engineUsed: segment.engineUsed ?? segment.modelName,
        fallbackUsed: segment.fallbackUsed ?? false,
        fallbackReason: segment.fallbackReason,
        modelName: segment.modelName,
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
  }, [acceptV2MainFinal, acceptV2ShadowFinal, addLog, applyLedgerSnapshot, queueFinalRefinementSegment, syncAsrLiveStats]);


  /** safeBaseline: whisper.cpp transcribe cada segmento VAD cerrado (solo final). */
  const processNextFinalWindow = useCallback(() => {
    if (!SAFE_BASELINE) return;
    if (finalBusyRef.current) return;
    const request = pendingFinalWindowsRef.current.shift();
    if (!request) return;

    finalBusyRef.current = true;

    const effectiveVerbatimOnly = true;
    const effectiveLanguage = 'es';

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
      promptMode: 'empty',
      glossaryChars: 0,
      safeBaseline: true,
      lane: 'final',
      sampleRate: request.sampleRate,
      sampleCount: request.sampleCount,
      bytes: request.wavBytes.byteLength,
      coalesced: request.coalesced ?? false,
      possibleClipping: request.possibleClipping ?? false,
      whisperGain: request.whisperGain,
      finalQueuePending: pendingFinalWindowsRef.current.length,
    });

    window.meetingAssistant.transcription.transcribeBlock({
      blockId: request.blockId,
      wavBytes: request.wavBytes,
      startMs: request.startMs,
      endMs: request.endMs,
      rms: request.rms,
      peak: request.peak,
      source: request.source,
      glossary: undefined,
      promptMode: 'empty',
      sampleRate: request.sampleRate,
      sampleCount: request.sampleCount,
      whisperGain: request.whisperGain,
      mode: 'final',
      modelRole: 'final',
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
        lane: 'final',
      });
      if (!result.ok) {
        const err = result.error ?? 'error desconocido';
        addLog(`transcription error: ${err}`);
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
        return;
      }

      const text = (result.text ?? '').trim();
      if (!text) {
        addLog(`transcription: segmento final sin texto (${result.durationMs}ms)`);
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
        return;
      }

      if ((request.peak ?? 0) >= CLIPPING_THRESHOLD) {
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
      syncAsrLiveStats({ finalLatencyMs: wallLatencyMs });
      debug('transcription:latency-metrics', {
        kind: 'final',
        wallLatencyMs,
        timeToFinalMs: wallLatencyMs,
        modelName: result.modelName,
      });

      const baseSegment: TranscriptSegment = {
        id: request.blockId,
        startMs: request.startMs,
        endMs: request.endMs,
        text,
        rawText: result.text,
        status: 'final',
        source: request.source,
        rms: request.rms,
        peak: request.peak,
        durationMs: result.durationMs,
        modelName: result.modelName,
        suspicious: false,
        sampleRate: request.sampleRate,
        sampleCount: request.sampleCount,
        possibleClipping: request.possibleClipping,
        whisperGain: request.whisperGain,
        whisperPromptLength: result.whisperPromptLength,
        segmentId: request.segmentId,
        asrMode: 'final',
        language: effectiveLanguage,
        engineUsed: result.engineUsed,
        fallbackUsed: result.fallbackUsed,
        fallbackReason: result.fallbackReason,
        whisperText: result.whisperText,
        qwenText: result.qwenText,
        whisperDurationMs: result.whisperDurationMs,
        qwenDurationMs: result.qwenDurationMs,
        qwenError: result.qwenError,
      };
      handleFinalSegment(baseSegment, request.segmentId);
    }).catch((error) => {
      debug('transcription:window-error', String(error));
      addLog(`transcription error: ${String(error)}`);
    }).finally(() => {
      finalBusyRef.current = false;
      syncAsrLiveStats({});
      processNextFinalWindow();
    });
  }, [addLog, handleFinalSegment, syncAsrLiveStats]);

  const processNextTranscriptionWindow = useCallback(() => {
    const isV2Pipeline = asrPipelineModeRef.current === 'moonshine-qwen-v2';
    if (SAFE_BASELINE && !isV2Pipeline) return;
    if (transcriptionBusyRef.current) return;
    const request = pendingTranscriptionWindowsRef.current.shift();
    if (!request) return;
    const isBaselineMode = !isV2Pipeline;

    transcriptionBusyRef.current = true;
    transcriptionInFlightModeRef.current = request.mode;

    const effectiveGlossary = SAFE_BASELINE && isBaselineMode ? undefined : (request.verbatimOnly ? undefined : glossary);
    const effectivePromptMode = SAFE_BASELINE && isBaselineMode ? 'empty' : (request.verbatimOnly ? 'empty' : promptMode);
    const effectiveVerbatimOnly = SAFE_BASELINE && isBaselineMode ? true : request.verbatimOnly;
    const effectiveLanguage = SAFE_BASELINE && isBaselineMode ? 'es' : request.language;

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
      safeBaseline: SAFE_BASELINE && isBaselineMode,
      v2Mode: isV2Pipeline,
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
        const err = result.error ?? 'error desconocido';
        if (request.mode === 'preview') {
          debug('transcription:preview-error', { blockId: request.blockId, segmentId: request.segmentId, error: err });
          if (/code null|exited with code|killed|SIGTERM|cancel/i.test(err)) {
            debug('transcription:preview-cancelled-or-killed', { blockId: request.blockId, segmentId: request.segmentId });
          }
        } else {
          addLog(`transcription error: ${err}`);
        }
        if (SAFE_BASELINE && isBaselineMode && request.mode === 'final') {
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
          if (SAFE_BASELINE && isBaselineMode) {
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

      if (SAFE_BASELINE && isBaselineMode && request.mode === 'final' && (request.peak ?? 0) >= CLIPPING_THRESHOLD) {
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
        engineUsed: result.engineUsed,
        fallbackUsed: result.fallbackUsed,
        fallbackReason: result.fallbackReason,
        whisperText: result.whisperText,
        qwenText: result.qwenText,
        whisperDurationMs: result.whisperDurationMs,
        qwenDurationMs: result.qwenDurationMs,
        qwenError: result.qwenError,
      };

      if (request.mode === 'final') {
        handleFinalSegment(baseSegment, request.segmentId);
      } else {
        handlePreviewSegment(baseSegment, request.segmentId);
      }
    }).catch((error) => {
      const msg = String(error);
      if (request.mode === 'preview') {
        debug('transcription:window-error-preview', {
          blockId: request.blockId,
          segmentId: request.segmentId,
          invokeError: msg,
        });
      } else {
        debug('transcription:window-error', msg);
        addLog(`transcription error: ${msg}`);
      }
    }).finally(() => {
      transcriptionBusyRef.current = false;
      transcriptionInFlightModeRef.current = null;
      syncAsrLiveStats({});
      processNextTranscriptionWindow();
    });
  }, [addLog, glossary, handleFinalSegment, handlePreviewSegment, promptMode, syncAsrLiveStats]);

  const enqueueTranscription = useCallback((request: TranscriptionWindow) => {
    const enqueuedAtMs = Date.now();
    const isV2Pipeline = asrPipelineModeRef.current === 'moonshine-qwen-v2';
    const r: TranscriptionWindow = SAFE_BASELINE
      ? { ...request, verbatimOnly: true, language: 'es', enqueuedAtMs }
      : { ...request, enqueuedAtMs };

    if (SAFE_BASELINE && !isV2Pipeline && r.mode === 'preview') {
      return;
    }

    if (SAFE_BASELINE && !isV2Pipeline && r.mode === 'final') {
      pendingFinalWindowsRef.current.push(r);
      syncAsrLiveStats({});
      debug('transcription:window-queued', {
        blockId: r.blockId,
        mode: r.mode,
        segmentId: r.segmentId,
        finalQueue: pendingFinalWindowsRef.current.length,
      });
      processNextFinalWindow();
      return;
    }

    if (r.mode === 'final') {
      pendingTranscriptionWindowsRef.current = [
        r,
        ...pendingTranscriptionWindowsRef.current.filter(
          (w) => !(w.mode === 'preview' && w.segmentId === r.segmentId),
        ),
      ];
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
  }, [processNextFinalWindow, processNextTranscriptionWindow, syncAsrLiveStats]);
  enqueueTranscriptionRef.current = enqueueTranscription;

  const startLiveTranscription = useCallback((stream: MediaStream, source: SourceKey) => {
    const audioContext = ensureAudioContext();
    transcriptionProcessorRef.current?.disconnect();
    transcriptionFirstFrameLoggedRef.current = false;
    lastProcessorFrameAtRef.current = null;
    lastProcessorRmsTraceAtRef.current = 0;
    transcriptionSampleCursorRef.current = 0;
    transcriptionBusyRef.current = false;
    pendingTranscriptionWindowsRef.current = [];
    pendingFinalWindowsRef.current = [];
    finalBusyRef.current = false;
    previewBlockedByFinalCountRef.current = 0;
    vadRef.current.reset();
    vadShortAccumRef.current = null;
    activeSegmentIdRef.current = null;
    lastPreviewPerfMsRef.current = 0;
    transcriptionInFlightModeRef.current = null;
    liveTranscriptionSourceRef.current = source;
    polisherBusyRef.current = false;
    pendingPolishJobRef.current = null;
    cleanContextRef.current = '';
    lastNotesPolishAtRef.current = 0;
    lastNotesTextLengthRef.current = 0;
    previewDroppedCountRef.current = 0;
    previewReplacedCountRef.current = 0;
    finalAcceptedCountRef.current = 0;
    previewSegmentOpenedAtRef.current.clear();
    previewFirstSuccessRef.current.clear();
    finalizedSegmentIdsRef.current.clear();
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
      previewBusyLive: false,
      finalBusyLive: false,
      previewBlockedByFinalCount: 0,
    });

    const mediaSource = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;
    /* Gain 0: inaudible, but connection to destination keeps ScriptProcessor pulling reliably on macOS/Electron. */

    processor.onaudioprocess = (event) => {
      const input = new Float32Array(event.inputBuffer.getChannelData(0));
      if (input.length === 0) {
        debug('transcription:empty-audio-frame');
        return;
      }
      const nowWall = Date.now();
      lastProcessorFrameAtRef.current = nowWall;
      let framePeak = 0;
      let sumSq = 0;
      for (let i = 0; i < input.length; i += 1) {
        const s = input[i]!;
        const a = Math.abs(s);
        if (a > framePeak) framePeak = a;
        sumSq += s * s;
      }
      const frameRms = Math.sqrt(sumSq / input.length);
      if (!transcriptionFirstFrameLoggedRef.current) {
        transcriptionFirstFrameLoggedRef.current = true;
        const firstFramePayload = { source, rms: frameRms, peak: framePeak, sampleRate: audioContext.sampleRate, timestampMs: nowWall };
        captureDiag('transcription:processor-first-frame', firstFramePayload);
        transcriptionTrace('processor-first-frame', firstFramePayload);
        debug('transcription:processor-first-frame', firstFramePayload);
      } else if (isTranscriptionTraceEnabled() && nowWall - lastProcessorRmsTraceAtRef.current > 2_000) {
        lastProcessorRmsTraceAtRef.current = nowWall;
        const rmsSamplePayload = { source, rms: frameRms, peak: framePeak, sampleRate: audioContext.sampleRate, timestampMs: nowWall };
        captureDiag('transcription:processor-rms-sample', rmsSamplePayload);
        transcriptionTrace('processor-rms-sample', rmsSamplePayload);
        debug('transcription:processor-rms-sample', rmsSamplePayload);
      }
      const frameStartSample = transcriptionSampleCursorRef.current;
      transcriptionSampleCursorRef.current += input.length;

      const captureSource = liveTranscriptionSourceRef.current;
      const { closed } = vadRef.current.pushFrame(input, audioContext.sampleRate, frameStartSample);

      const isV2Pipeline = asrPipelineModeRef.current === 'moonshine-qwen-v2';
      const isBaselineMode = !isV2Pipeline;
      const verbatimOnly = SAFE_BASELINE && isBaselineMode ? true : !allowWhisperContextRef.current;
      const language = SAFE_BASELINE && isBaselineMode ? 'es' : whisperLanguageRef.current;

      if (vadRef.current.isSegmentOpen() && !activeSegmentIdRef.current) {
        const newSegId = `seg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        activeSegmentIdRef.current = newSegId;
        previewSegmentOpenedAtRef.current.set(newSegId, performance.now());
      }

      const closedExtra: VadClosedSegment[] = [];
      if (isForceMicWindowsEnabled() && lastCaptureModeRef.current === 'mic' && captureSource === 'mic') {
        if (nowWall - forceMicWindowLastAtRef.current >= 5000) {
          forceMicWindowLastAtRef.current = nowWall;
          const forced = vadRef.current.forceEmitOpenSegmentForDebug(audioContext.sampleRate);
          if (forced) closedExtra.push(forced);
        }
      }

      for (const seg of [...closed, ...closedExtra]) {
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

        const { rms, peak, gain, processedSamples } = prepareWhisperSamples(workSeg.samples, { lowRmsDebug: isLowRmsDebugEnabled() });
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
        const minWhisper = minWhisperRmsForProfile(whisperProfileForLiveSource(captureSource));
        if (rms < minWhisper || audioDurationMs < MIN_FINAL_AUDIO_MS) {
          debug('transcription:vad-skip-low-quality-final', { rms, durationMs: audioDurationMs, vadDurationMs: workSeg.durationMs, minWhisper });
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

      if (SAFE_BASELINE && !isV2Pipeline) return;
      if (isV2Pipeline && !moonshineConfiguredRef.current) return;

      if (!vadRef.current.isSegmentOpen()) return;

      const segmentId = activeSegmentIdRef.current;
      if (!segmentId) return;

      const now = performance.now();

      if (!SAFE_BASELINE || isV2Pipeline) {
        const pendingQ = pendingTranscriptionWindowsRef.current;
        if (isV2Pipeline && (finalBusyRef.current || pendingFinalWindowsRef.current.length > 0)) {
          previewBlockedByFinalCountRef.current += 1;
          previewDroppedCountRef.current += 1;
          syncAsrLiveStats({});
          return;
        }
        if (pendingQ.some((w) => w.mode === 'final')) {
          previewBlockedByFinalCountRef.current += 1;
          previewDroppedCountRef.current += 1;
          syncAsrLiveStats({});
          return;
        }
        if (transcriptionBusyRef.current && transcriptionInFlightModeRef.current === 'final') {
          previewBlockedByFinalCountRef.current += 1;
          previewDroppedCountRef.current += 1;
          syncAsrLiveStats({});
          return;
        }
        if (transcriptionBusyRef.current && transcriptionInFlightModeRef.current === 'preview') {
          lastPreviewPerfMsRef.current = now;
          return;
        }
      }

      if (now - lastPreviewPerfMsRef.current < PREVIEW_INTERVAL_MS) return;

      const snap = vadRef.current.getOpenSegmentSnapshot(audioContext.sampleRate);
      if (!snap || snap.samples.length === 0) return;

      const tail = trimPreviewSamplesToTail(
        snap.samples,
        audioContext.sampleRate,
        snap.endSample,
        MAX_PREVIEW_AUDIO_MS,
      );
      const { rms, peak, gain, processedSamples } = prepareWhisperSamples(tail.samples, { lowRmsDebug: isLowRmsDebugEnabled() });
      warnPossibleClipping(captureSource, peak);
      const audioDurationMs = samplesDurationMs(processedSamples, audioContext.sampleRate);
      const minWhisper = minWhisperRmsForProfile(whisperProfileForLiveSource(captureSource));
      if (rms < minWhisper || audioDurationMs < MIN_PREVIEW_AUDIO_MS) {
        debug('transcription:preview-skip-low-quality', { rms, durationMs: audioDurationMs, minWhisper });
        return;
      }

      lastPreviewPerfMsRef.current = now;
      const wavBytes = encodeWav(processedSamples, audioContext.sampleRate);
      const previewPayload: TranscriptionWindow = {
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
      };

      enqueueTranscription(previewPayload);
    };

    mediaSource.connect(processor);
    processor.connect(silentSink);
    silentSink.connect(audioContext.destination);
    transcriptionProcessorRef.current = processor;
    graphNodesRef.current.push(mediaSource, processor, silentSink);

    debug('transcription:processor-connected', {
      source,
      sampleRate: audioContext.sampleRate,
      stream: describeStream(stream),
    });

    const isV2Pipeline = asrPipelineModeRef.current === 'moonshine-qwen-v2';
    addLog(isV2Pipeline
      ? 'transcripción en vivo lista: Whisper principal; comparación opcional en configuración.'
      : SAFE_BASELINE
        ? 'transcripción iniciada con Whisper Large V3 Turbo.'
        : 'transcripción iniciada con Whisper Large V3 Turbo y contexto activo.');
  }, [addLog, enqueueTranscription, ensureAudioContext, syncAsrLiveStats, warnPossibleClipping]);

  const startCapture = useCallback(
    (mode: CaptureMode, options?: { preserveSession?: boolean; reconnect?: boolean }) =>
      runCaptureLifecycle('start', async () => {
        const generation = ++captureGenerationRef.current;
        const preserveSession = Boolean(options?.preserveSession);
        captureStartInProgressRef.current = true;

        try {
          await stopCaptureCore({
            preserveSession,
            reason: options?.reconnect ? 'reconectando audio: captura anterior liberada' : undefined,
          });

          if (generation !== captureGenerationRef.current) {
            debug('capture:start-aborted-stale-generation', { generation });
            return;
          }

          await ensureRunningAudioContext();

        if (!preserveSession) {
          setSavedWav(null);
          setRawSegments([]);
          setCleanSegments([]);
          setLedgerDebugGroups([]);
          setLiveVisualDraft(INITIAL_LIVE_VISUAL_DRAFT);
          setLiveTranscript({ committedText: '', unstableSuffix: '', lastReason: 'waiting', lastUpdatedAt: null });
          setVisibleCommittedText('');
          setFinalRevealQueue([]);
          resetV2Main();
          resetV2Shadow();
          pendingFinalRefinementSegmentsRef.current = [];
          finalRefinementBusyRef.current = false;
          setRefinedTranscript({
            status: refinementModeRef.current === 'off' ? 'off' : 'idle',
            text: '',
            error: null,
            model: whisperSetup?.refinerModel ?? polisherSetup?.model ?? null,
            mode: refinementModeRef.current,
            updatedAt: null,
          });
        }
        pendingTranscriptionWindowsRef.current = [];
        pendingFinalWindowsRef.current = [];
        finalBusyRef.current = false;
        previewBlockedByFinalCountRef.current = 0;
        transcriptionBusyRef.current = false;
        vadRef.current.reset();
        vadShortAccumRef.current = null;
        forceMicWindowLastAtRef.current = 0;
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
        finalizedSegmentIdsRef.current.clear();
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
          previewBusyLive: false,
          finalBusyLive: false,
          previewBlockedByFinalCount: 0,
        });
        if (!preserveSession) {
          pendingPolishJobRef.current = null;
          cleanContextRef.current = '';
        }
        setCaptureMode(mode);
        lastCaptureModeRef.current = mode;
        setCaptureStartedAt((current) => (preserveSession && current !== null ? current : Date.now()));
        if (!preserveSession) {
          setCaptureElapsedSeconds(0);
        }
        const now = Date.now();
        lastAudioRmsAtRef.current = null;
        lastNonSilentAudioAtRef.current = null;
        audioTrackEndedAtRef.current = null;
        patchCaptureHealth({
          captureHealth: options?.reconnect ? 'recovering' : 'ok',
          audioTrackReadyState: 'none',
          audioTrackMuted: false,
          audioTrackEndedAt: null,
          lastAudioRmsAt: null,
          lastNonSilentAudioAt: null,
          lastCheckedAt: now,
          message: options?.reconnect ? 'Reconectando audio...' : null,
        });
        addLog(options?.reconnect ? `reconectando audio: ${mode}` : `iniciando captura: ${mode}`);
        const captureStartPayload = {
          mode,
          selectedMicId,
          selectedSystemInputId,
          systemCaptureStrategy,
          selectedDesktopSourceId,
          inputDevices: inputDevices.map((device) => ({ deviceId: device.deviceId, groupId: device.groupId, label: device.label })),
          outputDevices: outputDevices.map((device) => ({ deviceId: device.deviceId, groupId: device.groupId, label: device.label })),
          desktopSources,
          nativeMediaAccess,
          browserPermissions: {
            micPermission,
            systemPermission,
          },
        };
        captureDiag('capture:start', captureStartPayload);
        debug('capture:start', captureStartPayload);

        const captured: MediaStream[] = [];
        let micCaptured = false;
        let systemMediaCaptured = false;
        let systemPcmHelperActive = false;
        let micStream: MediaStream | null = null;

        /* `both`: system first, then mic. Parallel start caused CoreAudio Tap RMS probe to race with
         * getUserMedia / permission UI (macOS can re-route I/O), leading to silent probe → tap stop
         * → fallback to display loopback and broken audio. */
        if (mode === 'system' || mode === 'both') {
          try {
            const result = await captureSystem();
            if (result.kind === 'pcm-helper') {
              systemPcmHelperActive = true;
            } else {
              captured.push(result.stream);
              systemMediaCaptured = true;
            }
          } catch {
            addLog('system: no disponible para esta sesión');
          }
        }

        if (mode === 'mic' || mode === 'both') {
          try {
            micStream = await captureMic();
            micCaptured = true;
          } catch {
            addLog('mic: no disponible para esta sesión');
          }
        }

        if (micStream) {
          captured.unshift(micStream);
        }
        const systemCaptured = systemMediaCaptured || systemPcmHelperActive;
        systemPcmHelperOnlyRef.current = mode === 'system' && systemPcmHelperActive;
        setSessionAudioSources({ mic: micCaptured, system: systemCaptured });

        const hasLiveStreamTranscription = captured.length > 0;
        const hasPcmOnlySystem = systemPcmHelperActive && !systemMediaCaptured;

        if (hasLiveStreamTranscription) {
          await ensureRunningAudioContext();
          const mixedStream = buildMixedStream(captured);
          const transcriptSource: SourceKey =
            (mode === 'both' && hasPcmOnlySystem && captured.length === 1)
              ? 'mic'
              : (captured.length > 1 ? 'mixed' : mode === 'system' ? 'system' : 'mic');
          captureDiag('capture:mixed:stream', { source: transcriptSource, stream: describeStream(mixedStream) });
          debug('capture:mixed:stream', { source: transcriptSource, stream: describeStream(mixedStream) });
          startLiveTranscription(mixedStream, transcriptSource);
          const graceUntil = Date.now() + CAPTURE_WATCHDOG_GRACE_MS;
          captureWatchdogGraceUntilRef.current = Math.max(captureWatchdogGraceUntilRef.current, graceUntil);
          audioEndedWatchdogStreakRef.current = 0;
          patchCaptureHealth({
            captureHealth: 'ok',
            message: null,
            lastCheckedAt: Date.now(),
          });
          if (mode === 'both') {
            if (micCaptured && !systemMediaCaptured && !systemPcmHelperActive) {
              showToast('System audio unavailable. Using microphone only.');
            } else if (micCaptured && systemPcmHelperActive && !systemMediaCaptured) {
              showToast('System PCM helper active; mic and system are transcribed on separate paths.');
            } else if (!micCaptured && systemMediaCaptured) {
              showToast('Microphone unavailable. Using system audio only.');
            } else if (!micCaptured && systemPcmHelperActive) {
              showToast('Microphone unavailable. Using system PCM helper only.');
            }
          }
        } else if (systemPcmHelperActive) {
          await ensureRunningAudioContext();
          liveTranscriptionSourceRef.current = 'system';
          patchCaptureHealth({
            captureHealth: 'ok',
            message: mode === 'system'
              ? 'Listening to system PCM helper. Transcription uses helper audio only.'
              : 'System PCM helper active without a microphone stream.',
            lastCheckedAt: Date.now(),
          });
          if (mode === 'system') {
            addLog('system: transcripción solo por helper PCM (sin MediaStream).');
          }
        } else {
          patchMeter('mixed', {
            status: 'failed',
            error: 'empty-stream: no hay fuentes activas para mezclar ni transcribir',
          });
          patchCaptureHealth({
            captureHealth: 'failed',
            message: 'No hay fuentes de audio activas para transcribir.',
            lastCheckedAt: Date.now(),
          });
          showToast('Could not start audio. Check microphone and system capture in Settings.');
        }

        startMeterLoop();
        } finally {
          captureStartInProgressRef.current = false;
        }
      }),
    [
      addLog,
      buildMixedStream,
      captureMic,
      captureSystem,
      desktopSources,
      inputDevices,
      micPermission,
      nativeMediaAccess,
      patchCaptureHealth,
      patchMeter,
      selectedDesktopSourceId,
      selectedMicId,
      selectedOutputId,
      selectedSystemInputId,
      systemCaptureStrategy,
      startMeterLoop,
      startLiveTranscription,
      stopCaptureCore,
      systemPermission,
      outputDevices,
      resetV2Main,
      resetV2Shadow,
      showToast,
      whisperSetup,
      polisherSetup,
    ],
  );

  const reconnectAudioCapture = useCallback(async (source: 'manual' | 'auto' = 'manual') => {
    const mode = lastCaptureModeRef.current ?? captureMode;
    debug('capture:reconnect-requested', {
      source,
      mode,
      captureMode,
      recoveryInFlight: recoveryInFlightRef.current,
      appMode: appModeRef.current,
      health: captureHealthRef.current,
      streams: Object.fromEntries(
        Object.entries(streamsRef.current).map(([streamSource, stream]) => [streamSource, stream ? describeStream(stream) : null]),
      ),
    });
    captureDiag('capture:reconnect-requested', {
      source,
      mode,
      captureMode,
      recoveryInFlight: recoveryInFlightRef.current,
      appMode: appModeRef.current,
      health: captureHealthRef.current,
    });
    if (!mode || recoveryInFlightRef.current) return;
    recoveryInFlightRef.current = true;
    patchCaptureHealth({
      captureHealth: 'recovering',
      message: 'Reconectando audio...',
      lastCheckedAt: Date.now(),
    });
    addLog(source === 'auto' ? 'recovery started: reconectando audio automáticamente' : 'recovery started: reconectando audio');
    debug('capture:recovery-start', {
      source,
      mode,
      health: captureHealthRef.current,
    });
    try {
      await startCapture(mode, { preserveSession: true, reconnect: true });
      patchCaptureHealth({
        captureHealth: 'ok',
        message: null,
        lastCheckedAt: Date.now(),
      });
      addLog('recovery success: audio reconectado');
      debug('capture:recovery-success', { source, mode });
    } catch (error) {
      patchCaptureHealth({
        captureHealth: 'failed',
        message: 'No pude reconectar el audio. Inténtalo de nuevo desde Configuración.',
        lastCheckedAt: Date.now(),
      });
      addLog(`recovery failed: ${String(error)}`);
      debug('capture:recovery-failed', { source, mode, error: String(error) });
    } finally {
      recoveryInFlightRef.current = false;
    }
  }, [addLog, captureMode, patchCaptureHealth, startCapture]);

  const applyCapturePreferenceFromMenu = useCallback(
    (mode: CapturePreference) => {
      debug('capture:preference-change', {
        mode,
        previousMode: capturePreference,
        activeCaptureMode: captureMode,
        appMode: appModeRef.current,
      });
      setCapturePreference(mode);
      persistCapturePreference(mode);
      if (captureMode) {
        void startCapture(mode, { preserveSession: true });
      }
    },
    [captureMode, capturePreference, startCapture],
  );

  useEffect(() => {
    if (!captureMode) return undefined;
    if (captureWatchdogRef.current !== null) {
      window.clearInterval(captureWatchdogRef.current);
    }

    const checkCaptureHealth = () => {
      const now = Date.now();
      const mode = lastCaptureModeRef.current ?? captureMode;
      const watchedSource: SourceKey =
        mode === 'mic'
          ? 'mic'
          : streamsRef.current.mixed
            ? 'mixed'
            : streamsRef.current.system
              ? 'system'
              : 'mixed';
      const watchedStream = streamsRef.current[watchedSource];
      const fallbackStream = streamsRef.current.mixed ?? streamsRef.current.system ?? streamsRef.current.mic;
      const audioTrack = (watchedStream ?? fallbackStream)?.getAudioTracks()[0] ?? null;
      const readyState = audioTrack?.readyState ?? 'none';
      const muted = Boolean(audioTrack?.muted);
      const lastAudioRmsAt = lastAudioRmsAtRef.current;
      const lastNonSilentAudioAt = lastNonSilentAudioAtRef.current;
      const lastProcessorFrameAt = lastProcessorFrameAtRef.current;
      const systemTrack = streamsRef.current.system?.getAudioTracks()[0] ?? null;
      const mixedTrack = streamsRef.current.mixed?.getAudioTracks()[0] ?? null;
      const micTrack = streamsRef.current.mic?.getAudioTracks()[0] ?? null;
      const currentMeters = metersRef.current;
      const meterSnapshot = {
        mic: {
          rms: Number(currentMeters.mic.rms.toFixed(5)),
          status: currentMeters.mic.status,
          silence: currentMeters.mic.silence,
        },
        system: {
          rms: Number(currentMeters.system.rms.toFixed(5)),
          status: currentMeters.system.status,
          silence: currentMeters.system.silence,
        },
        mixed: {
          rms: Number(currentMeters.mixed.rms.toFixed(5)),
          status: currentMeters.mixed.status,
          silence: currentMeters.mixed.silence,
        },
      };
      const inGrace = now < captureWatchdogGraceUntilRef.current;
      let nextHealth: CaptureHealth = 'ok';
      let message: string | null = null;
      let reason = 'healthy';

      if (!audioTrack) {
        audioEndedWatchdogStreakRef.current = 0;
        if (captureStartInProgressRef.current) {
          nextHealth = 'ok';
          message = null;
          reason = 'start-in-progress-no-primary-yet';
        } else {
          nextHealth = 'failed';
          message = 'No encuentro un track de audio activo para transcribir.';
          reason = 'missing-primary-audio-track';
        }
      } else if (readyState === 'ended') {
        if (inGrace) {
          audioEndedWatchdogStreakRef.current = 0;
          nextHealth = 'ok';
          message = null;
          reason = 'primary-ended-in-grace';
        } else {
          audioEndedWatchdogStreakRef.current += 1;
          if (audioEndedWatchdogStreakRef.current >= AUDIO_ENDED_DEBOUNCE_TICKS) {
            nextHealth = 'audio-ended';
            message = 'El audio del sistema se interrumpió. Puedes reconectar la captura.';
            audioTrackEndedAtRef.current = audioTrackEndedAtRef.current ?? now;
            reason = 'primary-ended-debounced';
          } else {
            nextHealth = 'ok';
            message = null;
            reason = 'primary-ended-debounce-wait';
          }
        }
      } else if (muted) {
        audioEndedWatchdogStreakRef.current = 0;
        nextHealth = 'silent';
        message = 'El audio está silenciado.';
        reason = 'primary-muted';
      } else if (
        lastProcessorFrameAt === null &&
        !inGrace &&
        now - captureWatchdogGraceUntilRef.current > AUDIO_WATCHDOG_INTERVAL_MS &&
        mode !== 'mic'
      ) {
        audioEndedWatchdogStreakRef.current = 0;
        if (captureStartInProgressRef.current) {
          nextHealth = 'ok';
          message = null;
          reason = 'start-in-progress-no-processor-frames-yet';
        } else {
          nextHealth = 'failed';
          message = 'La captura está activa, pero el procesador de transcripción no recibe frames de audio.';
          reason = 'processor-no-frames-after-grace';
        }
      } else if (
        lastNonSilentAudioAt === null &&
        lastAudioRmsAt !== null &&
        !inGrace &&
        now - captureWatchdogGraceUntilRef.current > AUDIO_SILENT_WARNING_MS &&
        mode !== 'mic'
      ) {
        audioEndedWatchdogStreakRef.current = 0;
        nextHealth = 'silent';
        message = 'El audio del sistema está conectado, pero no llega señal audible.';
        reason = 'system-never-non-silent-after-grace';
      } else if (
        lastNonSilentAudioAt !== null &&
        now - lastNonSilentAudioAt > AUDIO_SILENT_WARNING_MS &&
        mode !== 'mic'
      ) {
        audioEndedWatchdogStreakRef.current = 0;
        nextHealth = 'silent';
        message = 'El audio del sistema está en silencio desde hace varios segundos.';
        reason = 'system-silent-timeout';
      } else {
        audioEndedWatchdogStreakRef.current = 0;
      }

      const watchdogPayload = {
        mode,
        primarySource: watchedSource,
        primaryReadyState: readyState,
        primaryMuted: muted,
        systemReadyState: systemTrack?.readyState ?? 'none',
        systemMuted: systemTrack?.muted ?? null,
        systemEnabled: systemTrack?.enabled ?? null,
        systemTrackId: systemTrack?.id ?? null,
        mixedReadyState: mixedTrack?.readyState ?? 'none',
        mixedMuted: mixedTrack?.muted ?? null,
        mixedEnabled: mixedTrack?.enabled ?? null,
        mixedTrackId: mixedTrack?.id ?? null,
        micReadyState: micTrack?.readyState ?? 'none',
        micMuted: micTrack?.muted ?? null,
        micEnabled: micTrack?.enabled ?? null,
        micTrackId: micTrack?.id ?? null,
        nextHealth,
        reason,
        inGrace,
        recoveryInFlight: recoveryInFlightRef.current,
        startInProgress: captureStartInProgressRef.current,
        appMode: appModeRef.current,
        generation: captureGenerationRef.current,
        graceUntil: captureWatchdogGraceUntilRef.current,
        endedStreak: audioEndedWatchdogStreakRef.current,
        lastAudioRmsAt,
        lastNonSilentAudioAt,
        lastProcessorFrameAt,
        meters: meterSnapshot,
      };
      captureDiag('capture:watchdog', watchdogPayload);

      patchCaptureHealth({
        captureHealth: recoveryInFlightRef.current ? 'recovering' : nextHealth,
        audioTrackReadyState: readyState,
        audioTrackMuted: muted,
        audioTrackEndedAt: audioTrackEndedAtRef.current,
        lastAudioRmsAt: lastAudioRmsAt === null ? null : Math.round(lastAudioRmsAt),
        lastNonSilentAudioAt: lastNonSilentAudioAt === null ? null : Math.round(lastNonSilentAudioAt),
        lastCheckedAt: now,
        message,
      });

      if (
        nextHealth === 'audio-ended' &&
        isAutoRecoverSystemAudioEnabled() &&
        !recoveryInFlightRef.current &&
        now >= captureWatchdogGraceUntilRef.current
      ) {
        const recentAttempts = recoveryAttemptTimesRef.current.filter((attemptAt) => now - attemptAt < 60_000);
        recoveryAttemptTimesRef.current = recentAttempts;
        if (recentAttempts.length < MAX_AUTO_RECOVERY_ATTEMPTS_PER_MINUTE) {
          recoveryAttemptTimesRef.current = [...recentAttempts, now];
          void reconnectAudioCapture('auto');
        }
      }
    };

    checkCaptureHealth();
    captureWatchdogRef.current = window.setInterval(checkCaptureHealth, AUDIO_WATCHDOG_INTERVAL_MS);
    return () => {
      if (captureWatchdogRef.current !== null) {
        window.clearInterval(captureWatchdogRef.current);
        captureWatchdogRef.current = null;
      }
    };
  }, [captureMode, patchCaptureHealth, reconnectAudioCapture]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName.toLowerCase();
      return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (appMode !== 'session' && appMode !== 'session-boot') return;
      const commandOrControl = event.metaKey || event.ctrlKey;
      const editable = isEditableTarget(event.target);

      if (commandOrControl && event.key === 'Enter') {
        event.preventDefault();
        if (!aiPanelOpen) {
          setAiPanelOpen(true);
          return;
        }
        askLocalAssistant();
        return;
      }

      if (commandOrControl && (event.key === '\\' || event.code === 'Backslash')) {
        event.preventDefault();
        setOverlayCollapsed((current) => !current);
        return;
      }

      if (event.key === 'Escape' && aiPanelOpen) {
        event.preventDefault();
        setAiPanelOpen(false);
        return;
      }

      if (event.code === 'Space' && !editable && !commandOrControl) {
        event.preventDefault();
        debug('session:space-toggle', {
          captureMode,
          capturePreference,
          appMode,
          health: captureHealthRef.current,
        });
        if (captureMode) {
          void stopCapture();
        } else {
          void startCapture(capturePreference);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [aiPanelOpen, appMode, askLocalAssistant, captureMode, capturePreference, startCapture, stopCapture]);

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

  const saveCurrentSessionSnapshot = useCallback(() => {
    const transcriptText = visibleTranscriptText.trim();
    const refinedText = refinedTranscript.text.trim();
    if (!transcriptText && rawSegments.length === 0) return;

    const createdAt = Date.now();
    const source = rawSegments[0]?.source ?? captureMode ?? 'system';
    const session: DashboardSessionSummary = {
      id: `session-${createdAt}`,
      title: createSessionTitle(createdAt),
      createdAt,
      durationSeconds: captureElapsedSeconds,
      transcriptPreview: transcriptText.slice(0, 180),
      transcriptText,
      refinedText: refinedText || undefined,
      source,
      status: 'completed',
    };
    setSavedSessions((current) => [session, ...current].slice(0, 20));
    setSelectedSavedSessionId(session.id);
  }, [captureElapsedSeconds, captureMode, rawSegments, refinedTranscript.text, visibleTranscriptText]);

  const onSessionUiFirstPaint = useCallback(() => {
    if (appModeRef.current !== 'session-boot' || !pendingSessionStartRef.current) return;
    if (!window.meetingAssistant.overlayWindow) return;
    pendingSessionStartRef.current = false;
    const mode: CapturePreference = 'both';

    void (async () => {
      try {
        await window.meetingAssistant.windowControls.setAppMode('session');
        try {
          performance.clearMarks('openwhispr-window-session-mode-applied');
          performance.mark('openwhispr-window-session-mode-applied');
        } catch {
          /* ignore */
        }
      } catch (error) {
        debug('session:first-paint:set-app-mode-session-error', String(error));
      }

      setAppMode('session');
      setPendingSessionStart(false);

      requestAnimationFrame(() => {
        if (shouldExpandSessionOverlay()) {
          window.meetingAssistant.windowControls.expandSessionOverlay();
          captureWatchdogGraceUntilRef.current = Math.max(
            captureWatchdogGraceUntilRef.current,
            Date.now() + CAPTURE_OVERLAY_EXPAND_GRACE_MS,
          );
          captureDiag('session:overlay-expand-after-first-paint', {
            captureMode: mode,
            timestampMs: Date.now(),
            performanceMs: Number(performance.now().toFixed(1)),
            health: captureHealthRef.current,
          });
        } else if (window.meetingAssistant.overlayWindow) {
          captureDiag('session:overlay-expand-skipped-after-first-paint', {
            reason: 'VITE_OPENWHISPR_DISABLE_OVERLAY_EXPAND=true',
            captureMode: mode,
          });
        }
        setSessionCaptureStarting(true);
        try {
          performance.clearMarks('openwhispr-capture-start');
          performance.mark('openwhispr-capture-start');
        } catch {
          /* ignore */
        }
        void startCapture(mode).finally(() => {
          setSessionCaptureStarting(false);
        });
      });
    })();
  }, [startCapture]);

  const startDashboardSession = useCallback(() => {
    const mode: CapturePreference = 'both';
    try {
      performance.clearMarks('openwhispr-new-session-click');
      performance.mark('openwhispr-new-session-click');
    } catch {
      /* ignore */
    }
    const startPayload = {
      requestedMode: mode,
      previousCapturePreference: capturePreference,
      appMode: appModeRef.current,
      captureMode,
      health: captureHealthRef.current,
      timestampMs: Date.now(),
    };
    captureDiag('session:start-request', startPayload);
    debug('session:start-request', startPayload);
    if (capturePreference !== 'both') {
      setCapturePreference('both');
      persistCapturePreference('both');
    }
    transcriptionTrace('startDashboardSession:begin', { captureMode: mode });
    setOverlayCollapsed(false);
    setAiPanelOpen(false);

    if (!window.meetingAssistant.overlayWindow) {
      setAppMode('session');
      try {
        performance.clearMarks('openwhispr-capture-start');
        performance.mark('openwhispr-capture-start');
      } catch {
        /* ignore */
      }
      void startCapture(mode)
        .then(() => {
          const resolvedPayload = {
            mode,
            appMode: appModeRef.current,
            captureMode: lastCaptureModeRef.current,
            health: captureHealthRef.current,
            streams: Object.fromEntries(
              Object.entries(streamsRef.current).map(([source, stream]) => [source, stream ? describeStream(stream) : null]),
            ),
          };
          captureDiag('session:start-capture-resolved', resolvedPayload);
          debug('session:start-capture-resolved', resolvedPayload);
        })
        .catch((error) => {
          const errorPayload = {
            mode,
            error: String(error),
            appMode: appModeRef.current,
            health: captureHealthRef.current,
          };
          captureDiag('session:start-capture-error', errorPayload);
          debug('session:start-capture-error', errorPayload);
        });
      if (getOnboardingSystemSkipped() && mode === 'both') {
        showToast('Note: System audio was skipped in setup; capture may be microphone-only until you enable it in Settings.');
      }
      return;
    }

    pendingSessionStartRef.current = true;
    setPendingSessionStart(true);
    setAppMode('session-boot');

    if (getOnboardingSystemSkipped() && mode === 'both') {
      showToast('Note: System audio was skipped in setup; capture may be microphone-only until you enable it in Settings.');
    }
  }, [captureMode, capturePreference, showToast, startCapture]);

  const finishDashboardSession = useCallback(async () => {
    const finishPayload = {
      appMode: appModeRef.current,
      captureMode,
      health: captureHealthRef.current,
      timestampMs: Date.now(),
      streams: Object.fromEntries(
        Object.entries(streamsRef.current).map(([source, stream]) => [source, stream ? describeStream(stream) : null]),
      ),
    };
    captureDiag('session:finish-request', finishPayload);
    debug('session:finish-request', finishPayload);
    saveCurrentSessionSnapshot();
    pendingSessionStartRef.current = false;
    setPendingSessionStart(false);
    setSessionCaptureStarting(false);
    await stopCapture({ reason: 'sesión finalizada' });
    setAiPanelOpen(false);
    setOverlayCollapsed(false);
    setAppMode('dashboard');
  }, [captureMode, saveCurrentSessionSnapshot, stopCapture]);

  const transcriptListeningHint = (() => {
    if (sessionCaptureStarting && !captureMode) return 'Starting capture…';
    if (!captureMode) return undefined;
    if (systemPcmHelperOnlyRef.current && captureMode === 'system') {
      return 'Listening to system PCM helper…';
    }
    if (sessionAudioSources.mic && sessionAudioSources.system) {
      return 'Listening to microphone and system audio';
    }
    if (sessionAudioSources.mic) return 'Listening to microphone only';
    if (sessionAudioSources.system) return 'Listening to system audio only';
    if (captureHealthState.captureHealth === 'failed') return undefined;
    if (captureMode === 'both') return 'Connecting audio sources…';
    return undefined;
  })();

  const statusTone: 'idle' | 'recording' | 'processing' | 'interrupted' | 'recovering' =
    captureHealthState.captureHealth === 'audio-ended' || captureHealthState.captureHealth === 'failed'
      ? 'interrupted'
      : captureHealthState.captureHealth === 'recovering'
        ? 'recovering'
        : transcriptionBusyRef.current || finalBusyRef.current
          ? 'processing'
          : captureMode
            ? 'recording'
            : 'idle';
  const statusLabel =
    sessionCaptureStarting && !captureMode
      ? 'Starting capture…'
      : statusTone === 'interrupted'
      ? 'Audio interrumpido'
      : statusTone === 'recovering'
        ? 'Reconectando…'
        : statusTone === 'processing'
          ? 'Procesando'
          : captureMode
            ? 'Escuchando'
            : 'Pausado';
  const timerLabel = captureMode ? formatTimer(captureElapsedSeconds) : '00:00';
  const askShortcutLabel = platform === 'darwin' ? '⌘ ↵' : 'Ctrl+Enter';
  const hideShortcutLabel = platform === 'darwin' ? '⌘ \\' : 'Ctrl+\\';
  const audioStatus = (() => {
    const meter = meters.mixed.status !== 'idle' ? meters.mixed : (meters.system.status !== 'idle' ? meters.system : meters.mic);
    if (captureHealthState.captureHealth === 'audio-ended') return 'audio-ended';
    if (meter.status === 'failed' || captureHealthState.captureHealth === 'failed') return 'ended';
    if (meter.clipping) return 'ok';
    if (meter.silence || captureHealthState.captureHealth === 'silent') return 'silent';
    return captureMode ? 'ok' : 'idle';
  })();
  const showReconnectAudio = Boolean(captureMode && ['audio-ended', 'failed'].includes(captureHealthState.captureHealth));

  const settingsPanel = (
    <div className="settings-grid">
      <div className="settings-section" id="settings-section-audio">
        <h3>Audio</h3>
        <p className="muted settings-section-lead">
          Devices, screen/window for system loopback, and default capture mode for new sessions. You can also change capture mode from the ⋮ menu during a session.
        </p>
        <fieldset className="capture-preference-fieldset">
          <legend>Capture mode</legend>
          <label className="capture-pref-option">
            <input
              type="radio"
              name="capture-preference"
              value="mic"
              checked={capturePreference === 'mic'}
              onChange={() => {
                setCapturePreference('mic');
                persistCapturePreference('mic');
              }}
            />
            Microphone only
          </label>
          <label className="capture-pref-option">
            <input
              type="radio"
              name="capture-preference"
              value="system"
              checked={capturePreference === 'system'}
              onChange={() => {
                setCapturePreference('system');
                persistCapturePreference('system');
              }}
            />
            System audio only
          </label>
          <label className="capture-pref-option">
            <input
              type="radio"
              name="capture-preference"
              value="both"
              checked={capturePreference === 'both'}
              onChange={() => {
                setCapturePreference('both');
                persistCapturePreference('both');
              }}
            />
            Microphone + system audio
          </label>
        </fieldset>
        <label className="field">
          <span>Microphone</span>
          <select value={selectedMicId} onChange={(event) => setSelectedMicId(event.target.value)}>
            {inputDevices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Micrófono ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>System audio source</span>
          <select
            value={systemCaptureStrategy}
            onChange={(event) => setSystemCaptureStrategy(event.target.value as SystemCaptureStrategy)}
          >
            <option value="auto">Auto (recommended): CoreAudio Tap → virtual input → Electron loopback</option>
            <option value="coreaudio-tap">Native CoreAudio Tap</option>
            <option value="virtual-input">Virtual input only</option>
            <option value="native-electron-loopback">Electron loopback (experimental)</option>
            <option value="native-helper">ScreenCaptureKit helper (experimental)</option>
          </select>
        </label>
        <label className="field">
          <span>Screen / window for system capture</span>
          <select value={selectedDesktopSourceId} onChange={(event) => setSelectedDesktopSourceId(event.target.value)}>
            <option value="">Auto (first source in list)</option>
            {desktopSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
        {platform === 'darwin' ? (
          <p className="muted settings-field-hint">
            Auto does not use ScreenCaptureKit. CoreAudio Tap is the primary macOS path when the helper is built (
            <code className="break-anywhere">npm run build:macos-coreaudio-tap-helper</code>
            ). Electron loopback can be live but silent on some setups. ScreenCaptureKit is experimental; on many machines{' '}
            <code>startCapture</code> never returns (
            <strong>SCK_START_TIMEOUT</strong>
            ) even when Screen Recording is granted — do not rely on it as the default.
          </p>
        ) : null}
        {platform === 'darwin' ? (
          <div className="settings-inline-status">
            <span>
              CoreAudio Tap helper:{' '}
              {coreAudioTapHelperCheck?.ok
                ? (coreAudioTapHelperCheck.running ? 'running' : 'ready')
                : (coreAudioTapHelperCheck?.error ?? 'checking')}
            </span>
            <button type="button" className="secondary" onClick={() => void refreshCoreAudioTapHelperCheck()}>
              Refresh
            </button>
          </div>
        ) : null}
        {platform === 'darwin' ? (
          <div className="settings-inline-status">
            <span>
              ScreenCaptureKit helper:{' '}
              {systemAudioHelperCheck?.ok
                ? (systemAudioHelperCheck.running ? 'running' : 'ready')
                : (systemAudioHelperCheck?.error ?? 'checking')}
            </span>
            <button type="button" className="secondary" onClick={() => void refreshSystemAudioHelperCheck()}>
              Refresh
            </button>
          </div>
        ) : null}
        <label className="field">
          <span>Virtual / loopback input</span>
          <select value={selectedSystemInputId} onChange={(event) => setSelectedSystemInputId(event.target.value)}>
            <option value="">Auto (virtual drivers only; {virtualSystemInputs.length || 'none found'})</option>
            {virtualSystemInputs.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Virtual input ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        {platform === 'darwin' && virtualSystemInputs.length === 0 ? (
          <p className="muted settings-field-hint">
            No virtual loopback device detected (BlackHole, Loopback, VB-CABLE, etc.). Install one and route system output into it for reliable capture when CoreAudio Tap is unavailable.
          </p>
        ) : null}
      </div>

      <div className="settings-section">
        <h3>Captura</h3>
        <p className="muted settings-section-lead">Session controls and diagnostics. Set default capture mode under Audio.</p>
        <div className="button-grid compact">
          <button className="secondary" onClick={() => void stopCapture()}>Detener captura</button>
        </div>
        <button className="secondary full-width" disabled={!captureMode || recording} onClick={() => void startTestRecording()}>
          {recording ? `Grabando ${recordingSecondsLeft}s` : 'Grabar prueba 30 segundos'}
        </button>
        <button
          className="secondary full-width"
          disabled={!captureMode || captureHealthState.captureHealth === 'recovering'}
          onClick={() => void reconnectAudioCapture('manual')}
        >
          Reconectar audio
        </button>
        <button className="secondary full-width" onClick={() => void finishDashboardSession()}>
          Finalizar y volver al inicio
        </button>
      </div>

      <div className="settings-section">
        <h3>Estado</h3>
        <p>ASR principal: Whisper Large V3 Turbo</p>
        <p>IA local: {polisherSetup?.ok ? 'lista' : 'no disponible'}</p>
        <p>Audio: {audioStatus}</p>
        {captureHealthState.message && <p>{captureHealthState.message}</p>}
        <p>RMS: {meters.mixed.rms.toFixed(3)}</p>
        {asrFinalEngine === 'compare' && <p>Comparación Qwen activa</p>}
        {whisperSetup?.experimentalPreview && <p>Preview experimental activo</p>}
        {savedWav && <p className="break-anywhere">WAV: {savedWav.path}</p>}
      </div>
    </div>
  );

  const debugPanel = (
    <div className="debug-stack">
      <button className="secondary full-width" type="button" onClick={() => setShowRawDebug((current) => !current)}>
        {showRawDebug ? 'Ocultar laboratorio' : 'Mostrar laboratorio'}
      </button>
      <div className="debug-metrics">
        <span>audioTrackReadyState: {captureHealthState.audioTrackReadyState}</span>
        <span>audioTrackMuted: {String(captureHealthState.audioTrackMuted)}</span>
        <span>audioTrackEndedAt: {captureHealthState.audioTrackEndedAt ? new Date(captureHealthState.audioTrackEndedAt).toLocaleTimeString() : 'none'}</span>
        <span>lastAudioRmsAt: {captureHealthState.lastAudioRmsAt ? new Date(captureHealthState.lastAudioRmsAt).toLocaleTimeString() : 'none'}</span>
        <span>lastNonSilentAudioAt: {captureHealthState.lastNonSilentAudioAt ? new Date(captureHealthState.lastNonSilentAudioAt).toLocaleTimeString() : 'none'}</span>
        <span>captureHealth: {captureHealthState.captureHealth}</span>
        <span>rms: {meters.mixed.rms.toFixed(3)}</span>
        <span>audioStatus: {audioStatus}</span>
      </div>
      <details>
        <summary>Eventos</summary>
        {diagnosticLog.length === 0 ? <p className="muted">Sin eventos visibles.</p> : (
          <ul className="debug-list">{diagnosticLog.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ul>
        )}
      </details>
      {showRawDebug && (
        <>
          <details open>
            <summary>Segmentos</summary>
            <ol className="transcript-list raw-list">
              {rawSegments.map((segment) => (
                <li key={segment.id}>
                  <div className="segment-meta">
                    <time>{formatMs(segment.startMs)} - {formatMs(segment.endMs)}</time>
                    <span className="source-tag">{segment.source}</span>
                    <span className="source-tag">{segment.status}</span>
                    <span className="source-tag">RMS {segment.rms.toFixed(3)}</span>
                    {segment.engineUsed && <span className="source-tag">engine {segment.engineUsed}</span>}
                    {segment.qwenText && <span className="source-tag">qwen</span>}
                    {segment.qwenError && <span className="source-tag warning-tag">qwen error</span>}
                    {segment.fallbackUsed && <span className="source-tag warning-tag">fallback</span>}
                  </div>
                  <p>{segment.text}</p>
                  {segment.whisperText && <p className="muted">whisperText: {segment.whisperText}</p>}
                  {segment.qwenText && <p className="muted">qwenText: {segment.qwenText}</p>}
                  {segment.qwenError && <p className="muted">qwenError: {segment.qwenError}</p>}
                </li>
              ))}
            </ol>
          </details>
          <details>
            <summary>Laboratorio visual</summary>
            <LiveTranscriptView
              committedText={v2DemoTranscript.committedText}
              previewSuffix={v2DemoTranscript.previewSuffix}
              rawPreview={v2DemoTranscript.rawPreview}
              showDebug
              pipelineLabel="Contrato visual"
            />
            <div className="button-row v2-demo-buttons">
              <button className="secondary" type="button" onClick={runV2DemoPreviewOne}>Preview 1</button>
              <button className="secondary" type="button" onClick={runV2DemoPreviewTwo}>Preview 2</button>
              <button className="secondary" type="button" onClick={runV2DemoDifferentPreview}>Divergente</button>
              <button className="secondary" type="button" onClick={runV2DemoFinal}>Final</button>
              <button className="secondary" type="button" onClick={resetV2Demo}>Reset</button>
            </div>
          </details>
        </>
      )}
    </div>
  );

  const setupOverlay = setupWizardOpen ? (
    <SetupOnboarding
      whisperOk={Boolean(whisperSetup?.ok)}
      whisperMessage={whisperSetup?.message ?? 'Run whisper setup from the project scripts.'}
      aiOk={Boolean(polisherSetup?.ok)}
      aiMessage={polisherSetup?.message ?? 'Optional: configure local AI for Ask AI.'}
      onFinished={() => {
        markOnboardingComplete();
        setSetupWizardOpen(false);
      }}
    />
  ) : null;

  if (appMode === 'dashboard') {
    return (
      <>
        {setupOverlay}
        <DashboardHome
          userName="Michael"
          sessions={savedSessions}
          onStartSession={startDashboardSession}
          onOpenSession={(session) => setSelectedSavedSessionId(session.id)}
          onClearSessions={clearSavedSessions}
          onNotify={showToast}
          onRerunSetup={() => setSetupWizardOpen(true)}
        />
        <PremiumToast message={toastMessage} onDismiss={() => setToastMessage(null)} />
      </>
    );
  }

  return (
    <>
      {setupOverlay}
      <FloatingAssistantShell
        booting={appMode === 'session-boot' && window.meetingAssistant.overlayWindow}
        onFirstPaint={onSessionUiFirstPaint}
        statusLabel={statusLabel}
        statusTone={statusTone}
        timerLabel={timerLabel}
        askShortcutLabel={askShortcutLabel}
        hideShortcutLabel={hideShortcutLabel}
        isCapturing={Boolean(captureMode)}
        overlayCollapsed={overlayCollapsed}
        aiPanelOpen={aiPanelOpen}
        transcriptText={visibleTranscriptText}
        refinedText={refinedTranscript.text}
        transcriptView={transcriptView}
        refinementAvailable={Boolean(refinedTranscript.text)}
        localAiReady={Boolean(polisherSetup?.ok)}
        chatMessages={chatMessages}
        chatInput={chatInput}
        chatBusy={chatBusy}
        chatError={chatError}
        reconnectAudioVisible={showReconnectAudio}
        onTranscriptViewChange={setTranscriptView}
        onCopyTranscript={copyTranscript}
        onChatInputChange={setChatInput}
        onChatSubmit={askLocalAssistant}
        onCopyLastAiResponse={copyLastAiResponse}
        onOpenAiPanel={() => setAiPanelOpen(true)}
        onCloseAiPanel={() => setAiPanelOpen(false)}
        onReconnectAudio={() => void reconnectAudioCapture('manual')}
        onToggleCapture={() => {
          debug('session:topbar-toggle-capture', {
            captureMode,
            capturePreference,
            appMode: appModeRef.current,
            health: captureHealthRef.current,
          });
          if (captureMode) {
            void finishDashboardSession();
          } else {
            void startCapture(capturePreference);
          }
        }}
        onToggleOverlay={() => setOverlayCollapsed((current) => !current)}
        settingsOpen={sessionSettingsOpen}
        onSettingsOpenChange={setSessionSettingsOpen}
        settingsAudioScrollNonce={settingsAudioScrollNonce}
        onHome={() => {
          debug('session:home-request', {
            captureMode,
            appMode: appModeRef.current,
            health: captureHealthRef.current,
          });
          setHomeConfirmOpen(true);
        }}
        onOpenAudioSettings={() => {
          setSessionSettingsOpen(true);
          setSettingsAudioScrollNonce((n) => n + 1);
        }}
        onEndSession={() => {
          debug('session:end-request', {
            captureMode,
            appMode: appModeRef.current,
            health: captureHealthRef.current,
          });
          setHomeConfirmOpen(true);
        }}
        capturePreference={capturePreference}
        onCapturePreferenceChange={applyCapturePreferenceFromMenu}
        transcriptListeningHint={transcriptListeningHint}
        homeConfirmDialog={
          <HomeConfirmDialog
            open={homeConfirmOpen}
            onConfirm={() => {
              debug('session:home-confirmed', {
                captureMode,
                appMode: appModeRef.current,
                health: captureHealthRef.current,
              });
              setHomeConfirmOpen(false);
              void finishDashboardSession();
            }}
            onCancel={() => setHomeConfirmOpen(false)}
          />
        }
        settings={settingsPanel}
        debug={debugPanel}
      />
      <PremiumToast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </>
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

function prepareWhisperSamples(
  samples: Float32Array,
  opts?: { lowRmsDebug?: boolean },
) {
  const lowRms = Boolean(opts?.lowRmsDebug ?? isLowRmsDebugEnabled());
  const boosted = lowRms ? applyGain(samples, 10) : samples;
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < boosted.length; index += 1) {
    const sample = boosted[index];
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  const gain = peak > WHISPER_PEAK_TARGET ? WHISPER_PEAK_TARGET / peak : 1;
  const processedSamples = gain === 1 ? boosted : applyGain(boosted, gain);
  return {
    rms: Math.sqrt(sum / Math.max(1, boosted.length)),
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
