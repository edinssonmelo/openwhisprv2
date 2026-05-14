import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, screen, session, systemPreferences } from 'electron';
import { spawn, spawnSync, ChildProcessByStdio, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
/** Transparent always-on-top overlay (see README / user env). Default off = normal framed window for dev. */
const OPENWHISPR_OVERLAY_WINDOW = process.env.OPENWHISPR_OVERLAY_WINDOW === 'true';
/** When false (default), skip high-volume main-process logs (audio chunks, every whisper run, etc.). */
const OPENWHISPR_VERBOSE_LOG = process.env.OPENWHISPR_VERBOSE_LOG === 'true';
/** When true, use macOS system picker for display capture. Default false for deterministic loopback via handler. */
const OPENWHISPR_USE_SYSTEM_PICKER = process.env.OPENWHISPR_USE_SYSTEM_PICKER === 'true';
/** Diagnostic toggle: compare Electron macOS loopback modes without changing the default. */
const OPENWHISPR_LOOPBACK_MODE =
  process.env.OPENWHISPR_LOOPBACK_MODE === 'loopbackWithMute' ? 'loopbackWithMute' : 'loopback';
const POLISHER_MODEL = process.env.TRANSCRIPT_REFINER_MODEL?.trim() || 'gemma3:4b';
/** Baseline: único GGML esperado en `.local/models/ggml-large-v3-turbo.bin`. */
const WHISPER_MODEL_ORDER = ['large-v3-turbo'] as const;
const DEFAULT_QWEN_ASR_CMD = '.venv-qwen-asr/bin/python scripts/asr_qwen3_final.py';
const WHISPER_PROMPT_MAX_CHARS = 520;
const FUZZY_REPLACEMENT_THRESHOLD = 0.88;
const MINIMAL_TRANSCRIPTION_PROMPT = [
  'Transcribe audio de una conversacion en espanol latinoamericano.',
  'Escribe solo lo que se oye; no inventes palabras, nombres ni siglas.',
  'Si no entiendes un fragmento, omite ese fragmento antes que cambiar de idioma.',
  'Mantén muletillas y dudas cuando sean audibles.',
].join(' ');

type WhisperPromptMode = 'empty' | 'minimal' | 'contextual';
type AsrPipelineMode = 'baseline-whisper' | 'moonshine-qwen-v2';
type AsrFinalEngineMode = 'whisper' | 'qwen' | 'compare';
type TranscriptRefinementMode = 'off' | 'whisper-only' | 'whisper-qwen';

interface TranscriptionContextPack {
  defaultLanguage: string;
  style: {
    region: string;
    tone: string;
    notes: string[];
  };
  domains: Record<string, string[]>;
  peopleAliases: Array<{
    canonical: string;
    aliases: string[];
  }>;
  customReplacements: Array<{
    from: string;
    to: string;
  }>;
  learning: {
    enabled: boolean;
    autoApplyHighConfidence: boolean;
    requireReviewForNames: boolean;
    minOccurrencesToSuggest: number;
  };
}

interface TextReplacement {
  original: string;
  replacement: string;
  confidence: number;
  reason: string;
}

const FALLBACK_TRANSCRIPTION_CONTEXT: TranscriptionContextPack = {
  defaultLanguage: 'es',
  style: {
    region: 'Colombia / Latinoamerica',
    tone: 'conversacion natural de trabajo',
    notes: [
      'Puede haber mezcla de espanol con terminos tecnicos en ingles.',
      'No traducir nombres de tecnologias, frameworks, servicios, marcas o siglas.',
    ],
  },
  domains: {
    software: ['frontend', 'backend', 'fullstack', 'API', 'APIs', 'SDK', 'UI', 'UX', 'QA', 'DevOps', 'deploy', 'release', 'branch', 'pull request', 'merge request', 'commit', 'pipeline', 'bug', 'feature', 'endpoint', 'payload', 'token', 'auth', 'login', 'rollback', 'hotfix', 'logs', 'debug'],
    frontend: ['Angular', 'React', 'Next.js', 'Flutter', 'Dart', 'TypeScript', 'JavaScript', 'Vite', 'Tailwind', 'Material UI', 'Module Federation', 'microfrontend', 'web components', 'design system'],
    backend: ['Node.js', 'NestJS', 'Express', 'FastAPI', 'Python', 'Java', 'Spring Boot', 'Prisma', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'SQLite', 'REST', 'GraphQL', 'webhook'],
    cloudInfraSecurity: ['AWS', 'S3', 'Lambda', 'EC2', 'CloudWatch', 'IAM', 'VPC', 'Docker', 'Kubernetes', 'CI/CD', 'Azure', 'Google Cloud', 'iSeries', 'AS400', 'mainframe', 'VPN', 'firewall', 'WAF', 'SIEM', 'CVE', 'risk', 'security'],
    aiTools: ['AI', 'LLM', 'LLMs', 'OpenAI', 'OpenRouter', 'Claude', 'Gemini', 'Cursor', 'Codex', 'Ollama', 'Whisper', 'whisper.cpp', 'RAG', 'embedding', 'prompt', 'agent', 'MCP'],
    businessBanking: ['Bancolombia', 'Sucursal Virtual', 'transaccional', 'seguridad transaccional', 'riesgo', 'aprobaciones', 'auditoria', 'roles', 'permisos'],
  },
  peopleAliases: [
    { canonical: 'Edi', aliases: ['Edi', 'Edinsson'] },
    { canonical: 'Omar', aliases: ['Omi', 'Omar'] },
    { canonical: 'Jhan', aliases: ['Jhan', 'Jan'] },
    { canonical: 'Melissa', aliases: ['Meli', 'Melissa'] },
    { canonical: 'Samuel', aliases: ['Samu', 'Samuel'] },
  ],
  customReplacements: [
    { from: 'open router', to: 'OpenRouter' },
    { from: 'next yes', to: 'Next.js' },
    { from: 'nest yes', to: 'NestJS' },
    { from: 'ese tres', to: 'S3' },
    { from: 's tres', to: 'S3' },
    { from: 'a doble u ese', to: 'AWS' },
    { from: 'doble u ese', to: 'AWS' },
    { from: 'i series', to: 'iSeries' },
    { from: 'a pi', to: 'API' },
    { from: 'u equis', to: 'UX' },
    { from: 'cu a', to: 'QA' },
  ],
  learning: {
    enabled: false,
    autoApplyHighConfidence: true,
    requireReviewForNames: true,
    minOccurrencesToSuggest: 3,
  },
};

let mainWindow: BrowserWindow | null = null;
/** Last `setIgnoreMouseEvents` arg for overlay hit-testing (avoid redundant native calls). */
let overlayPointerPassthroughIgnore: boolean | null = null;
/** Visual mode for overlay-capable (`OPENWHISPR_OVERLAY_WINDOW`) windows only. */
let currentWindowMode: 'dashboard' | 'session' = 'dashboard';
/** `desktopCapturer` source id chosen in renderer (Settings → Screen/window); used by `setDisplayMediaRequestHandler`. */
let preferredDisplayMediaSourceId: string | null = null;
const activeTranscriptionProcesses = new Set<ChildProcessWithoutNullStreams>();
let systemAudioHelperProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
let systemAudioHelperStdoutBuffer = Buffer.alloc(0);
let systemAudioHelperChunkSequence = 0;

let coreAudioTapHelperProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
let coreAudioTapHelperStdoutBuffer = Buffer.alloc(0);
let coreAudioTapHelperChunkSequence = 0;

const DASHBOARD_WINDOW_WIDTH = 1200;
const DASHBOARD_WINDOW_HEIGHT = 720;
const DASHBOARD_MIN_WIDTH = 598;
const DASHBOARD_MIN_HEIGHT = 418;

const NOISY_DEBUG_SCOPES = new Set([
  'core-audio-tap-helper:chunk',
  'system-audio-helper:chunk',
  'transcription:command',
  'transcription:result',
  'transcription:external-preview-result',
  'transcription:external-final-result',
  'transcription:qwen-fallback-whisper',
  'polisher:request',
  'polisher:result',
  'assistant:ask-start',
  'assistant:ask-end',
  'renderer-console',
]);

function debugLog(scope: string, data?: unknown) {
  if (!OPENWHISPR_VERBOSE_LOG && NOISY_DEBUG_SCOPES.has(scope)) return;
  const suffix = data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
  console.log(`[meeting-assistant:${scope}]${suffix}`);
}

function getMacosSystemAudioHelperPath() {
  return path.join(
    process.cwd(),
    'tools',
    'macos-system-audio-helper',
    '.build',
    'release',
    'openwhispr-system-audio-helper',
  );
}

function checkMacosSystemAudioHelper() {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      path: getMacosSystemAudioHelperPath(),
      error: 'Native system audio helper is only implemented for macOS right now.',
    };
  }
  const helperPath = getMacosSystemAudioHelperPath();
  if (!fsSync.existsSync(helperPath)) {
    return {
      ok: false,
      path: helperPath,
      error: 'Native macOS helper is not built. Run npm run build:macos-audio-helper.',
    };
  }
  return { ok: true, path: helperPath };
}

