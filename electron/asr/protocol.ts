/**
 * Wire protocol shared by the main process and `tools/macos-asr-helper` (Swift).
 * Pure module: no Electron imports, so scripts can transpile and reuse it.
 *
 * stdin  (main → helper): binary frames `OWAS | u32le headerLen | header JSON | u32le payloadLen | payload`
 * stdout (helper → main): NDJSON, one event per line.
 */

export type AsrSource = 'mic' | 'system';
export type AsrRequestKind = 'preview' | 'final';
export type AsrLanguageCode = 'es' | 'en' | 'auto';

export const FRAME_MAGIC = Buffer.from('OWAS', 'ascii');
export const HELPER_SAMPLE_RATE = 16_000;

export interface TranscribeFrameHeader {
  type: 'transcribe';
  requestId: string;
  sessionId: string;
  generation: number;
  source: AsrSource;
  segmentId: string;
  kind: AsrRequestKind;
  sampleRate: number;
  channels: 1;
  startMs: number;
  endMs: number;
  language?: AsrLanguageCode;
}

export interface CancelFrameHeader {
  type: 'cancel';
  requestIds?: string[];
  sessionId?: string;
  previewsOnly?: boolean;
}

export interface PingFrameHeader {
  type: 'ping';
}

export interface ShutdownFrameHeader {
  type: 'shutdown';
}

export type HelperFrameHeader = TranscribeFrameHeader | CancelFrameHeader | PingFrameHeader | ShutdownFrameHeader;

export interface HelperReadyEvent {
  type: 'ready';
  engine: string;
  helperVersion: string;
  modelDir: string;
  loadMs: number;
  warmupMs: number;
  sampleRate: number;
}

export interface HelperProgressEvent {
  type: 'progress';
  stage: 'download' | 'load';
  fraction: number;
  phase?: string;
}

export interface HelperResultEvent {
  type: 'result';
  requestId: string;
  sessionId: string;
  generation: number;
  source: AsrSource;
  segmentId: string;
  kind: AsrRequestKind;
  text: string;
  confidence: number;
  startMs: number;
  endMs: number;
  audioMs: number;
  queueMs: number;
  processingMs: number;
  engine: string;
}

export interface HelperErrorEvent {
  type: 'error';
  requestId: string;
  sessionId: string;
  generation: number;
  source: AsrSource;
  segmentId: string;
  kind: AsrRequestKind;
  message: string;
}

export interface HelperDroppedEvent {
  type: 'dropped';
  requestId: string;
  reason: 'superseded' | 'cancelled';
}

export interface HelperLogEvent {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface HelperFatalEvent {
  type: 'fatal';
  message: string;
}

export interface HelperPongEvent {
  type: 'pong';
  at: number;
}

export interface HelperClosedEvent {
  type: 'closed';
}

export interface HelperCheckEvent {
  type: 'check';
  ok: boolean;
  modelsPresent: boolean;
  modelDir: string;
  engine: string;
  helperVersion: string;
}

export type HelperEvent =
  | HelperReadyEvent
  | HelperProgressEvent
  | HelperResultEvent
  | HelperErrorEvent
  | HelperDroppedEvent
  | HelperLogEvent
  | HelperFatalEvent
  | HelperPongEvent
  | HelperClosedEvent
  | HelperCheckEvent;

/** Encodes one frame. `payload` is float32 little-endian mono PCM for `transcribe`, empty otherwise. */
export function encodeFrame(header: HelperFrameHeader, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const frame = Buffer.alloc(4 + 4 + headerBytes.length + 4 + payload.byteLength);
  let offset = 0;
  FRAME_MAGIC.copy(frame, offset);
  offset += 4;
  frame.writeUInt32LE(headerBytes.length, offset);
  offset += 4;
  headerBytes.copy(frame, offset);
  offset += headerBytes.length;
  frame.writeUInt32LE(payload.byteLength, offset);
  offset += 4;
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, offset);
  return frame;
}

export function float32ToBytes(samples: Float32Array): Uint8Array {
  // Float32Array is little-endian on every platform Electron ships for (x64/arm64).
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Incremental NDJSON parser for helper stdout. */
export class NdjsonParser<T = HelperEvent> {
  private buffer = '';

  push(chunk: Buffer | string): T[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const events: T[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          events.push(JSON.parse(line) as T);
        } catch {
          // Non-JSON noise on stdout (should not happen; helper logs go through NDJSON too).
        }
      }
      newline = this.buffer.indexOf('\n');
    }
    return events;
  }

  reset(): void {
    this.buffer = '';
  }
}
