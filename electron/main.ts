import { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences } from 'electron';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const POLISHER_MODEL = 'gemma3:4b';
/** Prefer larger model for VAD-final blocks; preview uses small→base→turbo fallback for speed. */
const WHISPER_MODEL_ORDER_FINAL = ['large-v3-turbo', 'small', 'base'] as const;
const WHISPER_MODEL_ORDER_PREVIEW = ['small', 'base', 'large-v3-turbo'] as const;
const WHISPER_MODEL_PRIORITY = WHISPER_MODEL_ORDER_FINAL;
const WHISPER_PROMPT_MAX_CHARS = 520;
const FUZZY_REPLACEMENT_THRESHOLD = 0.88;
const MINIMAL_TRANSCRIPTION_PROMPT = [
  'Transcribe audio de una conversacion en espanol latinoamericano.',
  'Escribe solo lo que se oye; no inventes palabras, nombres ni siglas.',
  'Si no entiendes un fragmento, omite ese fragmento antes que cambiar de idioma.',
  'Mantén muletillas y dudas cuando sean audibles.',
].join(' ');

type WhisperPromptMode = 'empty' | 'minimal' | 'contextual';

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
const activeTranscriptionProcesses = new Set<ChildProcessWithoutNullStreams>();

function debugLog(scope: string, data?: unknown) {
  const suffix = data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
  console.log(`[meeting-assistant:${scope}]${suffix}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 700,
    title: 'Local Meeting Assistant',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    debugLog('renderer-console', { level, message, line, sourceId });
  });

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
    debugLog('permissions:check', { permission, requestingOrigin, details, allowed });
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
        const firstScreen = sources[0];
        if (!firstScreen) {
          debugLog('display-media:callback', 'no screen sources available');
          callback({});
          return;
        }

        const streams: {
          video?: { id: string; name: string };
          audio?: 'loopback' | 'loopbackWithMute';
        } = {
          video: { id: firstScreen.id, name: firstScreen.name },
        };

        if (request.audioRequested) {
          streams.audio = 'loopback';
        }

        debugLog('display-media:callback', streams);
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
      { useSystemPicker: process.platform === 'darwin' },
    );
    debugLog('display-media:handler-registered', { useSystemPicker: process.platform === 'darwin' });
  } catch (error) {
    debugLog('display-media:handler-options-error', String(error));
    session.defaultSession.setDisplayMediaRequestHandler(displayMediaHandler);
    debugLog('display-media:handler-registered', { useSystemPicker: false });
  }
}

function registerIpc() {
  ipcMain.handle('platform:get-info', () => ({
    platform: process.platform,
    versions: process.versions,
    mediaAccess: process.platform === 'darwin'
      ? {
          microphone: systemPreferences.getMediaAccessStatus('microphone'),
          screen: systemPreferences.getMediaAccessStatus('screen'),
        }
      : null,
  }));

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
      source: 'mic' | 'system' | 'mixed';
      rms: number;
    }>;
    context: string;
    glossary: string;
  }) => {
    return polishSegment(payload);
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

function resolveWhisperModelForRole(role: 'preview' | 'final'): { name: string; path: string } | null {
  const paths = getWhisperPaths();
  const order = role === 'preview' ? WHISPER_MODEL_ORDER_PREVIEW : WHISPER_MODEL_ORDER_FINAL;
  for (const name of order) {
    const modelPath = path.join(paths.modelsDir, `ggml-${name}.bin`);
    if (fsSync.existsSync(modelPath)) return { name, path: modelPath };
  }
  return null;
}

function getWhisperSetupStatus() {
  const paths = getWhisperPaths();
  const ffmpegOk = commandExists('ffmpeg');
  const cliOk = fsSync.existsSync(paths.cliPath);
  const candidates = WHISPER_MODEL_PRIORITY.map((name) => {
    const fp = path.join(paths.modelsDir, `ggml-${name}.bin`);
    return {
      name,
      path: fp,
      exists: fsSync.existsSync(fp),
    };
  });
  const finalResolved = resolveWhisperModelForRole('final');
  const previewResolved = resolveWhisperModelForRole('preview');
  const activeModel = finalResolved ?? previewResolved;
  const modelOk = Boolean(activeModel);
  const ok = ffmpegOk && cliOk && modelOk;
  const missing = [
    !ffmpegOk ? 'ffmpeg' : null,
    !cliOk ? 'whisper-cli' : null,
    !modelOk ? 'ggml-large-v3-turbo.bin | ggml-small.bin | ggml-base.bin' : null,
  ].filter(Boolean);

  return {
    ok,
    missing,
    cliPath: paths.cliPath,
    modelPath: activeModel?.path ?? path.join(paths.modelsDir, 'ggml-large-v3-turbo.bin'),
    activeModelName: activeModel?.name ?? null,
    previewModelName: previewResolved?.name ?? null,
    finalModelName: finalResolved?.name ?? null,
    modelCandidates: candidates,
    message: ok
      ? `Whisper listo (final: ${finalResolved?.name ?? '—'}, preview: ${previewResolved?.name ?? '—'}).`
      : `Whisper no está listo. Ejecuta npm run whisper:setup:turbo. Falta: ${missing.join(', ')}`,
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
  const setup = getWhisperSetupStatus();
  const startedAt = Date.now();
  if (!setup.ok) {
    return {
      ok: false,
      blockId: payload.blockId,
      durationMs: 0,
      error: setup.message,
    };
  }

  const paths = getWhisperPaths();
  await fs.mkdir(paths.tmpDir, { recursive: true });
  const wavPath = path.join(paths.tmpDir, `${payload.blockId}.wav`);
  await fs.writeFile(wavPath, Buffer.from(payload.wavBytes));

  const inferredRole: 'preview' | 'final' = payload.mode === 'preview' ? 'preview' : 'final';
  const role = payload.modelRole ?? inferredRole;
  const previewPolicy = payload.previewModelPolicy ?? 'same-as-final';
  const modelOrderKey: 'preview' | 'final' =
    payload.mode === 'preview' && previewPolicy === 'fast' ? 'preview' : 'final';
  const modelResolved = resolveWhisperModelForRole(modelOrderKey);
  if (!modelResolved) {
    return {
      ok: false,
      blockId: payload.blockId,
      durationMs: Date.now() - startedAt,
      error: 'No hay modelo ggml instalado para este rol de transcripción.',
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

  const args = [
    '-m', modelPathForRun,
    '-f', wavPath,
    '--no-timestamps',
    '-sns',
    '-t', '8',
    '-bo', activeModelName === 'base' ? '1' : '2',
    '-bs', '5',
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
    modelOrderKey,
    previewModelPolicy: payload.mode === 'preview' ? previewPolicy : undefined,
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
    const result = await runWhisper(paths.cliPath, args);
    const durationMs = Date.now() - startedAt;
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

function parseWhisperText(stdout: string) {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/u, '').trim())
    .filter((line) => line && !line.startsWith('whisper_') && !line.startsWith('system_info:'))
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
    source: 'mic' | 'system' | 'mixed';
    rms: number;
  }>;
  context: string;
  glossary: string;
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
    .map((segment) => `${formatMsForPrompt(segment.startMs)}-${formatMsForPrompt(segment.endMs)} ${segment.text}`)
    .join('\n');
  const prompt = [
    'Eres un corrector mecanico de transcripciones.',
    '',
    'Tu tarea:',
    '- Solo corrige puntuacion, mayusculas y espacios.',
    '- No agregues palabras.',
    '- No elimines palabras.',
    '- No cambies terminos.',
    '- No cambies nombres.',
    '- No traduzcas.',
    '- No reescribas.',
    '- No resumas.',
    '- No mejores vocabulario tecnico.',
    '- Si una palabra parece mal reconocida, dejala igual.',
    '- Devuelve solo el texto corregido, sin prefacios ni listas.',
    '',
    `Contexto previo:\n${payload.context || '(sin contexto previo)'}`,
    '',
    `Texto literal original:\n${rawText}`,
    '',
    'Texto con solo puntuacion/mayusculas/espacios corregidos:',
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
          num_predict: 220,
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
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