function getMacosCoreAudioTapHelperPath() {
  return path.join(
    process.cwd(),
    'tools',
    'macos-coreaudio-tap-helper',
    '.build',
    'release',
    'openwhispr-coreaudio-tap-helper',
  );
}

function checkMacosCoreAudioTapHelper() {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      path: getMacosCoreAudioTapHelperPath(),
      error: 'CoreAudio Tap helper is only implemented for macOS right now.',
    };
  }
  const helperPath = getMacosCoreAudioTapHelperPath();
  if (!fsSync.existsSync(helperPath)) {
    return {
      ok: false,
      path: helperPath,
      error: 'CoreAudio Tap helper is not built. Run npm run build:macos-coreaudio-tap-helper.',
    };
  }
  return { ok: true, path: helperPath };
}

function stopSystemAudioHelper(reason = 'stop') {
  if (!systemAudioHelperProcess) return { ok: true };
  debugLog('system-audio-helper:stop', { reason, pid: systemAudioHelperProcess.pid });
  const child = systemAudioHelperProcess;
  systemAudioHelperProcess = null;
  systemAudioHelperStdoutBuffer = Buffer.alloc(0);
  try {
    child.kill('SIGTERM');
  } catch (error) {
    debugLog('system-audio-helper:stop-error', String(error));
    return { ok: false, error: String(error) };
  }
  return { ok: true };
}

function parseSystemAudioHelperStdout(data: Buffer) {
  systemAudioHelperStdoutBuffer = Buffer.concat([systemAudioHelperStdoutBuffer, data]);
  const headerBytes = 20;
  while (systemAudioHelperStdoutBuffer.length >= headerBytes) {
    const magic = systemAudioHelperStdoutBuffer.subarray(0, 4).toString('ascii');
    if (magic !== 'OWHA') {
      const nextMagic = systemAudioHelperStdoutBuffer.indexOf(Buffer.from('OWHA'), 1);
      debugLog('system-audio-helper:bad-magic', {
        magic,
        bufferedBytes: systemAudioHelperStdoutBuffer.length,
        nextMagic,
      });
      systemAudioHelperStdoutBuffer = nextMagic >= 0
        ? systemAudioHelperStdoutBuffer.subarray(nextMagic)
        : Buffer.alloc(0);
      return;
    }

    const version = systemAudioHelperStdoutBuffer.readUInt32LE(4);
    const sampleRate = systemAudioHelperStdoutBuffer.readUInt32LE(8);
    const channels = systemAudioHelperStdoutBuffer.readUInt32LE(12);
    const frameCount = systemAudioHelperStdoutBuffer.readUInt32LE(16);
    const payloadBytes = frameCount * channels * 4;
    const packetBytes = headerBytes + payloadBytes;
    if (systemAudioHelperStdoutBuffer.length < packetBytes) return;

    const payload = systemAudioHelperStdoutBuffer.subarray(headerBytes, packetBytes);
    systemAudioHelperStdoutBuffer = systemAudioHelperStdoutBuffer.subarray(packetBytes);
    systemAudioHelperChunkSequence += 1;

    if (systemAudioHelperChunkSequence === 1 || systemAudioHelperChunkSequence % 100 === 0) {
      debugLog('system-audio-helper:chunk', {
        sequence: systemAudioHelperChunkSequence,
        version,
        sampleRate,
        channels,
        frameCount,
        payloadBytes,
      });
    }

    mainWindow?.webContents.send('system-audio-helper:chunk', {
      sequence: systemAudioHelperChunkSequence,
      version,
      sampleRate,
      channels,
      frameCount,
      pcm: payload,
    });
  }
}

