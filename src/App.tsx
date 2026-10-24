import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { encodeWav } from './audio/wav';
import { CONTROL_BAR_WAVEFORM_BARS, fillControlBarSpectrumFromAnalyser } from './audio/controlBarSpectrum';
import {
  filterVirtualSystemInputCandidates,
  runSystemAudioEngine,
  SystemAudioEngineError,
  type SystemAudioDeviceCandidate,
  type SystemAudioProviderId,
  type SystemAudioStrategy,
} from './audio/systemAudioEngine';
import {
  buildFinalTranscriptRefinementPrompt,
  shouldCreateRefinementBatch,
  type RefinementSegmentInput,
} from './transcription/finalTranscriptRefiner';
import { DashboardHome } from './components/DashboardHome';
import { NewSessionModal, type NewSessionContext } from './components/NewSessionModal';
import { ContextSpaceAssignmentModal } from './components/ContextSpaceAssignmentModal';
import type { DashboardSessionSummary } from './types/dashboardSession';
import { HomeConfirmDialog } from './components/HomeConfirmDialog';
import { FloatingAssistantShell } from './components/FloatingAssistantShell';
import { SetupOnboarding } from './components/SetupOnboarding';
import { PremiumToast } from './components/PremiumToast';
import type { AssistantChatMessage } from './components/AssistantChatPanel';
import { copyToClipboard } from './utils/copyToClipboard';
import { generateMeetingSummaryLine, generateMeetingTitle } from './utils/generateMeetingSummary';
import { buildMeetingAgentMemory } from './utils/meetingAgentInsights';
import {
  getOnboardingSystemSkipped,
  isOnboardingComplete,
  loadAppLanguage,
  loadCapturePreference,
  loadContextSpaces,
  loadPromptProfiles,
  loadSelectedSystemInputId,
  loadSelectedPromptProfileId,
  loadSystemCaptureStrategy,
  loadUserProfile,
  persistAppLanguage,
  persistCapturePreference,
  persistContextSpaces,
  persistPromptProfiles,
  persistSelectedSystemInputId,
  persistSelectedPromptProfileId,
  persistSystemCaptureStrategy,
  persistUserProfile,
  type AppLanguage,
  type CapturePreference,
  type PromptProfile,
  type ContextSpace,
  type SystemCaptureStrategy,
  type UserProfile,
} from './storage/appPreferences';
import { readDashboardTheme } from './storage/dashboardTheme';
import { describeEngine, type CommittedSegment } from './transcription/transcriptCoordinator';
import type { AsrEngineName, AsrLanguage, AsrLiveEvent, TranscriptRefinementMode } from './transcription/types';
import { useLiveAsr, type LiveAsrFrameInfo } from './hooks/useLiveAsr';
type SourceKey = 'mic' | 'system' | 'mixed';
type CaptureMode = 'mic' | 'system' | 'both';
type AppMode = 'dashboard' | 'session-boot' | 'session';
type CaptureStatus = 'idle' | 'requesting_permission' | 'capturing' | 'silence' | 'failed' | 'stopped';
type CaptureHealth = 'ok' | 'silent' | 'audio-ended' | 'recovering' | 'failed';
type TranscriptViewMode = 'verbatim' | 'clean';

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
  language?: AsrLanguage;
  engineUsed?: AsrEngineName;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  whisperText?: string;
  qwenText?: string;
  whisperDurationMs?: number;
  qwenDurationMs?: number;
  qwenError?: string;
}

interface PolisherSetupState {
  ok: boolean;
  model: string;
  message: string;
}

