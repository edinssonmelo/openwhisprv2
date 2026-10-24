/**
 * Owns engine processes across sessions (Parakeet helper stays warm; whisper-server stays resident) and the
 * single active `AsrSession`. main.ts only wires IPC to this class. No Electron imports.
 */

import fs from 'node:fs';
import { AsrSession, type AsrEngine, type AsrSessionEvent } from './asrSession';
import { ParakeetHelperClient } from './parakeetHelperClient';
import type { AsrLanguageCode, AsrSource, HelperEvent } from './protocol';
import { interleavedToMono } from './resample';
import { WhisperEngine } from './whisperEngine';

export type AsrEngineMode = 'parakeet' | 'whisper-fallback' | 'unavailable';

export interface AsrSessionStatus {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'error';
  sessionId: string | null;
  generation: number;
  engineMode: AsrEngineMode;
  liveEngine: string | null;
  finalEngine: string | null;
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

export interface AsrSessionManagerOptions {
  helperPath: string;
  modelDir: string;
  whisper: { cliPath: string; serverPath: string | null; modelPath: string } | null;
  send: (channel: 'asr:event' | 'asr:status', payload: unknown) => void;
  log: (scope: string, data?: unknown) => void;
  /** Feed the renderer with helper stderr for the debug panel. */
  onHelperLog?: (line: string) => void;
}

export interface StartSessionRequest {
  sessionId: string;
  generation: number;
  language: AsrLanguageCode;
  sources: { mic: boolean; system: boolean };
}

const HELPER_RESTARTS_PER_SESSION = 1;

export class AsrSessionManager {
  private readonly options: AsrSessionManagerOptions;
  private helper: ParakeetHelperClient | null = null;
  private whisper: WhisperEngine | null = null;
  private session: AsrSession | null = null;
  private sessionSources: { mic: boolean; system: boolean } = { mic: false, system: false };
  private state: AsrSessionStatus['state'] = 'idle';
  private engineMode: AsrEngineMode = 'unavailable';
  private message: string | null = null;
  private downloadFraction: number | null = null;
  private helperLastError: string | null = null;
  private helperRestartsThisSession = 0;
  private lastLiveEngine: string | null = null;
  private lastFinalEngine: string | null = null;
  private prepareInFlight: Promise<AsrSessionStatus> | null = null;

  constructor(options: AsrSessionManagerOptions) {
    this.options = options;
    if (options.whisper && WhisperEngine.isConfigured(options.whisper)) {
      this.whisper = new WhisperEngine({
        ...options.whisper,
        log: (message) => options.log('asr:whisper', message),
      });
    }
  }

  get helperConfigured(): boolean {
    return fs.existsSync(this.options.helperPath);
  }

  modelsPresent(): boolean {
    if (!fs.existsSync(this.options.modelDir)) return false;
    try {
      const entries = fs.readdirSync(this.options.modelDir);
      return entries.some((name) => name.endsWith('.mlmodelc')) && entries.some((name) => name.endsWith('vocab.json'));
    } catch {
      return false;
    }
  }

  status(): AsrSessionStatus {
    const health = this.helper?.health();
    return {
      state: this.state,
      sessionId: this.session?.sessionId ?? null,
      generation: this.session?.generation ?? 0,
      engineMode: this.engineMode,
      liveEngine: this.lastLiveEngine,
      finalEngine: this.lastFinalEngine,
      helper: {
        running: health?.running ?? false,
        ready: health?.ready ?? false,
        modelsPresent: this.modelsPresent(),
        downloadFraction: this.downloadFraction,
        lastError: this.helperLastError,
      },
      fallbackConfigured: this.whisper !== null,
      message: this.message,
    };
  }

  /** Warm engines before the user presses start (onboarding / dashboard). Safe to call repeatedly. */
  prepare(): Promise<AsrSessionStatus> {
    if (this.prepareInFlight) return this.prepareInFlight;
    this.prepareInFlight = this.prepareOnce().finally(() => {
      this.prepareInFlight = null;
    });
    return this.prepareInFlight;
  }

  private async prepareOnce(): Promise<AsrSessionStatus> {
    const helperReady = await this.ensureHelper();
    if (helperReady) {
      this.engineMode = 'parakeet';
      this.message = null;
    } else if (this.whisper) {
      this.engineMode = 'whisper-fallback';
      this.message = this.helperLastError ?? 'Parakeet helper unavailable; using Whisper (finals only).';
    } else {
      this.engineMode = 'unavailable';
      this.message = this.helperLastError ?? 'No ASR engine configured. Run npm run asr:setup.';
    }
    // Whisper warm-up runs in the background; a fallback final must never wait for the model load.
    this.whisper?.warmUp().catch((error: unknown) => this.options.log('asr:whisper-warmup-failed', String(error)));
    this.publishStatus();
    return this.status();
  }