function startSystemAudioHelper() {
  if (systemAudioHelperProcess) {
    return { ok: true, alreadyRunning: true };
  }
  const check = checkMacosSystemAudioHelper();
  if (!check.ok || !check.path) {
    debugLog('system-audio-helper:start-missing', check);
    return check;
  }

  systemAudioHelperStdoutBuffer = Buffer.alloc(0);
  systemAudioHelperChunkSequence = 0;
  const child = spawn(check.path, [], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  systemAudioHelperProcess = child;
  debugLog('system-audio-helper:start', { path: check.path, pid: child.pid });

  child.stdout.on('data', (chunk: Buffer) => {
    parseSystemAudioHelperStdout(Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) debugLog('system-audio-helper:stderr', text);
  });
  child.on('error', (error) => {
    debugLog('system-audio-helper:error', String(error));
    mainWindow?.webContents.send('system-audio-helper:status', {
      status: 'failed',
      error: String(error),
    });
  });
  child.on('exit', (code, signal) => {
    debugLog('system-audio-helper:exit', { code, signal });
    if (systemAudioHelperProcess === child) {
      systemAudioHelperProcess = null;
      systemAudioHelperStdoutBuffer = Buffer.alloc(0);
    }
    const screenCaptureTimeout = code === 5;
    const errorMessage = screenCaptureTimeout
      ? 'SCK_START_TIMEOUT: startCapture did not return (not necessarily Screen Recording). Try: ad-hoc codesign the helper, run from the Electron app, valid stream size + screen+audio outputs, or macOS/SCK quirks. See helper stderr for details.'
      : code !== 0 && code !== null
        ? `Native system audio helper exited with code ${code}.`
        : undefined;
    mainWindow?.webContents.send('system-audio-helper:status', {
      status: code === 0 ? 'stopped' : 'failed',
      code,
      signal,
      error: errorMessage,
    });
  });

  return { ok: true, path: check.path };
}

function stopCoreAudioTapHelper(reason = 'stop') {
  if (!coreAudioTapHelperProcess) return { ok: true };
  debugLog('core-audio-tap-helper:stop', { reason, pid: coreAudioTapHelperProcess.pid });
  const child = coreAudioTapHelperProcess;
  coreAudioTapHelperProcess = null;
  coreAudioTapHelperStdoutBuffer = Buffer.alloc(0);
  try {
    child.kill('SIGTERM');
  } catch (error) {
    debugLog('core-audio-tap-helper:stop-error', String(error));
    return { ok: false, error: String(error) };
  }
  return { ok: true };
}

function parseCoreAudioTapHelperStdout(data: Buffer) {
  coreAudioTapHelperStdoutBuffer = Buffer.concat([coreAudioTapHelperStdoutBuffer, data]);
  const headerBytes = 20;
  while (coreAudioTapHelperStdoutBuffer.length >= headerBytes) {
    const magic = coreAudioTapHelperStdoutBuffer.subarray(0, 4).toString('ascii');
    if (magic !== 'OWHA') {
      const nextMagic = coreAudioTapHelperStdoutBuffer.indexOf(Buffer.from('OWHA'), 1);
      debugLog('core-audio-tap-helper:bad-magic', {
        magic,
        bufferedBytes: coreAudioTapHelperStdoutBuffer.length,
        nextMagic,
      });
      coreAudioTapHelperStdoutBuffer = nextMagic >= 0
        ? coreAudioTapHelperStdoutBuffer.subarray(nextMagic)
        : Buffer.alloc(0);
      return;
    }

    const version = coreAudioTapHelperStdoutBuffer.readUInt32LE(4);
    const sampleRate = coreAudioTapHelperStdoutBuffer.readUInt32LE(8);
    const channels = coreAudioTapHelperStdoutBuffer.readUInt32LE(12);
    const frameCount = coreAudioTapHelperStdoutBuffer.readUInt32LE(16);
    const payloadBytes = frameCount * channels * 4;
    const packetBytes = headerBytes + payloadBytes;
    if (coreAudioTapHelperStdoutBuffer.length < packetBytes) return;

    const payload = coreAudioTapHelperStdoutBuffer.subarray(headerBytes, packetBytes);
    coreAudioTapHelperStdoutBuffer = coreAudioTapHelperStdoutBuffer.subarray(packetBytes);
    coreAudioTapHelperChunkSequence += 1;

    if (coreAudioTapHelperChunkSequence === 1 || coreAudioTapHelperChunkSequence % 100 === 0) {
      debugLog('core-audio-tap-helper:chunk', {
        sequence: coreAudioTapHelperChunkSequence,
        version,
        sampleRate,
        channels,
        frameCount,
        payloadBytes,
      });
    }

    mainWindow?.webContents.send('core-audio-tap-helper:chunk', {
      sequence: coreAudioTapHelperChunkSequence,
      version,
      sampleRate,
      channels,
      frameCount,
      pcm: payload,
    });
  }
}

function startCoreAudioTapHelper() {
  if (coreAudioTapHelperProcess) {
    return { ok: true, alreadyRunning: true };
  }
  const check = checkMacosCoreAudioTapHelper();
  if (!check.ok || !check.path) {
    debugLog('core-audio-tap-helper:start-missing', check);
    return check;
  }

  coreAudioTapHelperStdoutBuffer = Buffer.alloc(0);
  coreAudioTapHelperChunkSequence = 0;
  const child = spawn(check.path, ['--stream'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  coreAudioTapHelperProcess = child;
  debugLog('core-audio-tap-helper:start', { path: check.path, pid: child.pid });

  child.stdout.on('data', (chunk: Buffer) => {
    parseCoreAudioTapHelperStdout(Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) debugLog('core-audio-tap-helper:stderr', text);
  });
  child.on('error', (error) => {
    debugLog('core-audio-tap-helper:error', String(error));
    mainWindow?.webContents.send('core-audio-tap-helper:status', {
      status: 'failed',
      error: String(error),
    });
  });
  child.on('exit', (code, signal) => {
    debugLog('core-audio-tap-helper:exit', { code, signal });
    if (coreAudioTapHelperProcess === child) {
      coreAudioTapHelperProcess = null;
      coreAudioTapHelperStdoutBuffer = Buffer.alloc(0);
    }
    const errorMessage = code !== 0 && code !== null
      ? `CoreAudio Tap helper exited with code ${code}.`
      : undefined;
    mainWindow?.webContents.send('core-audio-tap-helper:status', {
      status: code === 0 ? 'stopped' : 'failed',
      code,
      signal,
      error: errorMessage,
    });
  });

  return { ok: true, path: check.path };
}

/** Full physical display bounds for session overlay (not workArea). */
function getOverlayTargetBounds() {
  return { ...screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds };
}

/** Compact app window centered in the current display work area (dashboard / home). */
function getDashboardWindowBounds() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = DASHBOARD_WINDOW_WIDTH;
  const h = DASHBOARD_WINDOW_HEIGHT;
  const x = Math.round(workArea.x + Math.max(0, (workArea.width - w) / 2));
  const y = Math.round(workArea.y + Math.max(0, (workArea.height - h) / 2));
  return { x, y, width: w, height: h };
}

function applyDashboardWindowMode() {
  if (!mainWindow) return;
  currentWindowMode = 'dashboard';
  mainWindow.setBounds(getDashboardWindowBounds());
  mainWindow.setMinimumSize(DASHBOARD_MIN_WIDTH, DASHBOARD_MIN_HEIGHT);
  mainWindow.setResizable(true);
  mainWindow.setAlwaysOnTop(false);
  if (OPENWHISPR_OVERLAY_WINDOW) {
    overlayPointerPassthroughIgnore = false;
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setBackgroundColor('#00000000');
  }
  debugLog('window:mode', { mode: 'dashboard', bounds: mainWindow.getBounds() });
}

/** Dashboard-sized overlay window before session chrome; renderer uses transparent root + solid panels only. */
function applySessionBootWindowMode() {
  if (!mainWindow || !OPENWHISPR_OVERLAY_WINDOW) return;
  currentWindowMode = 'dashboard';
  mainWindow.setBounds(getDashboardWindowBounds());
  mainWindow.setMinimumSize(DASHBOARD_MIN_WIDTH, DASHBOARD_MIN_HEIGHT);
  mainWindow.setResizable(true);
  mainWindow.setAlwaysOnTop(false);
  overlayPointerPassthroughIgnore = false;
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setBackgroundColor('#00000000');
  debugLog('window:mode', { mode: 'session-boot', bounds: mainWindow.getBounds() });
}

/** Session overlay: chrome + always-on-top, but keep current bounds until capture is ready (avoids black fullscreen during macOS display picker). */
function applySessionOverlayChromeOnly() {
  if (!mainWindow || !OPENWHISPR_OVERLAY_WINDOW) return;
  currentWindowMode = 'session';
  mainWindow.setMinimumSize(1, 1);
  mainWindow.setResizable(false);
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setBackgroundColor('#00000000');
  debugLog('window:mode', { mode: 'session', phase: 'chrome-only', bounds: mainWindow.getBounds() });
}

function expandSessionOverlayToFullDisplay() {
  if (!mainWindow || !OPENWHISPR_OVERLAY_WINDOW) return;
  mainWindow.setBounds(getOverlayTargetBounds());
  mainWindow.setBackgroundColor('#00000000');
  setTimeout(() => {
    mainWindow?.setBackgroundColor('#00000000');
  }, 0);
  debugLog('window:mode', { mode: 'session', phase: 'expanded', bounds: mainWindow.getBounds() });
}

function createWindow() {
  const initialDashboardBounds = getDashboardWindowBounds();
  const overlayOptions = OPENWHISPR_OVERLAY_WINDOW
    ? {
        x: initialDashboardBounds.x,
        y: initialDashboardBounds.y,
        width: initialDashboardBounds.width,
        height: initialDashboardBounds.height,
        minWidth: DASHBOARD_MIN_WIDTH,
        minHeight: DASHBOARD_MIN_HEIGHT,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000' as const,
        hasShadow: false,
        alwaysOnTop: false,
        resizable: true,
        fullscreenable: false,
        skipTaskbar: false,
      }
    : {
        x: initialDashboardBounds.x,
        y: initialDashboardBounds.y,
        width: initialDashboardBounds.width,
        height: initialDashboardBounds.height,
        minWidth: DASHBOARD_MIN_WIDTH,
        minHeight: DASHBOARD_MIN_HEIGHT,
        frame: true,
        transparent: false,
        backgroundColor: '#0f1419',
        hasShadow: true,
        alwaysOnTop: false,
        resizable: true,
      };

  currentWindowMode = 'dashboard';

  mainWindow = new BrowserWindow({
    ...overlayOptions,
    title: 'Openwhispr',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  debugLog('window:create', {
    overlayWindow: OPENWHISPR_OVERLAY_WINDOW,
    platform: process.platform,
    initialDashboardBounds,
  });

  const refreshOverlayBackground = () => {
    if (!OPENWHISPR_OVERLAY_WINDOW || !mainWindow) return;
    mainWindow.setBackgroundColor('#00000000');
  };

  mainWindow.once('ready-to-show', () => {
    applyDashboardWindowMode();
    mainWindow?.show();
  });

  const forwardRendererConsole = process.env.OPENWHISPR_RENDERER_CONSOLE === 'true';
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (!forwardRendererConsole) return;
    debugLog('renderer-console', { level, message, line, sourceId });
  });

  mainWindow.webContents.once('did-finish-load', () => {
    refreshOverlayBackground();
    if (OPENWHISPR_OVERLAY_WINDOW && mainWindow) {
      overlayPointerPassthroughIgnore = false;
      mainWindow.setIgnoreMouseEvents(false);
      debugLog('overlay:pointer-pass-through', { initial: false });
    }
    if (process.env.OPEN_DEVTOOLS === 'true') {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    overlayPointerPassthroughIgnore = null;
    mainWindow = null;
  });

  if (OPENWHISPR_OVERLAY_WINDOW) {
    mainWindow.on('focus', refreshOverlayBackground);
    mainWindow.on('blur', refreshOverlayBackground);
  }
}

function registerGlobalShortcuts() {
  const ok = globalShortcut.register('CommandOrControl+\\', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
      return;
    }
    mainWindow.showInactive();
  });
  debugLog('shortcuts:global-toggle-overlay', { ok });
}

function setupPermissions() {
  debugLog('permissions:init', {
    platform: process.platform,
    microphone: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'n/a',
    screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'n/a',
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowed = ['media', 'display-capture', 'speaker-selection'].includes(permission);
    debugLog('permissions:request', { permission, allowed, details });
    callback(allowed);
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const allowed = ['media', 'display-capture', 'speaker-selection'].includes(permission);
    if (process.env.OPENWHISPR_PERMISSION_DEBUG === 'true') {
      debugLog('permissions:check', { permission, requestingOrigin, details, allowed });
    }
    return allowed;
  });

  const displayMediaHandler: Parameters<typeof session.defaultSession.setDisplayMediaRequestHandler>[0] = (request, callback) => {
    debugLog('display-media:request', {
      securityOrigin: request.securityOrigin,
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
      userGesture: request.userGesture,
      platform: process.platform,
    });

    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        debugLog('display-media:sources', sources.map((source) => ({ id: source.id, name: source.name })));
        let picked = sources[0];
        if (preferredDisplayMediaSourceId) {
          const match = sources.find((s) => s.id === preferredDisplayMediaSourceId);
          if (match) {
            picked = match;
          } else {
            debugLog('display-media:preferred-not-found', {
              preferred: preferredDisplayMediaSourceId,
              availableScreenIds: sources.map((s) => s.id),
              ignoredReason: preferredDisplayMediaSourceId.startsWith('window:')
                ? 'window-source-ignored-for-macos-loopback'
                : 'not-found',
            });
          }
        }
        if (!picked) {
          debugLog('display-media:callback', 'no screen sources available');
          callback({});
          return;
        }

        const streams: {
          video?: { id: string; name: string };
          audio?: 'loopback' | 'loopbackWithMute';
        } = {
          video: { id: picked.id, name: picked.name },
        };

        if (request.audioRequested) {
          streams.audio = OPENWHISPR_LOOPBACK_MODE;
        }

        debugLog('display-media:callback', {
          picked: { id: picked.id, name: picked.name },
          preferred: preferredDisplayMediaSourceId,
          streamKinds: streams,
          loopbackMode: OPENWHISPR_LOOPBACK_MODE,
        });
        callback(streams);
      })
      .catch((error) => {
        debugLog('display-media:error', String(error));
        callback({});
      });
  };

  try {
    const setDisplayMediaRequestHandler = session.defaultSession.setDisplayMediaRequestHandler as unknown as (
      handler: Parameters<typeof session.defaultSession.setDisplayMediaRequestHandler>[0],
      opts?: { useSystemPicker?: boolean },
    ) => void;
    setDisplayMediaRequestHandler.call(
      session.defaultSession,
      displayMediaHandler,
      { useSystemPicker: OPENWHISPR_USE_SYSTEM_PICKER },
    );
    debugLog('display-media:handler-registered', {
      useSystemPicker: OPENWHISPR_USE_SYSTEM_PICKER,
      loopbackMode: OPENWHISPR_LOOPBACK_MODE,
    });
  } catch (error) {
    debugLog('display-media:handler-options-error', String(error));
    session.defaultSession.setDisplayMediaRequestHandler(displayMediaHandler);
    debugLog('display-media:handler-registered', {
      useSystemPicker: false,
      loopbackMode: OPENWHISPR_LOOPBACK_MODE,
    });
  }
}

