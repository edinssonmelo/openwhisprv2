/**
 * Node-side client for `tools/macos-asr-helper` (Parakeet TDT 0.6B v3 on Core ML).
 * Owns the child process, the binary stdin framing and NDJSON stdout parsing, and maps requests to promises.
 * No Electron imports: the benchmark script drives it directly.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AsrEngine, EngineRequest, EngineResult } from './asrSession';
import { RequestDroppedError } from './asrSession';
import {
  encodeFrame,
  float32ToBytes,
  NdjsonParser,
  type HelperEvent,
  type HelperReadyEvent,
  type TranscribeFrameHeader,
} from './protocol';

export const PARAKEET_ENGINE_NAME = 'parakeet-tdt-0.6b-v3';

export interface ParakeetHelperOptions {
  helperPath: string;
  modelDir: string;
  /** Called for progress/log/fatal events so the app can surface model download and helper health. */
  onEvent?: (event: HelperEvent) => void;
  /** Model download + load + warm-up budget. First run downloads ~600 MB. */
  readyTimeoutMs?: number;
  /** Refuse new previews when this many bytes are queued on stdin (backpressure). */
  maxQueuedBytes?: number;
}

interface PendingRequest {
  request: EngineRequest;
  resolve: (result: EngineResult) => void;
  reject: (error: Error) => void;
  sentAt: number;
}

export interface HelperHealth {
  running: boolean;
  ready: boolean;
  pid: number | null;
  pending: number;
  queuedBytes: number;
  restarts: number;
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  lastFatal: string | null;
  ready_info: HelperReadyEvent | null;
}

/**
 * Lifecycle: `start()` spawns and resolves when the model is loaded and warmed up. Requests before `ready`
 * queue in memory and are flushed on ready. If the helper dies, pending requests reject and `start()` must
 * be called again (the session manager restarts it once per session; finals then go to the fallback engine).
 */
export class ParakeetHelperClient extends EventEmitter implements AsrEngine {
  readonly name = PARAKEET_ENGINE_NAME;
  readonly supportsPreview = true;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readyInfo: HelperReadyEvent | null = null;
  private readyPromise: Promise<HelperReadyEvent> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly parser = new NdjsonParser<HelperEvent>();
  private queuedBytes = 0;
  private restarts = 0;
  private lastExit: HelperHealth['lastExit'] = null;
  private lastFatal: string | null = null;
  private readonly options: Required<Omit<ParakeetHelperOptions, 'onEvent'>> & Pick<ParakeetHelperOptions, 'onEvent'>;

  constructor(options: ParakeetHelperOptions) {
    super();
    this.options = {
      readyTimeoutMs: 15 * 60_000,
      maxQueuedBytes: 48 * 1024 * 1024,
      ...options,
    };
  }