interface RefinedTranscriptState {
  status: 'off' | 'idle' | 'generating' | 'ready' | 'error';
  text: string;
  error: string | null;
  model: string | null;
  mode: TranscriptRefinementMode;
  updatedAt: number | null;
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

const METER_REACT_PUBLISH_MS = 250;

const SILENCE_THRESHOLD = 0.01;
const CLIPPING_THRESHOLD = 0.98;
const AUDIO_WATCHDOG_INTERVAL_MS = 1_500;
const AUDIO_SILENT_WARNING_MS = 12_000;
const SYSTEM_SIGNAL_CHECK_TIMEOUT_MS = 3500;
const SYSTEM_SIGNAL_CHECK_INTERVAL_MS = 200;
const SYSTEM_SIGNAL_CHECK_RMS = 0.003;
const SYSTEM_SIGNAL_CHECK_PEAK = 0.01;
const SYSTEM_SIGNAL_CHECK_REQUIRED_HITS = 2;
/** PCM helpers: consecutive chunk samples that prove IPC is flowing (silence is OK). */
const SYSTEM_PCM_CHUNK_REQUIRED_HITS = 2;
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

/** Lee las sesiones heredadas de `localStorage` solo para la migración única hacia SQLite. */
function loadLegacySavedSessionsFromLocalStorage(): DashboardSessionSummary[] {
  try {
    const raw = localStorage.getItem(SAVED_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DashboardSessionSummary[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((session) => typeof session.id === 'string' && typeof session.createdAt === 'number');
  } catch {
    return [];
  }
}


function createSessionTitle(createdAt: number) {
  return `Meeting ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(createdAt))}`;
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
  const currentSessionContextRef = useRef<NewSessionContext | null>(null);
  const [savedSessions, setSavedSessions] = useState<DashboardSessionSummary[]>([]);
  const savedSessionsHydratedRef = useRef(false);
  const knownSessionIdsRef = useRef<Set<string>>(new Set());
  const [selectedSavedSessionId, setSelectedSavedSessionId] = useState<string | null>(null);
  const [newSessionModalOpen, setNewSessionModalOpen] = useState(false);
  const [meetingSummaryBusy, setMeetingSummaryBusy] = useState(false);
  const [platform, setPlatform] = useState<NodeJS.Platform | 'unknown'>('unknown');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [desktopSources, setDesktopSources] = useState<DesktopSource[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [selectedSystemInputId, setSelectedSystemInputId] = useState<string>(() => loadSelectedSystemInputId());
  const [systemCaptureStrategy, setSystemCaptureStrategy] = useState<SystemCaptureStrategy>(() => loadSystemCaptureStrategy());
  const [appLanguage, setAppLanguage] = useState<AppLanguage>(() => loadAppLanguage());
  const [userProfile, setUserProfile] = useState<UserProfile>(() => loadUserProfile());
  const [promptProfiles, setPromptProfiles] = useState<PromptProfile[]>(() => loadPromptProfiles());
  const [contextSpaces, setContextSpaces] = useState<ContextSpace[]>(() => loadContextSpaces());
  const [selectedPromptProfileId, setSelectedPromptProfileId] = useState<string>(() => loadSelectedPromptProfileId());
  const [contextAssignSession, setContextAssignSession] = useState<DashboardSessionSummary | null>(null);
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
  const meterReactPublishTimerRef = useRef<number | null>(null);
  const lastMeterReactPublishAtRef = useRef(0);
  const [diagnosticLog, setDiagnosticLog] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingSecondsLeft, setRecordingSecondsLeft] = useState(30);
  const [savedWav, setSavedWav] = useState<{ path: string; fileUrl: string } | null>(null);
  const [rawSegments, setRawSegments] = useState<TranscriptSegment[]>([]);
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
  const [whisperSetup, setWhisperSetup] = useState<AsrSetupStatus | null>(null);
  const [polisherSetup, setPolisherSetup] = useState<PolisherSetupState | null>(null);
  const [glossary] = useState(DEFAULT_GLOSSARY);
  const [showRawDebug, setShowRawDebug] = useState(false);
  const showRawDebugRef = useRef(showRawDebug);
  showRawDebugRef.current = showRawDebug;
  const [transcriptViewMode, setTranscriptViewMode] = useState<TranscriptViewMode>('verbatim');
  const whisperLanguage: AsrLanguage = appLanguage;
  const refinementMode = whisperSetup?.refinementMode ?? 'off';

  const whisperLanguageRef = useRef(whisperLanguage);
  const refinementModeRef = useRef<TranscriptRefinementMode>(refinementMode);
  whisperLanguageRef.current = whisperLanguage;
  refinementModeRef.current = refinementMode;

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamsRef = useRef<Partial<Record<SourceKey, MediaStream>>>({});
  const analysersRef = useRef<Partial<Record<SourceKey, AnalyserNode>>>({});
  const controlBarSpectrumRef = useRef<Float32Array>(new Float32Array(CONTROL_BAR_WAVEFORM_BARS));
  const graphNodesRef = useRef<AudioNode[]>([]);
  const displayVideoSinkRef = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<Partial<Record<SourceKey, number>>>({});
  const recordingChunksRef = useRef<Float32Array[]>([]);
  const recordingProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const lastProcessorFrameAtRef = useRef<number | null>(null);
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
  const nativeHelperChunkUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeHelperStatusUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeHelperActiveRef = useRef(false);
  const nativeHelperLastRmsRef = useRef(0);
  const nativeHelperLastPeakRef = useRef(0);
  const nativeHelperLastChunkAtRef = useRef<number | null>(null);
  const coreTapChunkUnsubscribeRef = useRef<(() => void) | null>(null);
  const coreTapStatusUnsubscribeRef = useRef<(() => void) | null>(null);
  const coreTapActiveRef = useRef(false);
  /** Session uses native PCM helper as sole system path (no MediaStream transcription). */
  const systemPcmHelperOnlyRef = useRef(false);
  /** Mic-only fallback after system providers failed; skip system on auto-reconnect. */
  const systemCaptureDegradedRef = useRef(false);
  const sessionAudioSourcesRef = useRef<{ mic: boolean; system: boolean }>({ mic: false, system: false });
  /** Fuente primaria para métricas/espectro de la barra (mic | system | mixed). */
  const liveTranscriptionSourceRef = useRef<SourceKey>('mixed');
  const pendingFinalRefinementSegmentsRef = useRef<RefinementSegmentInput[]>([]);
  const finalRefinementBusyRef = useRef(false);
  const cleanContextRef = useRef<string>('');
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

  useEffect(() => {
    persistAppLanguage(appLanguage);
  }, [appLanguage]);

  useEffect(() => {
    persistUserProfile(userProfile);
  }, [userProfile]);

  useEffect(() => {
    persistPromptProfiles(promptProfiles);
  }, [promptProfiles]);

  useEffect(() => {
    persistContextSpaces(contextSpaces);
  }, [contextSpaces]);

  useEffect(() => {
    persistSelectedPromptProfileId(selectedPromptProfileId);
  }, [selectedPromptProfileId]);

  const addLog = useCallback((message: string) => {
    debug('ui-log', message);
    setDiagnosticLog((current) => [`${new Date().toLocaleTimeString()} - ${message}`, ...current].slice(0, 50));
  }, []);

  const patchCaptureHealth = useCallback((patch: Partial<CaptureHealthState>) => {
    const next = { ...captureHealthRef.current, ...patch };
    captureHealthRef.current = next;
    setCaptureHealthState(next);
  }, []);

  const handleAsrFinal = useCallback((segment: CommittedSegment) => {
    const transcriptSegment: TranscriptSegment = {
      id: segment.segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      status: 'final',
      source: segment.source,
      rms: 0,
      durationMs: segment.endMs - segment.startMs,
      modelName: segment.engine,
      asrMode: 'final',
      segmentId: segment.segmentId,
      language: whisperLanguageRef.current,
      engineUsed: segment.engine,
      fallbackUsed: segment.viaFallback,
    };
    setRawSegments((current) => [...current, transcriptSegment].slice(-200));
    queueFinalRefinementSegment(transcriptSegment, segment.segmentId);
  }, [queueFinalRefinementSegment]);

  const handleAsrFrame = useCallback((info: LiveAsrFrameInfo) => {
    lastProcessorFrameAtRef.current = info.atMs;
    if (info.firstFrame) {
      const payload = { source: info.source, rms: info.rms, peak: info.peak, sampleRate: info.sampleRate, timestampMs: info.atMs };
      captureDiag('transcription:processor-first-frame', payload);
      transcriptionTrace('processor-first-frame', payload);
      debug('transcription:processor-first-frame', payload);
    }
  }, []);

  const handleAsrEvent = useCallback((event: AsrLiveEvent, applied: boolean, reason: string) => {
    if (event.type === 'error') {
      addLog(`asr ${event.kind}: ${event.message}`);
    }
    if (!applied || event.type === 'error' || event.type === 'drained' || event.type === 'segment-dropped') {
      debug('asr:event', { type: event.type, applied, reason });
    }
  }, [addLog]);

  /** Live ASR (main process owns VAD/engines; this hook owns the transcript state and mic PCM streaming). */
  const liveAsr = useLiveAsr({
    onFinal: handleAsrFinal,
    onFrame: handleAsrFrame,
    onEvent: handleAsrEvent,
    onLog: addLog,
  });
  const liveAsrRef = useRef(liveAsr);
  liveAsrRef.current = liveAsr;
  const asrSessionIdRef = useRef<string | null>(null);
  const asrStatus = liveAsr.status;

  const visibleTranscriptText = liveAsr.transcript.visibleText;

  const askLocalAssistant = useCallback((questionOverride?: string) => {
    const question = (questionOverride ?? chatInput).trim() || DEFAULT_AI_CONTEXT_PROMPT;
    if (!question || chatBusy) return;
    const activePromptProfile = promptProfiles.find((profile) => profile.id === selectedPromptProfileId) ?? promptProfiles[0];
    const sessionContext = currentSessionContextRef.current;
    const normalizedQuestion = question.toLowerCase();
    const wantsFullContext = /\b(full|complete|entire|all|todo|toda|completa|completo|historial|desde el inicio)\b/.test(normalizedQuestion);
    const relatedContext = sessionContext?.relatedSessionIds?.length
      ? savedSessions
          .filter((session) => sessionContext.relatedSessionIds.includes(session.id))
          .map((session) => `${session.title}: ${session.meetingSummary || session.refinedSummaryLine || session.transcriptPreview || ''}`.trim())
          .join('\n')
      : '';
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
    const transcriptSource = wantsFullContext
      ? visibleTranscriptText
      : [
          visibleTranscriptText.slice(-6000),
          rawSegments.slice(-10).map((segment) => segment.whisperText ?? segment.text).join(' '),
        ].join(' ');
    const contextPrelude = [
      sessionContext?.meetingContext ? `Contexto de la sesión: ${sessionContext.meetingContext}` : '',
      sessionContext?.topics?.length ? `Temas esperados: ${sessionContext.topics.join(', ')}` : '',
      relatedContext ? `Reuniones relacionadas:\n${relatedContext}` : '',
      wantsFullContext ? 'El usuario pidió contexto completo; considera toda la transcripción disponible.' : 'Si la pregunta parece sobre lo último dicho, prioriza el contexto reciente.',
    ].filter(Boolean).join('\n');
    const rawContext = [contextPrelude, transcriptSource].join('\n\n').replace(/\s+/g, ' ').trim().slice(-8000);
    const activePromptText = [activePromptProfile?.systemPrompt, activePromptProfile?.contextPrompt].filter(Boolean).join('\n\n');
    const profiledQuestion = activePromptText
      ? `${activePromptText}\n\nPregunta del usuario: ${question}`
      : question;
    window.meetingAssistant.assistant.ask({
      question: profiledQuestion,
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
  }, [captureMode, chatBusy, chatInput, promptProfiles, rawSegments, refinedTranscript.text, savedSessions, selectedPromptProfileId, visibleTranscriptText]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
  }, []);

  const dismissToast = useCallback(() => {
    setToastMessage(null);
  }, []);

  const copyTranscript = useCallback(async (): Promise<boolean> => {
    const useRefined = transcriptView === 'refined' && Boolean(refinedTranscript.text.trim());
    const text = useRefined ? refinedTranscript.text.trim() : visibleTranscriptText.trim();
    if (!text) return false;
    const ok = await copyToClipboard(text);
    if (!ok) {
      debug('clipboard:transcript-failed');
    }
    return ok;
  }, [refinedTranscript.text, transcriptView, visibleTranscriptText]);

  const copyLastAiResponse = useCallback(async () => {
    const lastResponse = [...chatMessages].reverse().find((message) => message.role === 'assistant')?.text.trim();
    if (!lastResponse) return;
    const ok = await copyToClipboard(lastResponse);
    if (!ok) {
      debug('clipboard:ai-error');
    }
  }, [chatMessages]);

  const patchMeter = useCallback((source: SourceKey, patch: Partial<MeterState>) => {
    const current = metersRef.current;
    const previousSourceMeter = current[source];
    const next = {
      ...current,
      [source]: {
        ...previousSourceMeter,
        ...patch,
      },
    };
    metersRef.current = next;

    const publishImmediately =
      (patch.status !== undefined && patch.status !== previousSourceMeter.status) ||
      (patch.error !== undefined && patch.error !== previousSourceMeter.error) ||
      (patch.sampleRate !== undefined && patch.sampleRate !== previousSourceMeter.sampleRate);
    const now = performance.now();
    const publish = () => {
      if (meterReactPublishTimerRef.current !== null) {
        window.clearTimeout(meterReactPublishTimerRef.current);
        meterReactPublishTimerRef.current = null;
      }
      lastMeterReactPublishAtRef.current = performance.now();
      setMeters(metersRef.current);
    };

    if (publishImmediately || now - lastMeterReactPublishAtRef.current >= METER_REACT_PUBLISH_MS) {
      publish();
      return;
    }

    if (meterReactPublishTimerRef.current !== null) return;
    meterReactPublishTimerRef.current = window.setTimeout(() => {
      meterReactPublishTimerRef.current = null;
      lastMeterReactPublishAtRef.current = performance.now();
      setMeters(metersRef.current);
    }, METER_REACT_PUBLISH_MS - (now - lastMeterReactPublishAtRef.current));
  }, []);

  useEffect(() => {
    return () => {
      if (meterReactPublishTimerRef.current !== null) {
        window.clearTimeout(meterReactPublishTimerRef.current);
      }
    };
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
      /* Warm the Parakeet helper (and download models on first run) so the first session starts instantly. */
      if (setup.parakeetHelperConfigured) void liveAsrRef.current.prepare();
    });
    void window.meetingAssistant.polisher.check().then((setup) => {
      setPolisherSetup(setup);
      debug('polisher:setup', setup);
      if (!setup.ok) addLog(setup.message);
    });

    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [addLog, refreshCoreAudioTapHelperCheck, refreshDesktopSources, refreshDevices, refreshPermissions, refreshSystemAudioHelperCheck]);

  useEffect(() => {
    captureHealthRef.current = captureHealthState;
  }, [captureHealthState]);

  // Carga inicial: base de datos local (SQLite) con migración única desde localStorage.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const db = window.meetingAssistant?.db;
      if (!db) {
        // Entorno sin Electron (p. ej. tests): mantener el fallback anterior.
        if (!cancelled) {
          setSavedSessions(loadLegacySavedSessionsFromLocalStorage());
          savedSessionsHydratedRef.current = true;
        }
        return;
      }
      try {
        const legacy = loadLegacySavedSessionsFromLocalStorage();
        if (legacy.length > 0) {
          await db.migrateLegacySessions(legacy as unknown as Record<string, unknown>[]);
        }
        const result = await db.listSessions();
        if (cancelled) return;
        if (result.ok) {
          const sessions = result.sessions as unknown as DashboardSessionSummary[];
          knownSessionIdsRef.current = new Set(sessions.map((s) => s.id));
          setSavedSessions(sessions);
          try {
            localStorage.removeItem(SAVED_SESSIONS_STORAGE_KEY);
          } catch {
            /* ignore */
          }
        } else {
          console.error('openwhispr: db:sessions:list failed', result.error);
          setSavedSessions(legacy);
        }
      } catch (error) {
        console.error('openwhispr: failed to load sessions from local database', error);
        if (!cancelled) setSavedSessions(loadLegacySavedSessionsFromLocalStorage());
      } finally {
        if (!cancelled) savedSessionsHydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sincroniza cada cambio de `savedSessions` con SQLite (upsert de lo vigente + borrado de lo removido).
  useEffect(() => {
    if (!savedSessionsHydratedRef.current) return;
    const db = window.meetingAssistant?.db;
    if (!db) return;
    const currentIds = new Set(savedSessions.map((s) => s.id));
    const removedIds = [...knownSessionIdsRef.current].filter((id) => !currentIds.has(id));
    knownSessionIdsRef.current = currentIds;
    void (async () => {
      try {
        for (const session of savedSessions) {
          await db.upsertSession(session as unknown as Record<string, unknown>);
        }
        for (const id of removedIds) {
          await db.deleteSession(id);
        }
      } catch (error) {
        console.error('openwhispr: failed to persist sessions to local database', error);
      }
    })();
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
      const spectrum = controlBarSpectrumRef.current;
      const mode = lastCaptureModeRef.current;
      if (spectrum) {
        if (mode) {
          const order: SourceKey[] =
            mode === 'mic' ? ['mic', 'mixed'] : mode === 'system' ? ['system', 'mixed'] : ['mixed', 'mic', 'system'];
          const preferred = liveTranscriptionSourceRef.current;
          const seen = new Set<SourceKey>();
          const ordered: SourceKey[] = [];
          for (const s of [preferred, ...order]) {
            if (seen.has(s)) continue;
            seen.add(s);
            ordered.push(s);
          }
          let primaryAnalyser: AnalyserNode | undefined;
          for (const s of ordered) {
            primaryAnalyser = analysersRef.current[s];
            if (primaryAnalyser) break;
          }
          if (primaryAnalyser) fillControlBarSpectrumFromAnalyser(primaryAnalyser, spectrum);
          else spectrum.fill(0);
        } else {
          spectrum.fill(0);
        }
      }
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
    controlBarSpectrumRef.current.fill(0);
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

    lastProcessorFrameAtRef.current = null;
    /* Ordered stop: detach renderer PCM pushers, then wait for main to finalise every closed segment. */
    await liveAsrRef.current.stopSession(options?.reason ?? 'capture-stop');
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
    sessionAudioSourcesRef.current = { mic: false, system: false };
    systemPcmHelperOnlyRef.current = false;
    systemCaptureDegradedRef.current = false;
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

    try {
      const access = await window.meetingAssistant.audio.ensureMicrophoneAccess();
      debug('capture:mic:os-access', access);
      if (!access.ok) {
        throw new Error(`microphone-permission-denied: estado macOS=${access.status}`);
      }
    } catch (error) {
      debug('capture:mic:os-access-error', String(error));
    }

    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = mediaDevices.filter((device) => device.kind === 'audioinput');
    void refreshDevices();

    const knownMic = selectedMicId
      ? audioInputs.find((device) => device.deviceId === selectedMicId)
      : undefined;

    const makeConstraints = (
      deviceId?: string,
      deviceIdMode: 'exact' | 'ideal' = 'exact',
    ): MediaStreamConstraints => ({
      audio: {
        deviceId: deviceId ? { [deviceIdMode]: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const attempts: Array<{ label: string; constraints: MediaStreamConstraints }> = [];

    if (knownMic?.deviceId) {
      attempts.push({ label: 'selected-ideal', constraints: makeConstraints(knownMic.deviceId, 'ideal') });
      attempts.push({ label: 'selected-exact', constraints: makeConstraints(knownMic.deviceId, 'exact') });
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
        stream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
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
  }, [addLog, connectAnalyser, patchMeter, refreshDevices, refreshPermissions, selectedMicId]);

  const stopNativeSystemAudioHelper = useCallback((reason: string) => {
    nativeHelperChunkUnsubscribeRef.current?.();
    nativeHelperChunkUnsubscribeRef.current = null;
    nativeHelperStatusUnsubscribeRef.current?.();
    nativeHelperStatusUnsubscribeRef.current = null;
    nativeHelperActiveRef.current = false;
    captureDiag('system-audio-helper:stop-request', { reason, generation: captureGenerationRef.current });
    debug('system-audio-helper:stop-request', { reason, generation: captureGenerationRef.current });
    void window.meetingAssistant.systemAudioHelper.stop().catch((error) => {
      debug('system-audio-helper:stop-error', String(error));
    });
  }, []);

  const stopCoreAudioTapHelper = useCallback((reason: string) => {
    coreTapChunkUnsubscribeRef.current?.();
    coreTapChunkUnsubscribeRef.current = null;
    coreTapStatusUnsubscribeRef.current?.();
    coreTapStatusUnsubscribeRef.current = null;
    coreTapActiveRef.current = false;
    captureDiag('core-audio-tap-helper:stop-request', { reason, generation: captureGenerationRef.current });
    debug('core-audio-tap-helper:stop-request', { reason, generation: captureGenerationRef.current });
    void window.meetingAssistant.coreAudioTapHelper.stop().catch((error) => {
      debug('core-audio-tap-helper:stop-error', String(error));
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
    let sumSq = 0;
    let peak = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let value = 0;
      const base = frame * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        value += stereo[base + channel] ?? 0;
      }
      value /= channels;
      const absolute = Math.abs(value);
      if (absolute > peak) peak = absolute;
      sumSq += value * value;
    }
    const rms = frameCount > 0 ? Math.sqrt(sumSq / frameCount) : 0;
    const now = Date.now();
    lastAudioRmsAtRef.current = now;
    nativeHelperLastRmsRef.current = rms;
    nativeHelperLastPeakRef.current = peak;
    nativeHelperLastChunkAtRef.current = now;
    if (rms >= SYSTEM_SIGNAL_CHECK_RMS || peak >= SYSTEM_SIGNAL_CHECK_PEAK) {
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

    /* ASR: main feeds helper PCM to the live session directly; the renderer only meters it. */
  }, [patchMeter]);

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
      let everHadPcmChunk = false;
      const sample = () => {
        if (providerId === 'native-helper' || providerId === 'coreaudio-tap') {
          const elapsedMs = Date.now() - startedAt;
          const rms = nativeHelperLastRmsRef.current;
          const peak = nativeHelperLastPeakRef.current;
          const hasChunk = nativeHelperLastChunkAtRef.current !== null && nativeHelperLastChunkAtRef.current >= startedAt;
          const aliveByChunks = hasChunk;
          if (aliveByChunks) {
            everHadPcmChunk = true;
            hitCount += 1;
          } else {
            hitCount = 0;
          }
          const samplePayload = {
            source,
            providerId,
            elapsedMs,
            rms: Number(rms.toFixed(6)),
            peak: Number(peak.toFixed(6)),
            aliveByChunks,
            hasChunk,
            everHadPcmChunk,
            hitCount,
            generation: captureGenerationRef.current,
          };
          captureDiag('capture:system:signal-check:sample', samplePayload);
          debug('capture:system:signal-check:sample', samplePayload);
          if (hitCount >= SYSTEM_PCM_CHUNK_REQUIRED_HITS) {
            captureDiag('capture:system:signal-check:ok', { ...samplePayload, reason: 'alive-chunks' });
            debug('capture:system:signal-check:ok', { ...samplePayload, reason: 'alive-chunks' });
            resolve(true);
            return;
          }
          if (elapsedMs >= timeoutMs) {
            const failedPayload = {
              ...samplePayload,
              reason: everHadPcmChunk ? 'timeout-chunks-interrupted' : 'timeout-no-pcm-helper-chunks',
            };
            captureDiag(everHadPcmChunk ? 'capture:system:signal-check:ok' : 'capture:system:signal-check:failed', failedPayload);
            debug(everHadPcmChunk ? 'capture:system:signal-check:ok' : 'capture:system:signal-check:failed', failedPayload);
            resolve(everHadPcmChunk);
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
      if (sources.length > 1) {
        /* Slightly louder loopback/display: it often sits below mic in RMS on macOS. */
        gain.gain.value = index === 0 ? 0.32 : 0.58;
      } else {
        gain.gain.value = 0.7;
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

  const startCapture = useCallback(
    (mode: CaptureMode, options?: { preserveSession?: boolean; reconnect?: boolean; skipSystemCapture?: boolean }) =>
      runCaptureLifecycle('start', async () => {
        const generation = ++captureGenerationRef.current;
        const preserveSession = Boolean(options?.preserveSession);
        captureStartInProgressRef.current = true;

        try {
          if (!preserveSession) {
            systemCaptureDegradedRef.current = false;
          }

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
          asrSessionIdRef.current = `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          liveAsrRef.current.beginSession(asrSessionIdRef.current, generation);
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
        if (preserveSession) {
          if (!asrSessionIdRef.current) {
            asrSessionIdRef.current = `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            liveAsrRef.current.beginSession(asrSessionIdRef.current, generation);
          } else {
            liveAsrRef.current.bumpGeneration(generation);
          }
        } else {
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
        let systemStream: MediaStream | null = null;

        /* `both`: mic first, then system. Starting CoreAudio Tap / loopback before getUserMedia can
         * re-route macOS I/O and leave the mic stream silent or unavailable. */
        if (mode === 'mic' || mode === 'both') {
          try {
            micStream = await captureMic();
            micCaptured = true;
          } catch {
            addLog('mic: no disponible para esta sesión');
          }
        }

        if ((mode === 'system' || mode === 'both') && !options?.skipSystemCapture) {
          try {
            const result = await captureSystem();
            if (result.kind === 'pcm-helper') {
              systemPcmHelperActive = true;
            } else {
              captured.push(result.stream);
              systemStream = result.stream;
              systemMediaCaptured = true;
            }
          } catch {
            addLog('system: no disponible para esta sesión');
            if (mode === 'both' && micCaptured) {
              systemCaptureDegradedRef.current = true;
            }
          }
        } else if (options?.skipSystemCapture && mode === 'both') {
          addLog('system: omitido en reconexión automática (modo micrófono degradado)');
        }

        if (micStream) {
          captured.unshift(micStream);
        }
        const systemCaptured = systemMediaCaptured || systemPcmHelperActive;
        systemPcmHelperOnlyRef.current = mode === 'system' && systemPcmHelperActive;
        if (systemCaptured) {
          systemCaptureDegradedRef.current = false;
        }
        const sessionSources = { mic: micCaptured, system: systemCaptured };
        sessionAudioSourcesRef.current = sessionSources;
        setSessionAudioSources(sessionSources);

        if (micCaptured || systemCaptured) {
          const asrSessionId = asrSessionIdRef.current ?? `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          asrSessionIdRef.current = asrSessionId;
          const asrStart = await liveAsrRef.current.startSession({
            sessionId: asrSessionId,
            generation,
            language: whisperLanguageRef.current,
            sources: sessionSources,
          });
          if (generation !== captureGenerationRef.current) {
            debug('capture:start-aborted-stale-generation-after-asr', { generation });
            return;
          }
          if (!asrStart.ok) {
            addLog(`asr: ${asrStart.error ?? asrStart.status.message ?? 'motor no disponible'}`);
            showToast('Transcription engine unavailable. Run npm run asr:setup and try again.');
          } else {
            const audioContext = ensureAudioContext();
            if (micStream) liveAsrRef.current.attachStream(audioContext, micStream, 'mic');
            if (systemStream) liveAsrRef.current.attachStream(audioContext, systemStream, 'system');
            const liveLabel = describeEngine(asrStart.status.liveEngine);
            const finalLabel = describeEngine(asrStart.status.finalEngine);
            addLog(
              liveLabel
                ? `transcripción en vivo: ${liveLabel}${finalLabel && finalLabel !== liveLabel ? ` · final ${finalLabel}` : ''}`
                : `transcripción sin preview: finales con ${finalLabel ?? 'motor desconocido'}`,
            );
          }
        }

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
          liveTranscriptionSourceRef.current = transcriptSource;
          lastProcessorFrameAtRef.current = null;
          const graceUntil = Date.now() + CAPTURE_WATCHDOG_GRACE_MS;
          captureWatchdogGraceUntilRef.current = Math.max(captureWatchdogGraceUntilRef.current, graceUntil);
          audioEndedWatchdogStreakRef.current = 0;
          patchCaptureHealth({
            captureHealth: 'ok',
            message: null,
            lastCheckedAt: Date.now(),
          });
          if (mode === 'both' && !options?.reconnect) {
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
      ensureAudioContext,
      stopCaptureCore,
      systemPermission,
      outputDevices,
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
      const skipSystemCapture = source === 'auto' && systemCaptureDegradedRef.current;
      await startCapture(mode, { preserveSession: true, reconnect: true, skipSystemCapture });
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
        const pcmHelperActive = nativeHelperActiveRef.current || coreTapActiveRef.current;
        const micTrackLive = streamsRef.current.mic?.getAudioTracks()[0]?.readyState === 'live';
        const micOnlyDegraded =
          systemCaptureDegradedRef.current ||
          (mode === 'both' && micTrackLive && !streamsRef.current.system && !pcmHelperActive);
        const shouldSkipAutoRecover = pcmHelperActive || micOnlyDegraded;

        const recentAttempts = recoveryAttemptTimesRef.current.filter((attemptAt) => now - attemptAt < 60_000);
        recoveryAttemptTimesRef.current = recentAttempts;
        if (!shouldSkipAutoRecover && recentAttempts.length < MAX_AUTO_RECOVERY_ATTEMPTS_PER_MINUTE) {
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

  const saveCurrentSessionSnapshot = useCallback((options?: { aiSummary?: string; aiTitle?: string }) => {
    const liveState = liveAsrRef.current.getTranscript();
    const transcriptText = liveState.visibleText.trim();
    const refinedText = refinedTranscript.text.trim();
    if (!transcriptText && !refinedText && liveState.finals.length === 0) return null;

    const createdAt = captureStartedAt ?? Date.now();
    const endedAt = Date.now();
    const source = liveState.finals[0]?.source ?? captureMode ?? 'system';
    const explicitAi = options?.aiSummary?.trim();
    const meetingSummary =
      explicitAi && explicitAi.length > 0 ? explicitAi.slice(0, 12_000) : undefined;
    const flatOneLine = (s: string, max: number) => {
      const t = s.replace(/\s+/g, ' ').trim();
      if (t.length <= max) return t;
      return `${t.slice(0, max - 1)}…`;
    };
    const refinedSummaryLine = meetingSummary
      ? flatOneLine(meetingSummary, 220)
      : refinedText
        ? refinedText
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean)
            ?.slice(0, 280)
        : undefined;
    const sessionContext = currentSessionContextRef.current;
    const session: DashboardSessionSummary = {
      id: `session-${endedAt}`,
      title: sessionContext?.title || options?.aiTitle || createSessionTitle(createdAt),
      createdAt,
      durationSeconds: captureElapsedSeconds,
      transcriptPreview: (meetingSummary || transcriptText || refinedText).slice(0, 220),
      transcriptText,
      refinedText: refinedText || undefined,
      refinedSummaryLine: refinedSummaryLine || undefined,
      meetingSummary,
      source,
      status: 'completed',
      meetingContext: sessionContext?.meetingContext,
      topics: sessionContext?.topics,
      relatedSessionIds: sessionContext?.relatedSessionIds,
      contextSpaceIds: sessionContext?.contextSpaceIds,
      promptProfileId: sessionContext?.promptProfileId,
      language: sessionContext?.language,
    };
    session.agentMemory = buildMeetingAgentMemory(session);
    session.decisions = session.agentMemory.decisions;
    session.actionItems = session.agentMemory.actionItems;
    session.openQuestions = session.agentMemory.openQuestions;
    session.risks = session.agentMemory.risks;
    session.agentInsights = session.agentMemory.insights;
    setSavedSessions((current) => [session, ...current]);
    setSelectedSavedSessionId(session.id);
    return session;
  }, [
    captureElapsedSeconds,
    captureMode,
    captureStartedAt,
    refinedTranscript.text,
  ]);

  const deleteSavedSession = useCallback((id: string) => {
    setSavedSessions((current) => current.filter((s) => s.id !== id));
    setSelectedSavedSessionId((cur) => (cur === id ? null : cur));
    setContextSpaces((current) => current.map((space) => (
      space.sessionIds.includes(id)
        ? { ...space, sessionIds: space.sessionIds.filter((sessionId) => sessionId !== id), updatedAt: Date.now() }
        : space
    )));
  }, []);

  const assignSessionToContextSpace = useCallback((session: DashboardSessionSummary, spaceId: string) => {
    setContextSpaces((current) => current.map((space) => (
      space.id === spaceId
        ? { ...space, sessionIds: Array.from(new Set([...space.sessionIds, session.id])), updatedAt: Date.now() }
        : space
    )));
    setSavedSessions((current) => current.map((item) => (
      item.id === session.id
        ? { ...item, contextSpaceIds: Array.from(new Set([...(item.contextSpaceIds ?? []), spaceId])) }
        : item
    )));
    setContextAssignSession(null);
  }, []);

  const createContextSpaceForSession = useCallback((session: DashboardSessionSummary, name: string) => {
    const id = `context-${Date.now()}`;
    const nextSpace: ContextSpace = {
      id,
      name: name.trim() || 'Nuevo contexto',
      description: '',
      sessionIds: [session.id],
      updatedAt: Date.now(),
    };
    setContextSpaces((current) => [...current, nextSpace]);
    setSavedSessions((current) => current.map((item) => (
      item.id === session.id
        ? { ...item, contextSpaceIds: Array.from(new Set([...(item.contextSpaceIds ?? []), id])) }
        : item
    )));
    setContextAssignSession(null);
  }, []);

  const keepSessionInGeneralContext = useCallback((session: DashboardSessionSummary) => {
    assignSessionToContextSpace(session, 'general');
  }, [assignSessionToContextSpace]);

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

  const startDashboardSession = useCallback((sessionContext?: NewSessionContext) => {
    const mode: CapturePreference = capturePreference;
    currentSessionContextRef.current = sessionContext ?? null;
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
    pendingSessionStartRef.current = false;
    setPendingSessionStart(false);
    setSessionCaptureStarting(false);
    setMeetingSummaryBusy(true);
    try {
      await stopCapture({ reason: 'sesión finalizada' });
    } catch (error) {
      captureDiag('session:finish-stop-error', { error: String(error) });
      debug('session:finish-stop-error', String(error));
      setMeetingSummaryBusy(false);
      showToast('No se pudo detener la captura.');
      return;
    }
    setAiPanelOpen(false);
    setOverlayCollapsed(false);
    setAppMode('dashboard');

    /* Read after the awaited stop: the drain may have appended finals since this closure rendered. */
    const liveState = liveAsrRef.current.getTranscript();
    const transcriptForSummary = liveState.visibleText.trim();
    const refinedForSummary = refinedTranscript.text.trim();
    const hasMeetingPayload =
      Boolean(transcriptForSummary || refinedForSummary) || liveState.finals.length > 0;

    let aiSummary: string | undefined;
    let aiTitle: string | undefined;
    if (hasMeetingPayload) {
      try {
        [aiSummary, aiTitle] = await Promise.all([
          generateMeetingSummaryLine({
            transcript: transcriptForSummary,
            refined: refinedForSummary,
            glossary,
            polisherOk: Boolean(polisherSetup?.ok),
            polishSegment: window.meetingAssistant.polisher.polishSegment,
          }),
          generateMeetingTitle({
            transcript: transcriptForSummary,
            refined: refinedForSummary,
            polisherOk: Boolean(polisherSetup?.ok),
            polishSegment: window.meetingAssistant.polisher.polishSegment,
          }),
        ]);
      } catch (error) {
        debug('session:finish-summary-error', String(error));
      }
    }

    const savedSession = saveCurrentSessionSnapshot(hasMeetingPayload ? { aiSummary, aiTitle } : undefined);
    if (savedSession) setContextAssignSession(savedSession);
    setMeetingSummaryBusy(false);
  }, [
    captureMode,
    glossary,
    polisherSetup?.ok,
    refinedTranscript.text,
    saveCurrentSessionSnapshot,
    showToast,
    stopCapture,
  ]);

  const transcriptListeningHint = (() => {
    if (asrStatus?.state === 'starting' && asrStatus.message) return asrStatus.message;
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
        : asrStatus?.state === 'stopping' || asrStatus?.state === 'starting'
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
  const asrLiveEngineLabel = describeEngine(liveAsr.transcript.liveEngine ?? asrStatus?.liveEngine ?? null);
  const asrFinalEngineLabel = describeEngine(liveAsr.transcript.finalEngine ?? asrStatus?.finalEngine ?? null);
  const asrEngineLabel = (() => {
    if (asrStatus?.engineMode === 'unavailable') return 'Sin motor ASR (npm run asr:setup)';
    if (asrStatus?.engineMode === 'whisper-fallback') return `Fallback: ${asrFinalEngineLabel ?? 'Whisper Turbo'} (sin preview en vivo)`;
    if (asrLiveEngineLabel && asrFinalEngineLabel && asrLiveEngineLabel !== asrFinalEngineLabel) {
      return `Live: ${asrLiveEngineLabel} · Final: ${asrFinalEngineLabel}`;
    }
    const single = asrLiveEngineLabel ?? asrFinalEngineLabel ?? 'Parakeet TDT v3';
    return liveAsr.transcript.fallbackUsed ? `${single} · fallback usado` : `Live/Final: ${single}`;
  })();
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
        <p>ASR: {asrEngineLabel}</p>
        {asrStatus?.message && asrStatus.state !== 'running' ? <p className="muted">{asrStatus.message}</p> : null}
        <p>IA local: {polisherSetup?.ok ? 'lista' : 'no disponible'}</p>
        <p>Audio: {audioStatus}</p>
        {captureHealthState.message && <p>{captureHealthState.message}</p>}
        <p>RMS: {meters.mixed.rms.toFixed(3)}</p>
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
        <span>asr: {asrStatus?.state ?? 'unknown'} / {asrStatus?.engineMode ?? '—'}</span>
        <span>finals: {liveAsr.transcript.stats.finalsApplied} · previews: {liveAsr.transcript.stats.previewsApplied} · stale: {liveAsr.transcript.stats.staleRejected} · errors: {liveAsr.transcript.stats.errors}</span>
        <span>drain: {liveAsr.transcript.lastDrain ? `${liveAsr.transcript.lastDrain.finalsFlushed} finals / ${liveAsr.transcript.lastDrain.elapsedMs} ms${liveAsr.transcript.lastDrain.timedOut ? ' (timeout)' : ''}` : 'none'}</span>
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
                    {segment.engineUsed && <span className="source-tag">{describeEngine(segment.engineUsed) ?? segment.engineUsed}</span>}
                    {segment.fallbackUsed && <span className="source-tag warning-tag">fallback</span>}
                  </div>
                  <p>{segment.text}</p>
                </li>
              ))}
            </ol>
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
        setSetupWizardOpen(false);
      }}
    />
  ) : null;

  if (appMode === 'dashboard') {
    return (
      <>
        {setupOverlay}
        <DashboardHome
          userName={userProfile.name}
          userProfile={userProfile}
          sessions={savedSessions}
          onStartSession={() => setNewSessionModalOpen(true)}
          onOpenSession={(session) => setSelectedSavedSessionId(session.id)}
          onDeleteSession={deleteSavedSession}
          onNotify={showToast}
          onRerunSetup={() => setSetupWizardOpen(true)}
          capturePreference={capturePreference}
          onCapturePreferenceChange={(mode) => {
            setCapturePreference(mode);
            persistCapturePreference(mode);
          }}
          systemCaptureStrategy={systemCaptureStrategy}
          onSystemCaptureStrategyChange={setSystemCaptureStrategy}
          appLanguage={appLanguage}
          onAppLanguageChange={setAppLanguage}
          promptProfiles={promptProfiles}
          contextSpaces={contextSpaces}
          selectedPromptProfileId={selectedPromptProfileId}
          onPromptProfilesChange={setPromptProfiles}
          onContextSpacesChange={setContextSpaces}
          onSelectedPromptProfileIdChange={setSelectedPromptProfileId}
          onUserProfileChange={setUserProfile}
          meetingSummaryBusy={meetingSummaryBusy}
        />
        {newSessionModalOpen ? (
          <NewSessionModal
            sessions={savedSessions}
            contextSpaces={contextSpaces}
            promptProfiles={promptProfiles}
            selectedPromptProfileId={selectedPromptProfileId}
            language={appLanguage}
            onCancel={() => setNewSessionModalOpen(false)}
            onConfirm={(sessionContext) => {
              setNewSessionModalOpen(false);
              setSelectedPromptProfileId(sessionContext.promptProfileId);
              setAppLanguage(sessionContext.language);
              startDashboardSession(sessionContext);
            }}
          />
        ) : null}
        {contextAssignSession ? (
          <ContextSpaceAssignmentModal
            session={contextAssignSession}
            contextSpaces={contextSpaces}
            onClose={() => keepSessionInGeneralContext(contextAssignSession)}
            onSkip={() => keepSessionInGeneralContext(contextAssignSession)}
            onAssign={(spaceId) => assignSessionToContextSpace(contextAssignSession, spaceId)}
            onCreateAndAssign={(name) => createContextSpaceForSession(contextAssignSession, name)}
          />
        ) : null}
        <PremiumToast message={toastMessage} onDismiss={dismissToast} />
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
        committedText={liveAsr.transcript.committedText}
        provisionalText={liveAsr.transcript.provisionalText}
        engineLabel={asrEngineLabel}
        refinedText={refinedTranscript.text}
        transcriptView={transcriptView}
        refinementAvailable={Boolean(refinedTranscript.text)}
        localAiReady={Boolean(polisherSetup?.ok)}
        chatMessages={chatMessages}
        chatInput={chatInput}
        chatBusy={chatBusy}
        chatError={chatError}
        reconnectAudioVisible={showReconnectAudio}
        controlBarSpectrumRef={controlBarSpectrumRef}
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
      <PremiumToast message={toastMessage} onDismiss={dismissToast} />
    </>
  );
}

function formatMs(value: number) {
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
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