function registerIpc() {
  ipcMain.on('display-capture:set-preferred-source-id', (_event, id: unknown) => {
    preferredDisplayMediaSourceId = typeof id === 'string' && id.length > 0 ? id : null;
    debugLog('display-capture:preferred-set', { id: preferredDisplayMediaSourceId });
  });

  ipcMain.on('overlay:set-pointer-pass-through', (_event, ignore: boolean) => {
    if (!mainWindow || !OPENWHISPR_OVERLAY_WINDOW) return;
    if (currentWindowMode !== 'session') return;
    if (overlayPointerPassthroughIgnore === ignore) return;
    overlayPointerPassthroughIgnore = ignore;
    mainWindow.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
  });

  ipcMain.handle('window:set-app-mode', (_event, mode: unknown) => {
    if (!mainWindow) return { ok: false };
    if (mode === 'session') {
      debugLog('window:mode', { mode: 'session' });
      if (OPENWHISPR_OVERLAY_WINDOW) {
        applySessionOverlayChromeOnly();
      }
      return { ok: true };
    }
    if (mode === 'session-boot') {
      debugLog('window:mode', { mode: 'session-boot' });
      if (OPENWHISPR_OVERLAY_WINDOW) {
        applySessionBootWindowMode();
      }
      return { ok: true };
    }
    if (mode === 'dashboard') {
      debugLog('window:mode', { mode: 'dashboard' });
      applyDashboardWindowMode();
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.on('window:session-overlay-expand', () => {
    if (!OPENWHISPR_OVERLAY_WINDOW || !mainWindow) return;
    if (currentWindowMode !== 'session') return;
    expandSessionOverlayToFullDisplay();
  });

  ipcMain.handle('platform:get-info', () => ({
    platform: process.platform,
    versions: process.versions,
    overlayWindow: OPENWHISPR_OVERLAY_WINDOW,
    mediaAccess: process.platform === 'darwin'
      ? {
          microphone: systemPreferences.getMediaAccessStatus('microphone'),
          screen: systemPreferences.getMediaAccessStatus('screen'),
        }
      : null,
  }));

  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') return { ok: false };
    try {
      clipboard.writeText(text);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('audio:get-desktop-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 160, height: 90 },
        fetchWindowIcons: true,
      });

      return {
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
        })),
        error: null,
      };
    } catch (error) {
      debugLog('desktop-sources:error', String(error));
      return {
        sources: [],
        error: `permission/system: no se pudieron listar fuentes de pantalla (${String(error)})`,
      };
    }
  });

  ipcMain.handle('system-audio-helper:check', () => {
    const result = checkMacosSystemAudioHelper();
    debugLog('system-audio-helper:check', result);
    return {
      ...result,
      running: Boolean(systemAudioHelperProcess),
    };
  });

  ipcMain.handle('system-audio-helper:start', () => {
    return startSystemAudioHelper();
  });

  ipcMain.handle('system-audio-helper:stop', () => {
    return stopSystemAudioHelper('ipc-stop');
  });

  ipcMain.handle('core-audio-tap-helper:check', () => {
    const result = checkMacosCoreAudioTapHelper();
    debugLog('core-audio-tap-helper:check', result);
    return {
      ...result,
      running: Boolean(coreAudioTapHelperProcess),
    };
  });

  ipcMain.handle('core-audio-tap-helper:start', () => {
    return startCoreAudioTapHelper();
  });

  ipcMain.handle('core-audio-tap-helper:stop', () => {
    return stopCoreAudioTapHelper('ipc-stop');
  });

  ipcMain.handle('files:save-wav', async (_event, payload: { bytes: Uint8Array; fileName?: string }) => {
    const recordingsDir = path.join(process.cwd(), 'recordings');
    await fs.mkdir(recordingsDir, { recursive: true });

    const safeName = (payload.fileName || `audio-test-${new Date().toISOString()}.wav`)
      .replace(/[:]/g, '-')
      .replace(/[\\/]/g, '-');
    const filePath = path.join(recordingsDir, safeName.endsWith('.wav') ? safeName : `${safeName}.wav`);

    await fs.writeFile(filePath, Buffer.from(payload.bytes));
    debugLog('files:save-wav', { filePath, byteLength: payload.bytes.byteLength });

    return {
      path: filePath,
      fileUrl: pathToFileURL(filePath).toString(),
    };
  });

  ipcMain.handle('transcription:check-setup', () => {
    return getWhisperSetupStatus();
  });

  ipcMain.handle('transcription:cancel-pending', () => {
    let cancelled = 0;
    for (const child of activeTranscriptionProcesses) {
      cancelled += 1;
      child.kill('SIGTERM');
    }
    activeTranscriptionProcesses.clear();
    debugLog('transcription:cancel-pending', { cancelled });
    return { ok: true, cancelled };
  });

  ipcMain.handle('transcription:transcribe-block', async (_event, payload: {
    blockId: string;
    wavBytes: Uint8Array;
    startMs: number;
    endMs: number;
    rms: number;
    peak?: number;
    sampleRate?: number;
    sampleCount?: number;
    whisperGain?: number;
    source: 'mic' | 'system' | 'mixed';
    glossary?: string;
    promptMode?: WhisperPromptMode;
    mode?: 'preview' | 'final' | 'benchmark';
    /** When set with mode preview/final, selects ggml model order for that ASR path (safeBaseline dual-model). */
    modelRole?: 'preview' | 'final';
    language?: 'es' | 'auto';
    /** When true: empty prompt, no session glossary, no transcription context pack (fidelity path). */
    verbatimOnly?: boolean;
    /** Preview only: `fast` uses small→base→turbo; `same-as-final` uses final model order (default). */
    previewModelPolicy?: 'same-as-final' | 'fast';
  }) => {
    return transcribeBlock(payload);
  });

  ipcMain.handle('polisher:check', async () => {
    return checkPolisherSetup();
  });

  ipcMain.handle('polisher:polish-segment', async (_event, payload: {
    batchId: string;
    rawSegments: Array<{
      id: string;
      startMs: number;
      endMs: number;
      text: string;
      qwenText?: string;
      source: 'mic' | 'system' | 'mixed';
      rms: number;
    }>;
    context: string;
    glossary: string;
    refinementMode?: TranscriptRefinementMode;
    prompt?: string;
  }) => {
    return polishSegment(payload);
  });

  ipcMain.handle('assistant:ask', async (_event, payload: {
    question: string;
    transcriptContext: string;
    refinedContext?: string;
  }) => {
    return askAssistant(payload);
  });
}