  get isReady(): boolean {
    return this.readyInfo !== null && this.child !== null;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  health(): HelperHealth {
    return {
      running: this.child !== null,
      ready: this.isReady,
      pid: this.child?.pid ?? null,
      pending: this.pending.size,
      queuedBytes: this.queuedBytes,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastFatal: this.lastFatal,
      ready_info: this.readyInfo,
    };
  }

  start(): Promise<HelperReadyEvent> {
    if (this.readyPromise) return this.readyPromise;
    if (this.child) this.restarts += 1;
    this.readyInfo = null;
    this.parser.reset();
    this.lastFatal = null;

    const child = spawn(this.options.helperPath, ['--serve', '--model-dir', this.options.modelDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    this.readyPromise = new Promise<HelperReadyEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ASR helper did not become ready within ${this.options.readyTimeoutMs} ms`));
        this.kill('ready-timeout');
      }, this.options.readyTimeoutMs);

      const onReady = (event: HelperReadyEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
      const onFail = (message: string) => {
        clearTimeout(timer);
        reject(new Error(message));
      };

      child.stdout.on('data', (chunk: Buffer) => {
        for (const event of this.parser.push(chunk)) this.handleEvent(event, onReady, onFail);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) this.emit('stderr', text);
      });
      child.on('error', (error) => {
        this.lastFatal = error.message;
        this.emit('fatal', error.message);
        onFail(`ASR helper failed to spawn: ${error.message}`);
        this.teardown(null, null);
      });
      child.on('exit', (code, signal) => {
        onFail(`ASR helper exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        this.teardown(code, signal);
      });
      child.stdin.on('error', (error) => {
        this.emit('stderr', `stdin error: ${error.message}`);
      });
      child.stdin.on('drain', () => {
        this.queuedBytes = 0;
      });
    });
    // Avoid unhandled rejection noise: callers await start() themselves.
    this.readyPromise.catch(() => undefined);
    return this.readyPromise;
  }

  async transcribe(request: EngineRequest): Promise<EngineResult> {
    if (!this.child || !this.readyPromise) {
      throw new Error('ASR helper is not running');
    }
    if (!this.readyInfo) {
      await this.readyPromise;
    }
    const child = this.child;
    if (!child || child.killed) throw new Error('ASR helper is not running');
    if (request.kind === 'preview' && this.queuedBytes > this.options.maxQueuedBytes) {
      throw new RequestDroppedError(request.requestId, 'backpressure');
    }
    const header: TranscribeFrameHeader = {
      type: 'transcribe',
      requestId: request.requestId,
      sessionId: request.sessionId,
      generation: request.generation,
      source: request.source,
      segmentId: request.segmentId,
      kind: request.kind,
      sampleRate: request.sampleRate,
      channels: 1,
      startMs: request.startMs,
      endMs: request.endMs,
      language: request.language,
    };
    const frame = encodeFrame(header, float32ToBytes(request.samples));
    return new Promise<EngineResult>((resolve, reject) => {
      this.pending.set(request.requestId, { request, resolve, reject, sentAt: Date.now() });
      const flushed = child.stdin.write(frame, (error) => {
        if (error) {
          this.pending.delete(request.requestId);
          reject(error);
        }
      });
      if (!flushed) this.queuedBytes += frame.length;
    });
  }

  cancelPreviews(sessionId: string): void {
    if (!this.child || !this.readyInfo) return;
    const ids: string[] = [];
    for (const [id, pending] of this.pending) {
      if (pending.request.kind === 'preview' && pending.request.sessionId === sessionId) ids.push(id);
    }
    this.write(encodeFrame({ type: 'cancel', requestIds: ids, sessionId, previewsOnly: true }));
  }

  /** Graceful stop: closes stdin (helper finishes the queue and exits), escalates to SIGKILL after `graceMs`. */
  async stop(graceMs = 3_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.write(encodeFrame({ type: 'shutdown' }));
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill('stop-timeout');
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  kill(reason: string): void {
    const child = this.child;
    if (!child) return;
    this.emit('stderr', `killing helper (${reason})`);
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }

  // ——— internals ———

  private write(frame: Buffer): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return;
    try {
      child.stdin.write(frame);
    } catch {
      // stdin closed; exit handler cleans up
    }
  }

  private handleEvent(event: HelperEvent, onReady: (event: HelperReadyEvent) => void, onFail: (message: string) => void): void {
    this.options.onEvent?.(event);
    switch (event.type) {
      case 'ready':
        this.readyInfo = event;
        onReady(event);
        this.emit('ready', event);
        return;
      case 'result': {
        const pending = this.pending.get(event.requestId);
        if (!pending) return;
        this.pending.delete(event.requestId);
        pending.resolve({
          text: event.text,
          confidence: event.confidence,
          processingMs: event.processingMs,
          engine: event.engine || this.name,
        });
        return;
      }
      case 'error': {
        const pending = this.pending.get(event.requestId);
        if (!pending) return;
        this.pending.delete(event.requestId);
        pending.reject(new Error(event.message));
        return;
      }
      case 'dropped': {
        const pending = this.pending.get(event.requestId);
        if (!pending) return;
        this.pending.delete(event.requestId);
        pending.reject(new RequestDroppedError(event.requestId, event.reason));
        return;
      }
      case 'fatal':
        this.lastFatal = event.message;
        this.emit('fatal', event.message);
        onFail(`ASR helper fatal: ${event.message}`);
        return;
      case 'progress':
        this.emit('progress', event);
        return;
      case 'log':
        this.emit('log', event);
        return;
      default:
        return;
    }
  }

  private teardown(code: number | null, signal: NodeJS.Signals | null): void {
    this.lastExit = { code, signal };
    const wasReady = this.readyInfo !== null;
    this.child = null;
    this.readyPromise = null;
    this.readyInfo = null;
    this.queuedBytes = 0;
    const error = new Error(`ASR helper exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit('exit', { code, signal, wasReady });
  }
}