  async start(request: StartSessionRequest): Promise<{ ok: boolean; status: AsrSessionStatus; error?: string }> {
    if (this.session && !this.session.isStopped) {
      await this.stop('restart');
    }
    this.state = 'starting';
    this.helperRestartsThisSession = 0;
    this.publishStatus();

    const helperReady = await this.ensureHelper();
    let engine: AsrEngine | null = null;
    let fallback: AsrEngine | null = null;
    if (helperReady && this.helper) {
      engine = this.helper;
      fallback = this.whisper;
      this.engineMode = 'parakeet';
      this.message = null;
    } else if (this.whisper) {
      engine = this.whisper;
      this.engineMode = 'whisper-fallback';
      this.message = this.helperLastError ?? 'Parakeet helper unavailable; using Whisper (finals only).';
    }
    if (!engine) {
      this.state = 'error';
      this.engineMode = 'unavailable';
      this.message = this.helperLastError ?? 'No ASR engine available. Run npm run asr:setup.';
      this.publishStatus();
      return { ok: false, status: this.status(), error: this.message };
    }

    this.sessionSources = { ...request.sources };
    this.session = new AsrSession({
      sessionId: request.sessionId,
      generation: request.generation,
      language: request.language,
      engine,
      fallbackEngine: fallback,
      emit: (event) => this.handleSessionEvent(event),
    });
    this.state = 'running';
    this.publishStatus();
    this.options.log('asr:session-start', {
      sessionId: request.sessionId,
      generation: request.generation,
      language: request.language,
      engine: engine.name,
      fallback: fallback?.name ?? null,
      sources: request.sources,
    });
    return { ok: true, status: this.status() };
  }

  /** Mono float32 from the renderer (mic) or any other producer. */
  pushAudio(sessionId: string, generation: number, source: AsrSource, pcm: Float32Array, sampleRate: number): boolean {
    const session = this.session;
    if (!session || session.isStopped || session.sessionId !== sessionId || session.generation !== generation) return false;
    if (!this.sessionSources[source]) return false;
    session.pushAudio(source, pcm, sampleRate);
    return true;
  }

  /** Interleaved float32 from the native system-audio helpers (main process path, no renderer round trip). */
  pushSystemAudioInterleaved(pcm: Float32Array, channels: number, sampleRate: number): void {
    const session = this.session;
    if (!session || session.isStopped || !this.sessionSources.system) return;
    session.pushAudio('system', interleavedToMono(pcm, channels), sampleRate);
  }

  /** Whether the active session consumes system audio in the main process. */
  get systemAudioWanted(): boolean {
    return Boolean(this.session && !this.session.isStopped && this.sessionSources.system);
  }

  async stop(reason: string): Promise<Extract<AsrSessionEvent, { type: 'drained' }> | null> {
    const session = this.session;
    if (!session) return null;
    this.state = 'stopping';
    this.publishStatus();
    const drained = await session.stop({ timeoutMs: 10_000 });
    this.options.log('asr:session-stop', { reason, ...drained, stats: session.stats });
    if (this.session === session) this.session = null;
    this.state = 'idle';
    this.publishStatus();
    return drained;
  }

  async shutdown(): Promise<void> {
    if (this.session && !this.session.isStopped) {
      await this.stop('shutdown');
    }
    const helper = this.helper;
    this.helper = null;
    await Promise.allSettled([helper?.stop(1_500), this.whisper?.stop()]);
  }

  // ——— internals ———

  private async ensureHelper(): Promise<boolean> {
    if (!this.helperConfigured) {
      this.helperLastError = `ASR helper binary missing at ${this.options.helperPath}`;
      return false;
    }
    if (this.helper?.isReady) return true;
    if (!this.helper) {
      this.helper = new ParakeetHelperClient({
        helperPath: this.options.helperPath,
        modelDir: this.options.modelDir,
        onEvent: (event) => this.handleHelperEvent(event),
      });
      this.helper.on('stderr', (text: string) => {
        this.options.log('asr:helper-stderr', text);
        this.options.onHelperLog?.(text);
      });
      this.helper.on('exit', (info: { code: number | null; signal: string | null; wasReady: boolean }) => {
        this.options.log('asr:helper-exit', info);
        this.helperLastError = `helper exited (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`;
        this.publishStatus();
        if (this.session && !this.session.isStopped && info.wasReady && this.helperRestartsThisSession < HELPER_RESTARTS_PER_SESSION) {
          this.helperRestartsThisSession += 1;
          this.options.log('asr:helper-restart', { attempt: this.helperRestartsThisSession });
          this.helper?.start().catch((error: unknown) => {
            this.helperLastError = error instanceof Error ? error.message : String(error);
            this.publishStatus();
          });
        }
      });
    }
    try {
      await this.helper.start();
      this.helperLastError = null;
      this.downloadFraction = null;
      return true;
    } catch (error) {
      this.helperLastError = error instanceof Error ? error.message : String(error);
      this.options.log('asr:helper-start-failed', this.helperLastError);
      return false;
    }
  }

  private handleHelperEvent(event: HelperEvent): void {
    switch (event.type) {
      case 'progress':
        this.downloadFraction = event.stage === 'download' ? event.fraction : null;
        this.message = event.stage === 'download' ? `Descargando modelo Parakeet… ${(event.fraction * 100).toFixed(0)}%` : 'Cargando modelo Parakeet…';
        this.publishStatus();
        return;
      case 'ready':
        this.downloadFraction = null;
        this.message = null;
        this.options.log('asr:helper-ready', { loadMs: event.loadMs, warmupMs: event.warmupMs, engine: event.engine });
        this.publishStatus();
        return;
      case 'fatal':
        this.helperLastError = event.message;
        this.options.log('asr:helper-fatal', event.message);
        this.publishStatus();
        return;
      case 'log':
        this.options.log('asr:helper-log', `${event.level}: ${event.message}`);
        return;
      default:
        return;
    }
  }

  private handleSessionEvent(event: AsrSessionEvent): void {
    if (event.type === 'preview') this.lastLiveEngine = event.engine;
    if (event.type === 'final') this.lastFinalEngine = event.engine;
    if (event.type === 'error') this.options.log('asr:engine-error', { kind: event.kind, message: event.message, segmentId: event.segmentId });
    this.options.send('asr:event', event);
  }

  private publishStatus(): void {
    this.options.send('asr:status', this.status());
  }
}