function getWhisperPaths() {
  const root = process.cwd();
  const whisperRoot = path.join(root, '.local', 'whisper.cpp');
  const cliPath = process.platform === 'win32'
    ? path.join(whisperRoot, 'build', 'bin', 'Release', 'whisper-cli.exe')
    : path.join(whisperRoot, 'build', 'bin', 'whisper-cli');
  const modelPath = path.join(root, '.local', 'models', 'ggml-base.bin');
  const modelsDir = path.join(root, '.local', 'models');
  return {
    root,
    whisperRoot,
    cliPath,
    modelPath,
    modelsDir,
    tmpDir: path.join(root, 'recordings', 'tmp'),
  };
}

function resolveWhisperModel(): { name: string; path: string } | null {
  const paths = getWhisperPaths();
  for (const name of WHISPER_MODEL_ORDER) {
    const modelPath = path.join(paths.modelsDir, `ggml-${name}.bin`);
    if (fsSync.existsSync(modelPath)) return { name, path: modelPath };
  }
  return null;
}

function getWhisperSetupStatus() {
  const paths = getWhisperPaths();
  const asrConfig = getAsrConfig();
  const ffmpegOk = commandExists('ffmpeg');
  const cliOk = fsSync.existsSync(paths.cliPath);
  const candidates = WHISPER_MODEL_ORDER.map((name) => {
    const fp = path.join(paths.modelsDir, `ggml-${name}.bin`);
    return {
      name,
      path: fp,
      exists: fsSync.existsSync(fp),
    };
  });
  const resolved = resolveWhisperModel();
  const modelOk = Boolean(resolved);
  const ok = ffmpegOk && cliOk && modelOk;
  const missing = [
    !ffmpegOk ? 'ffmpeg' : null,
    !cliOk ? 'whisper-cli' : null,
    !modelOk ? 'ggml-large-v3-turbo.bin' : null,
  ].filter(Boolean);

  return {
    ok,
    missing,
    cliPath: paths.cliPath,
    modelPath: resolved?.path ?? path.join(paths.modelsDir, 'ggml-large-v3-turbo.bin'),
    activeModelName: resolved?.name ?? null,
    previewModelName: asrConfig.pipelineMode === 'moonshine-qwen-v2' && asrConfig.experimentalPreview && asrConfig.moonshineCmd ? 'moonshine' : null,
    finalModelName: asrConfig.finalEngine === 'qwen' && asrConfig.qwenCmd ? 'qwen3-asr' : (resolved?.name ?? null),
    modelCandidates: candidates,
    pipelineMode: asrConfig.pipelineMode,
    moonshineConfigured: Boolean(asrConfig.experimentalPreview && asrConfig.moonshineCmd),
    qwenConfigured: Boolean(asrConfig.qwenCmd),
    experimentalPreview: asrConfig.experimentalPreview,
    finalEngine: asrConfig.finalEngine,
    refinementMode: asrConfig.refinementMode,
    refinerModel: POLISHER_MODEL,
    message: ok
      ? `Whisper listo (large-v3-turbo). Pipeline: ${asrConfig.pipelineMode}.`
      : `Whisper no está listo. Ejecuta npm run whisper:setup:turbo. Falta: ${missing.join(', ')}`,
  };
}

function getAsrConfig(): {
  pipelineMode: AsrPipelineMode;
  moonshineCmd: string | null;
  qwenCmd: string | null;
  experimentalPreview: boolean;
  finalEngine: AsrFinalEngineMode;
  refinementMode: TranscriptRefinementMode;
} {
  const requested = process.env.ASR_PIPELINE_MODE;
  const pipelineMode: AsrPipelineMode = requested === 'moonshine-qwen-v2' ? 'moonshine-qwen-v2' : 'baseline-whisper';
  const requestedFinalEngine = process.env.ASR_FINAL_ENGINE;
  const finalEngine: AsrFinalEngineMode = requestedFinalEngine === 'qwen' || requestedFinalEngine === 'compare'
    ? requestedFinalEngine
    : 'whisper';
  const requestedRefinementMode = process.env.TRANSCRIPT_REFINEMENT_MODE;
  const refinementMode: TranscriptRefinementMode = requestedRefinementMode === 'whisper-only' || requestedRefinementMode === 'whisper-qwen'
    ? requestedRefinementMode
    : 'off';
  const defaultQwenCmd = fsSync.existsSync(path.join(process.cwd(), 'scripts', 'asr_qwen3_final.py'))
    && fsSync.existsSync(path.join(process.cwd(), '.venv-qwen-asr', 'bin', 'python'))
    ? DEFAULT_QWEN_ASR_CMD
    : null;
  return {
    pipelineMode,
    moonshineCmd: process.env.MOONSHINE_ASR_CMD?.trim() || null,
    qwenCmd: process.env.QWEN3_ASR_CMD?.trim() || defaultQwenCmd,
    experimentalPreview: process.env.ENABLE_EXPERIMENTAL_PREVIEW === 'true',
    finalEngine,
    refinementMode,
  };
}

function commandExists(command: string) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function loadTranscriptionContextPack() {
  const contextPath = path.join(process.cwd(), 'config', 'transcription-context.json');
  try {
    const parsed = JSON.parse(fsSync.readFileSync(contextPath, 'utf8')) as Partial<TranscriptionContextPack>;
    return normalizeContextPack(parsed);
  } catch (error) {
    debugLog('context-pack:fallback', {
      contextPath,
      error: String(error),
    });
    return FALLBACK_TRANSCRIPTION_CONTEXT;
  }
}

function normalizeContextPack(candidate: Partial<TranscriptionContextPack>): TranscriptionContextPack {
  return {
    ...FALLBACK_TRANSCRIPTION_CONTEXT,
    ...candidate,
    style: {
      ...FALLBACK_TRANSCRIPTION_CONTEXT.style,
      ...(candidate.style ?? {}),
      notes: candidate.style?.notes ?? FALLBACK_TRANSCRIPTION_CONTEXT.style.notes,
    },
    domains: {
      ...FALLBACK_TRANSCRIPTION_CONTEXT.domains,
      ...(candidate.domains ?? {}),
    },
    peopleAliases: candidate.peopleAliases ?? FALLBACK_TRANSCRIPTION_CONTEXT.peopleAliases,
    customReplacements: candidate.customReplacements ?? FALLBACK_TRANSCRIPTION_CONTEXT.customReplacements,
    learning: {
      ...FALLBACK_TRANSCRIPTION_CONTEXT.learning,
      ...(candidate.learning ?? {}),
    },
  };
}

function buildWhisperPrompt(contextPack: TranscriptionContextPack, sessionGlossary?: string) {
  const frequentTerms = [
    ...pickDomainTerms(contextPack, 'software', 8),
    ...pickDomainTerms(contextPack, 'frontend', 5),
    ...pickDomainTerms(contextPack, 'backend', 5),
    ...pickDomainTerms(contextPack, 'cloudInfraSecurity', 5),
    ...pickDomainTerms(contextPack, 'aiTools', 5),
    ...pickDomainTerms(contextPack, 'businessBanking', 3),
  ];
  const glossaryTerms = sessionGlossary?.trim()
    ? sessionGlossary.trim().split(',').map((term) => term.trim()).filter(Boolean).slice(0, 16)
    : [];
  const parts = [
    MINIMAL_TRANSCRIPTION_PROMPT,
    'Puede haber terminos tecnicos en ingles, pero el idioma principal es espanol.',
    `Terminos esperados: ${uniqueStrings([...frequentTerms, ...glossaryTerms]).join(', ')}.`,
    'No conviertas audio incierto en otro idioma ni en siglas raras.',
  ].filter(Boolean);
  return clampPrompt(parts.join(' '), WHISPER_PROMPT_MAX_CHARS);
}

