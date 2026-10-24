/**
 * whisper.cpp fallback engine. Prefers a resident `whisper-server` (model stays loaded, ~1 s per segment on
 * Apple Silicon) and falls back to a one-shot `whisper-cli` spawn when the server is unavailable.
 * Finals only: too slow for rolling previews. No Electron imports.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AsrEngine, EngineRequest, EngineResult } from './asrSession';
import { encodeWavPcm16Mono } from './resample';

export const WHISPER_ENGINE_NAME = 'whisper-large-v3-turbo';

export interface WhisperEngineOptions {
  cliPath: string;
  serverPath?: string | null;
  modelPath: string;
  threads?: number;
  /** Prefer the resident server. Defaults to true when `serverPath` exists. */
  useServer?: boolean;
  serverStartTimeoutMs?: number;
  log?: (message: string) => void;
}

const WHISPER_DECODE_ARGS = ['--no-timestamps', '-sns', '-bo', '2', '-bs', '5', '-tp', '0', '-nf', '-np'];

export function parseWhisperCliText(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/u, '').trim())
    .filter((line) => line && !line.startsWith('whisper_') && !line.startsWith('system_info:') && !line.startsWith('main:'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

export class WhisperEngine implements AsrEngine {
  readonly name = WHISPER_ENGINE_NAME;
  readonly supportsPreview = false;

  private readonly options: WhisperEngineOptions;
  private server: ChildProcess | null = null;
  private serverPort = 0;
  private serverReady: Promise<boolean> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private serverFailures = 0;

  constructor(options: WhisperEngineOptions) {
    this.options = options;
  }

  static isConfigured(options: Pick<WhisperEngineOptions, 'cliPath' | 'modelPath'>): boolean {
    return fs.existsSync(options.cliPath) && fs.existsSync(options.modelPath);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private get threads(): number {
    return this.options.threads ?? Math.max(4, Math.min(8, os.cpus().length));
  }

  private get shouldUseServer(): boolean {
    if (this.options.useServer === false) return false;
    if (this.serverFailures >= 2) return false;
    return Boolean(this.options.serverPath && fs.existsSync(this.options.serverPath));
  }

  /** Starts the resident server eagerly so the first fallback final does not pay the model load. */
  async warmUp(): Promise<void> {
    if (!this.shouldUseServer) return;
    await this.ensureServer();
  }

  transcribe(request: EngineRequest): Promise<EngineResult> {
    // whisper.cpp is CPU/GPU-bound; serialize so finals never fight each other.
    const run = this.queue.then(() => this.transcribeNow(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.serverReady = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          server.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        server.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  // ——— internals ———

  private async transcribeNow(request: EngineRequest): Promise<EngineResult> {
    const startedAt = Date.now();
    const wav = encodeWavPcm16Mono(request.samples, request.sampleRate);
    let text: string | null = null;
    if (this.shouldUseServer) {
      try {
        text = await this.transcribeViaServer(wav, request.language);
      } catch (error) {
        this.serverFailures += 1;
        this.log(`whisper-server failed (${this.serverFailures}): ${error instanceof Error ? error.message : String(error)}`);
        await this.stop();
      }
    }
    if (text === null) {
      text = await this.transcribeViaCli(wav, request.language);
    }
    return { text, processingMs: Date.now() - startedAt, engine: this.name };
  }

  private async ensureServer(): Promise<boolean> {
    if (this.serverReady) return this.serverReady;
    this.serverReady = this.startServer().catch((error) => {
      this.log(`whisper-server start failed: ${error instanceof Error ? error.message : String(error)}`);
      this.serverFailures += 1;
      this.server = null;
      this.serverReady = null;
      return false;
    });
    return this.serverReady;
  }

  private async startServer(): Promise<boolean> {
    const serverPath = this.options.serverPath;
    if (!serverPath) return false;
    const port = await findFreePort();
    const args = [
      '-m', this.options.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-t', String(this.threads),
      '-bo', '2',
      '-bs', '5',
      '-nf',
      '-sns',
      '-nt',
      '-l', 'auto',
    ];
    const child = spawn(serverPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.server = child;
    this.serverPort = port;
    child.stderr?.on('data', () => undefined);
    child.stdout?.on('data', () => undefined);
    child.on('exit', (code, signal) => {
      if (this.server === child) {
        this.log(`whisper-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        this.server = null;
        this.serverReady = null;
      }
    });

    const deadline = Date.now() + (this.options.serverStartTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`whisper-server exited early (code=${child.exitCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
        // Any HTTP answer (even 404) means the model finished loading and the listener is up.
        if (response.status > 0) return true;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('whisper-server did not start in time');
  }

  private async transcribeViaServer(wav: Buffer, language: string): Promise<string> {
    const ready = await this.ensureServer();
    if (!ready || !this.server) throw new Error('whisper-server unavailable');
    const form = new FormData();
    const wavBytes = new Uint8Array(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer);
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'segment.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('no_timestamps', 'true');
    form.append('suppress_non_speech', 'true');
    if (language !== 'auto') form.append('language', language);
    const response = await fetch(`http://127.0.0.1:${this.serverPort}/inference`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(`whisper-server HTTP ${response.status}`);
    const payload = (await response.json()) as { text?: string; error?: string };
    if (payload.error) throw new Error(payload.error);
    return (payload.text ?? '').replace(/\s+/g, ' ').trim();
  }

  private async transcribeViaCli(wav: Buffer, language: string): Promise<string> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-whisper-'));
    const wavPath = path.join(tmpDir, 'segment.wav');
    fs.writeFileSync(wavPath, wav);
    try {
      const args = ['-m', this.options.modelPath, '-f', wavPath, '-t', String(this.threads), ...WHISPER_DECODE_ARGS];
      if (language !== 'auto') args.push('-l', language);
      const result = spawnSync(this.options.cliPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) {
        throw new Error(`whisper-cli exited with ${result.status}: ${(result.stderr ?? '').split('\n').slice(-3).join(' ')}`);
      }
      return parseWhisperCliText(result.stdout ?? '');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