function buildPromptForMode(promptMode: WhisperPromptMode | undefined, contextPack: TranscriptionContextPack, sessionGlossary?: string) {
  const mode = promptMode ?? 'empty';
  if (mode === 'empty') return '';
  if (mode === 'minimal') {
    const glossaryTerms = sessionGlossary?.trim()
      ? sessionGlossary.trim().split(',').map((term) => term.trim()).filter(Boolean).slice(0, 10)
      : [];
    const glossaryText = glossaryTerms.length > 0 ? ` Terminos posibles: ${glossaryTerms.join(', ')}.` : '';
    return clampPrompt(`${MINIMAL_TRANSCRIPTION_PROMPT}${glossaryText}`, WHISPER_PROMPT_MAX_CHARS);
  }
  return buildWhisperPrompt(contextPack, sessionGlossary);
}

function summarizeContextPack(contextPack: TranscriptionContextPack, maxTerms = 90) {
  const terms = uniqueStrings(Object.values(contextPack.domains).flat()).slice(0, maxTerms);
  const aliases = contextPack.peopleAliases
    .slice(0, 18)
    .map((person) => `${person.canonical}: ${person.aliases.join(', ')}`)
    .join('; ');
  const replacements = contextPack.customReplacements
    .slice(0, 30)
    .map((replacement) => `${replacement.from} -> ${replacement.to}`)
    .join('; ');
  return [
    `Region/estilo: ${contextPack.style.region}; ${contextPack.style.tone}.`,
    `Notas: ${contextPack.style.notes.join(' ')}`,
    `Terminos tecnicos: ${terms.join(', ')}.`,
    aliases ? `Aliases de personas: ${aliases}.` : '',
    replacements ? `Reemplazos conocidos: ${replacements}.` : '',
  ].filter(Boolean).join('\n');
}

function pickDomainTerms(contextPack: TranscriptionContextPack, domain: string, limit: number) {
  return (contextPack.domains[domain] ?? []).slice(0, limit);
}

function clampPrompt(prompt: string, maxChars: number) {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, maxChars - 1).trimEnd();
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeForMatch(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function resolveTranscriptText(text: string, contextPack: TranscriptionContextPack) {
  let resolvedText = text;
  const replacements: TextReplacement[] = [];

  for (const replacement of contextPack.customReplacements) {
    resolvedText = replacePhrase(resolvedText, replacement.from, replacement.to, 'custom-replacement', replacements, 1);
  }

  for (const person of contextPack.peopleAliases) {
    for (const alias of person.aliases) {
      if (normalizeForMatch(alias) === normalizeForMatch(person.canonical)) continue;
      resolvedText = replacePhrase(resolvedText, alias, person.canonical, 'explicit-person-alias', replacements, 1);
    }
  }

  const technicalTerms = uniqueStrings(Object.values(contextPack.domains).flat());
  for (const term of technicalTerms) {
    resolvedText = replacePhrase(resolvedText, term, term, 'exact-technical-term', replacements, 0.96);
  }

  resolvedText = applyFuzzyTechnicalTerms(resolvedText, technicalTerms, replacements);

  return {
    text: resolvedText,
    replacements,
  };
}

function replacePhrase(
  text: string,
  from: string,
  to: string,
  reason: string,
  replacements: TextReplacement[],
  confidence: number,
) {
  const escaped = escapeRegExp(from.trim()).replace(/\s+/g, '\\s+');
  if (!escaped) return text;
  const pattern = new RegExp(`(^|[^\\p{Letter}\\p{Number}])(${escaped})(?=$|[^\\p{Letter}\\p{Number}])`, 'giu');
  return text.replace(pattern, (match, prefix: string, original: string) => {
    if (original === to) return match;
    replacements.push({ original, replacement: to, confidence, reason });
    return `${prefix}${to}`;
  });
}

function applyFuzzyTechnicalTerms(text: string, technicalTerms: string[], replacements: TextReplacement[]) {
  const tokens = splitTextWithSpaces(text);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isWordToken(tokens[index])) continue;

    const best = findBestTechnicalMatch(tokens, index, technicalTerms);
    if (!best || best.confidence < FUZZY_REPLACEMENT_THRESHOLD) continue;

    const original = tokens.slice(index, index + best.tokenCount).join('');
    if (normalizeForMatch(original) === normalizeForMatch(best.term)) continue;
    tokens.splice(index, best.tokenCount, best.term);
    replacements.push({
      original: original.trim(),
      replacement: best.term,
      confidence: Number(best.confidence.toFixed(2)),
      reason: 'fuzzy-technical-term',
    });
  }
  return tokens.join('');
}

function findBestTechnicalMatch(tokens: string[], startIndex: number, technicalTerms: string[]) {
  let best: { term: string; tokenCount: number; confidence: number } | null = null;
  for (const term of technicalTerms) {
    const termTokenCount = Math.max(1, term.trim().split(/\s+/).length);
    const slice = tokens.slice(startIndex, startIndex + termTokenCount);
    if (slice.length < termTokenCount || slice.some((token) => !isWordOrSpaceToken(token))) continue;
    const candidate = slice.join('');
    if (!candidate.trim()) continue;
    const candidateNorm = normalizeForMatch(candidate);
    const termNorm = normalizeForMatch(term);
    if (candidateNorm.length < 4 || termNorm.length < 4) continue;
    if (Math.abs(candidateNorm.length - termNorm.length) > 2) continue;
    const confidence = similarity(candidateNorm, termNorm);
    if (!best || confidence > best.confidence) {
      best = { term, tokenCount: termTokenCount, confidence };
    }
  }
  return best;
}

function splitTextWithSpaces(text: string) {
  return text.match(/\s+|[\p{Letter}\p{Number}.#/+_-]+|[^\s\p{Letter}\p{Number}]+/gu) ?? [];
}

function isWordToken(token: string) {
  return /[\p{Letter}\p{Number}]/u.test(token);
}

function isWordOrSpaceToken(token: string) {
  return /^\s+$/u.test(token) || isWordToken(token);
}

function similarity(left: string, right: string) {
  if (left === right) return 1;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function levenshtein(left: string, right: string) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[left.length][right.length];
}

function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact absolute paths in whisper-cli argv for renderer logs (keep basenames). */
function sanitizeWhisperCliArgsForLog(args: string[]): string[] {
  return args.map((segment) => (segment.includes('.wav') ? path.basename(segment) : segment));
}

type WhisperInvocationDebug = {
  language: 'es' | 'auto';
  promptLength: number;
  verbatimOnly: boolean;
  translateEnabled: false;
  argsSanitized: string[];
};

type ExternalAsrResult = {
  ok: boolean;
  text: string;
  durationMs: number;
  stderr: string;
  error?: string;
};

async function transcribeBlock(payload: {
  blockId: string;
  wavBytes: Uint8Array;
  startMs: number;
  endMs: number;
  rms: number;
  peak?: number;
  sampleRate?: number;
  sampleCount?: number;
  whisperGain?: number;
  source: 'mic' | 'system' | 'mixed';
  glossary?: string;
  promptMode?: WhisperPromptMode;
  mode?: 'preview' | 'final' | 'benchmark';
  modelRole?: 'preview' | 'final';
  language?: 'es' | 'auto';
  verbatimOnly?: boolean;
  previewModelPolicy?: 'same-as-final' | 'fast';
}) {
  const startedAt = Date.now();
  const paths = getWhisperPaths();
  await fs.mkdir(paths.tmpDir, { recursive: true });
  const wavPath = path.join(paths.tmpDir, `${payload.blockId}.wav`);
  await fs.writeFile(wavPath, Buffer.from(payload.wavBytes));

  const inferredRole: 'preview' | 'final' = payload.mode === 'preview' ? 'preview' : 'final';
  const role = payload.modelRole ?? inferredRole;
  const asrConfig = getAsrConfig();

  try {
    if (asrConfig.pipelineMode === 'moonshine-qwen-v2' && payload.mode === 'preview') {
      if (!asrConfig.experimentalPreview || !asrConfig.moonshineCmd) {
        return {
          ok: false,
          blockId: payload.blockId,
          durationMs: Date.now() - startedAt,
          error: asrConfig.experimentalPreview
            ? 'Moonshine preview no configurado (MOONSHINE_ASR_CMD vacío).'
            : 'Moonshine preview desactivado (ENABLE_EXPERIMENTAL_PREVIEW=false).',
          modelName: 'moonshine',
        };
      }

      const external = await runExternalAsrCommand(asrConfig.moonshineCmd, wavPath);
      debugLog('transcription:external-preview-result', {
        blockId: payload.blockId,
        engineUsed: 'moonshine',
        durationMs: external.durationMs,
        ok: external.ok,
        stderr: summarizeStderr(external.stderr),
        error: external.error,
      });
      return {
        ok: external.ok,
        blockId: payload.blockId,
        durationMs: external.durationMs,
        text: external.text,
        error: external.error,
        stderr: summarizeStderr(external.stderr),
        modelName: 'moonshine',
        modelPath: asrConfig.moonshineCmd,
        engineUsed: 'moonshine',
        fallbackUsed: false,
      };
    }

    let qwenResult: ExternalAsrResult | null = null;
    let qwenFallbackError: string | undefined;
    let qwenFallbackDurationMs: number | undefined;
    const shouldRunQwen = asrConfig.pipelineMode === 'moonshine-qwen-v2'
      && role === 'final'
      && payload.mode !== 'benchmark'
      && (asrConfig.finalEngine === 'qwen' || asrConfig.finalEngine === 'compare');
    if (shouldRunQwen) {
      if (asrConfig.qwenCmd) {
        const external = await runExternalAsrCommand(asrConfig.qwenCmd, wavPath);
        qwenResult = external;
        debugLog('transcription:external-final-result', {
          blockId: payload.blockId,
          engineUsed: 'qwen3-asr',
          durationMs: external.durationMs,
          ok: external.ok,
          fallbackUsed: !external.ok,
          finalEngine: asrConfig.finalEngine,
          stderr: summarizeStderr(external.stderr),
          error: external.error,
        });
        if (asrConfig.finalEngine === 'qwen' && external.ok) {
          return {
            ok: true,
            blockId: payload.blockId,
            durationMs: external.durationMs,
            text: external.text,
            resolvedText: undefined,
            replacements: [],
            stderr: summarizeStderr(external.stderr),
            modelName: 'qwen3-asr',
            modelPath: asrConfig.qwenCmd,
            engineUsed: 'qwen3-asr',
            fallbackUsed: false,
            qwenText: external.text,
            qwenDurationMs: external.durationMs,
          };
        }
        if (asrConfig.finalEngine === 'qwen' && !external.ok) {
          qwenFallbackError = external.error;
          qwenFallbackDurationMs = external.durationMs;
        }
      } else {
        if (asrConfig.finalEngine === 'qwen') {
          qwenFallbackError = 'Qwen final no configurado (QWEN3_ASR_CMD vacío).';
        }
      }
      if (qwenFallbackError) {
        debugLog('transcription:qwen-fallback-whisper', {
          blockId: payload.blockId,
          reason: qwenFallbackError,
          qwenDurationMs: qwenFallbackDurationMs,
        });
      }
    }

    const setup = getWhisperSetupStatus();
    if (!setup.ok) {
      return {
        ok: false,
        blockId: payload.blockId,
        durationMs: Date.now() - startedAt,
        error: setup.message,
      };
    }

  const modelResolved = resolveWhisperModel();
  if (!modelResolved) {
    return {
      ok: false,
      blockId: payload.blockId,
      durationMs: Date.now() - startedAt,
      error: 'No hay ggml-large-v3-turbo.bin en .local/models (npm run whisper:setup:turbo).',
    };
  }
  const activeModelName = modelResolved.name;
  const modelPathForRun = modelResolved.path;

  const contextPack = loadTranscriptionContextPack();
  const promptMode = payload.promptMode ?? 'empty';
  const verbatimOnly = payload.verbatimOnly
    ?? (payload.mode === 'preview' || payload.mode === 'final' || payload.mode === undefined);
  const language = payload.language ?? 'es';
  const transcriptionPrompt = verbatimOnly
    ? ''
    : buildPromptForMode(promptMode, contextPack, payload.glossary);

  const isLivePreview = payload.mode === 'preview';
  /** Preview: greedy-ish (beam 1); final: beam 5 para mejor texto en segmentos largos. */
  const bestOf = isLivePreview ? '1' : (activeModelName === 'base' ? '1' : '2');
  const beamSize = isLivePreview ? '1' : '5';

  const args = [
    '-m', modelPathForRun,
    '-f', wavPath,
    '--no-timestamps',
    '-sns',
    '-t', '8',
    '-bo', bestOf,
    '-bs', beamSize,
    '-tp', '0',
    '-nf',
    '-np',
  ];
  if (language === 'es') {
    args.push('-l', 'es');
  }
  // language === 'auto': omit -l (whisper.cpp default often biases to English). This app never passes --translate / translation task.
  if (transcriptionPrompt) {
    args.push('--prompt', transcriptionPrompt);
  }
  const whisperDebug: WhisperInvocationDebug = {
    language,
    promptLength: transcriptionPrompt.length,
    verbatimOnly,
    translateEnabled: false,
    argsSanitized: sanitizeWhisperCliArgsForLog(args),
  };
  debugLog('transcription:command', {
    command: paths.cliPath,
    args,
    model: activeModelName,
    modelRole: role,
    blockId: payload.blockId,
    mode: payload.mode,
    language,
    verbatimOnly,
    translateEnabled: false,
    startMs: payload.startMs,
    endMs: payload.endMs,
    rms: payload.rms,
    peak: payload.peak,
    sampleRate: payload.sampleRate,
    sampleCount: payload.sampleCount,
    whisperGain: payload.whisperGain,
    promptMode: verbatimOnly ? 'verbatim-off' : promptMode,
    whisperPromptLength: transcriptionPrompt.length,
    whisperPrompt: transcriptionPrompt,
    source: payload.source,
  });

  try {
    const whisperStartedAt = Date.now();
    const result = await runWhisper(paths.cliPath, args);
    const durationMs = Date.now() - startedAt;
    const whisperDurationMs = Date.now() - whisperStartedAt;
    const text = parseWhisperText(result.stdout);
    const stderrSummary = summarizeStderr(result.stderr);
    debugLog('transcription:result', {
      blockId: payload.blockId,
      durationMs,
      exitCode: result.exitCode,
      text,
      replacements: [],
      stderrSummary,
      model: activeModelName,
      modelRole: role,
      sampleRate: payload.sampleRate,
      sampleCount: payload.sampleCount,
      whisperGain: payload.whisperGain,
      promptMode,
      whisperPromptLength: transcriptionPrompt.length,
    });

    if (result.exitCode !== 0) {
      return {
        ok: false,
        blockId: payload.blockId,
        durationMs,
        error: stderrSummary || `whisper-cli exited with code ${result.exitCode}`,
        whisperDebug,
      };
    }

    return {
      ok: true,
      blockId: payload.blockId,
      durationMs,
      text,
      resolvedText: undefined,
      replacements: [],
      whisperPromptLength: transcriptionPrompt.length,
      stderr: stderrSummary,
      modelName: activeModelName,
      modelPath: modelPathForRun,
      engineUsed: 'whisper-large-v3-turbo',
      fallbackUsed: Boolean(qwenFallbackError),
      fallbackReason: qwenFallbackError,
      whisperText: text,
      whisperDurationMs,
      qwenText: qwenResult?.ok ? qwenResult.text : undefined,
      qwenDurationMs: qwenResult?.durationMs,
      qwenError: qwenResult && !qwenResult.ok ? qwenResult.error : undefined,
      whisperDebug,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
      ok: false,
      blockId: payload.blockId,
      durationMs,
      error: String(error),
      whisperDebug,
    };
  }
  } finally {
    fs.unlink(wavPath).catch(() => undefined);
  }
}

function runWhisper(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: process.env,
    });
    activeTranscriptionProcesses.add(child);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      activeTranscriptionProcesses.delete(child);
      reject(error);
    });
    child.on('close', (exitCode) => {
      activeTranscriptionProcesses.delete(child);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function runExternalAsrCommand(commandLine: string, wavPath: string): Promise<ExternalAsrResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(commandLine, [wavPath], {
      windowsHide: true,
      env: process.env,
      shell: true,
    });
    activeTranscriptionProcesses.add(child);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      activeTranscriptionProcesses.delete(child);
      resolve({
        ok: false,
        text: '',
        durationMs: Date.now() - startedAt,
        stderr,
        error: String(error),
      });
    });
    child.on('close', (exitCode) => {
      activeTranscriptionProcesses.delete(child);
      const text = sanitizeExternalAsrText(stdout);
      const ok = exitCode === 0 && text.length > 0;
      resolve({
        ok,
        text,
        durationMs: Date.now() - startedAt,
        stderr,
        error: ok ? undefined : (summarizeStderr(stderr) || `external ASR exited with code ${exitCode}`),
      });
    });
  });
}

function parseWhisperText(stdout: string) {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/u, '').trim())
    .filter((line) => line && !line.startsWith('whisper_') && !line.startsWith('system_info:'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeExternalAsrText(stdout: string) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeStderr(stderr: string) {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n');
}

async function checkPolisherSetup() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags');
    if (!response.ok) {
      return {
        ok: false,
        model: POLISHER_MODEL,
        message: `Ollama respondió ${response.status}. Abre Ollama y ejecuta npm run polisher:setup.`,
      };
    }
    const data = await response.json() as { models?: Array<{ name?: string }> };
    const models = data.models?.map((model) => model.name ?? '') ?? [];
    const hasModel = models.some((name) => name === POLISHER_MODEL || name.startsWith(`${POLISHER_MODEL}:`));
    return {
      ok: hasModel,
      model: POLISHER_MODEL,
      message: hasModel
        ? 'Polisher listo.'
        : `Falta ${POLISHER_MODEL}. Ejecuta npm run polisher:setup.`,
    };
  } catch (error) {
    return {
      ok: false,
      model: POLISHER_MODEL,
      message: `Ollama no está disponible. Abre Ollama y ejecuta npm run polisher:setup. (${String(error)})`,
    };
  }
}

async function polishSegment(payload: {
  batchId: string;
  rawSegments: Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    qwenText?: string;
    source: 'mic' | 'system' | 'mixed';
    rms: number;
  }>;
  context: string;
  glossary: string;
  refinementMode?: TranscriptRefinementMode;
  prompt?: string;
}) {
  const setup = await checkPolisherSetup();
  const startedAt = Date.now();
  if (!setup.ok) {
    return {
      ok: false,
      batchId: payload.batchId,
      durationMs: 0,
      error: setup.message,
    };
  }

  const rawText = payload.rawSegments
    .map((segment) => [
      `${formatMsForPrompt(segment.startMs)}-${formatMsForPrompt(segment.endMs)} Whisper principal: ${segment.text}`,
      payload.refinementMode === 'whisper-qwen' && segment.qwenText?.trim()
        ? `Qwen apoyo: ${segment.qwenText.trim()}`
        : '',
    ].filter(Boolean).join('\n'))
    .join('\n');
  const prompt = payload.prompt ?? [
    'Eres un corrector mecanico de transcripciones.',
    '',
    'Tu tarea:',
    '- Whisper es la fuente principal.',
    '- Qwen, si aparece, es solo apoyo secundario.',
    '- Si hay duda entre Whisper y Qwen, preferi Whisper.',
    '- Mejora puntuacion, signos de interrogacion, mayusculas y separacion de frases.',
    '- No inventes informacion.',
    '- No agregues frases nuevas.',
    '- No resumas.',
    '- No conviertas en acta.',
    '- No cambies el tono del hablante.',
    '- No traduzcas.',
    '- Manten terminos tecnicos.',
    '- Devolve solo el texto refinado, sin prefacios ni listas.',
    '',
    `Glosario:\n${payload.glossary || '(sin glosario)'}`,
    '',
    `Contexto previo:\n${payload.context || '(sin contexto previo)'}`,
    '',
    `Segmentos:\n${rawText}`,
    '',
    'Texto refinado:',
  ].join('\n');

  debugLog('polisher:request', {
    batchId: payload.batchId,
    model: POLISHER_MODEL,
    rawSegmentCount: payload.rawSegments.length,
    rawInputLength: rawText.length,
    promptLength: prompt.length,
    replacements: [],
  });

  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: POLISHER_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          top_p: 0.8,
          num_predict: 700,
        },
      }),
    });

    if (!response.ok) {
      return {
        ok: false,
        batchId: payload.batchId,
        durationMs: Date.now() - startedAt,
        error: `Ollama respondió ${response.status}`,
      };
    }

    const data = await response.json() as { response?: string };
    const text = sanitizePolishedText(data.response ?? '');
    debugLog('polisher:result', {
      batchId: payload.batchId,
      durationMs: Date.now() - startedAt,
      text,
      rawText,
      replacements: [],
      promptLength: prompt.length,
    });

    return {
      ok: true,
      batchId: payload.batchId,
      durationMs: Date.now() - startedAt,
      text,
    };
  } catch (error) {
    return {
      ok: false,
      batchId: payload.batchId,
      durationMs: Date.now() - startedAt,
      error: String(error),
    };
  }
}

function sanitizePolishedText(text: string) {
  return text
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function askAssistant(payload: {
  question: string;
  transcriptContext: string;
  refinedContext?: string;
}) {
  const setup = await checkPolisherSetup();
  const startedAt = Date.now();
  debugLog('assistant:ask-start', {
    model: POLISHER_MODEL,
    transcriptChars: payload.transcriptContext.length,
    refinedChars: payload.refinedContext?.length ?? 0,
  });
  if (!setup.ok) {
    debugLog('assistant:ask-error', {
      durationMs: Date.now() - startedAt,
      error: setup.message,
    });
    return {
      ok: false,
      durationMs: 0,
      error: 'No pude responder con la IA local. Revisa que Gemma esté disponible.',
    };
  }

  const transcriptContext = payload.transcriptContext.slice(-7000);
  const refinedContext = payload.refinedContext?.slice(-4000) ?? '';
  const prompt = [
    'Sos un asistente local para una reunión.',
    'Respondé en español, de forma breve y útil.',
    'Usá la transcripción como fuente principal.',
    'No inventes. Si el contexto no alcanza, decilo claramente.',
    '',
    refinedContext ? `Transcripción refinada disponible:\n${refinedContext}` : '',
    '',
    `Transcripción principal:\n${transcriptContext || '(sin transcripción todavía)'}`,
    '',
    `Pregunta: ${payload.question}`,
    '',
    'Respuesta:',
  ].filter(Boolean).join('\n');

  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: POLISHER_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          top_p: 0.85,
          num_predict: 420,
        },
      }),
    });

    if (!response.ok) {
      debugLog('assistant:ask-error', {
        durationMs: Date.now() - startedAt,
        status: response.status,
      });
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: 'No pude responder con la IA local. Revisa que Gemma esté disponible.',
      };
    }

    const data = await response.json() as { response?: string };
    const text = sanitizePolishedText(data.response ?? '');
    debugLog('assistant:ask-end', {
      durationMs: Date.now() - startedAt,
      ok: Boolean(text),
      responseChars: text.length,
    });
    return {
      ok: Boolean(text),
      durationMs: Date.now() - startedAt,
      text,
      error: text ? undefined : 'No pude responder con la IA local. Revisa que Gemma esté disponible.',
    };
  } catch (error) {
    debugLog('assistant:ask-error', {
      durationMs: Date.now() - startedAt,
      error: String(error),
    });
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: 'No pude responder con la IA local. Revisa que Gemma esté disponible.',
    };
  }
}

function formatMsForPrompt(value: number) {
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

app.whenReady().then(() => {
  try {
    setupPermissions();
  } catch (error) {
    debugLog('permissions:setup-failed', String(error));
  }
  registerIpc();
  createWindow();
  registerGlobalShortcuts();

  screen.on('display-metrics-changed', () => {
    if (!mainWindow) return;
    if (currentWindowMode === 'session' && OPENWHISPR_OVERLAY_WINDOW) {
      expandSessionOverlayToFullDisplay();
      return;
    }
    if (currentWindowMode === 'dashboard') {
      applyDashboardWindowMode();
    }
  });
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopSystemAudioHelper('app-will-quit');
  globalShortcut.unregisterAll();
});
