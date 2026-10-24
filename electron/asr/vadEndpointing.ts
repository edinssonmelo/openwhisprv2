/**
 * RMS + dynamic noise-floor voice activity detection with endpointing (main-process copy).
 * Pure module: no Electron/Node imports. Interface is intentionally narrow so a Silero/WebRTC
 * detector can replace internals later.
 */

export interface VadConfig {
  /** Not enforced on frame boundaries; input chunk size comes from Web Audio (e.g. 4096). */
  frameMs: number;
  preRollMs: number;
  silenceToCloseMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
  hangoverMs: number;
  /** Absolute RMS floor below which we never declare speech. */
  minRms: number;
  /** Speech if RMS >= noiseFloor * noiseMultiplier (and above minRms). */
  noiseMultiplier: number;
  /** Extra audio appended after silence threshold (tail capture). */
  postRollMs: number;
  /** Peak hint for noisy environments (normalized float sample). */
  peakSpeechHint: number;
  /** If segment would be shorter than minSpeechMs, keep only if clearly energetic. */
  minClearRms: number;
  minClearPeak: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  frameMs: 30,
  preRollMs: 500,
  silenceToCloseMs: 900,
  minSpeechMs: 800,
  maxSegmentMs: 25_000,
  hangoverMs: 300,
  minRms: 0.008,
  noiseMultiplier: 2.8,
  postRollMs: 700,
  peakSpeechHint: 0.02,
  minClearRms: 0.028,
  minClearPeak: 0.05,
};

export interface VadClosedSegment {
  startSample: number;
  endSample: number;
  startMs: number;
  endMs: number;
  samples: Float32Array;
  rms: number;
  peak: number;
  durationMs: number;
  /** Milliseconds of frames classified as speech (excludes pre-roll and trailing silence). */
  speechMs: number;
}

export interface VadFrameResult {
  closed: VadClosedSegment[];
}

interface PreRollChunk {
  startSample: number;
  data: Float32Array;
}

interface SegmentChunk {
  startSample: number;
  data: Float32Array;
}

type VadInternalState = 'idle' | 'in_speech' | 'post_roll';

function measureFrame(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    sum += s * s;
    peak = Math.max(peak, Math.abs(s));
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

function concatChunks(chunks: SegmentChunk[], sampleRate: number): VadClosedSegment | null {
  if (chunks.length === 0) return null;
  const startSample = chunks[0].startSample;
  let total = 0;
  for (const c of chunks) total += c.data.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c.data, offset);
    offset += c.data.length;
  }
  const endSample = startSample + out.length;
  const { rms, peak } = measureFrame(out);
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
    speechMs: 0,
  };
}

export class VadEndpointing {
  private cfg: VadConfig;
  private state: VadInternalState = 'idle';
  private noiseFloor = 0.012;
  private preRoll: PreRollChunk[] = [];
  private preRollSamples = 0;
  private segmentChunks: SegmentChunk[] = [];
  private segmentSpeechMs = 0;
  private quietMs = 0;
  private postRollMsLeft = 0;

  constructor(config: Partial<VadConfig> = {}) {
    this.cfg = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  reset(): void {
    this.state = 'idle';
    this.noiseFloor = 0.012;
    this.preRoll = [];
    this.preRollSamples = 0;
    this.segmentChunks = [];
    this.segmentSpeechMs = 0;
    this.quietMs = 0;
    this.postRollMsLeft = 0;
  }

  getConfig(): VadConfig {
    return { ...this.cfg };
  }

  /** True while a segment is being collected (speech or trailing/post-roll). */
  isSegmentOpen(): boolean {
    return this.state !== 'idle';
  }

  /**
   * Linear PCM mono float32 [-1,1]. `frameStartSample` is the global sample index of the first sample in this frame.
   */
  pushFrame(samples: Float32Array, sampleRate: number, frameStartSample: number): VadFrameResult {
    const frameMs = (samples.length / sampleRate) * 1000;
    const { rms, peak } = measureFrame(samples);
    const closed: VadClosedSegment[] = [];

    if (this.state === 'idle') {
      this.noiseFloor = 0.96 * this.noiseFloor + 0.04 * rms;
    }

    const threshold = Math.max(this.cfg.minRms, this.noiseFloor * this.cfg.noiseMultiplier);
    const isSpeech = rms >= threshold || peak >= this.cfg.peakSpeechHint;

    const frameEndSample = frameStartSample + samples.length;

    if (this.state === 'idle') {
      this.pushPreRoll(samples, frameStartSample);
      this.trimPreRoll(sampleRate);
      if (isSpeech) {
        // Pre-roll already includes this frame; do not append twice.
        this.beginSegmentFromPreRollOnly(sampleRate);
        this.clearPreRoll();
      }
      return { closed };
    }

    if (this.state === 'in_speech') {
      this.appendToSegment(samples, frameStartSample);
      if (isSpeech) {
        this.segmentSpeechMs += frameMs;
        this.quietMs = 0;
        if (this.segmentSpeechMs >= this.cfg.maxSegmentMs) {
          const seg = this.finalizeSegment(sampleRate);
          if (seg) closed.push(seg);
          this.resetToIdle();
        }
      } else {
        this.quietMs += frameMs;
        const effectiveSilence = Math.max(0, this.quietMs - this.cfg.hangoverMs);
        if (effectiveSilence >= this.cfg.silenceToCloseMs) {
          this.state = 'post_roll';
          this.postRollMsLeft = this.cfg.postRollMs;
          this.quietMs = 0;
        }
      }
      return { closed };
    }

    // post_roll
    this.appendToSegment(samples, frameStartSample);
    if (isSpeech) {
      this.state = 'in_speech';
      this.quietMs = 0;
      return { closed };
    }
    this.postRollMsLeft -= frameMs;
    if (this.postRollMsLeft <= 0) {
      const seg = this.finalizeSegment(sampleRate);
      if (seg) closed.push(seg);
      this.resetToIdle();
      return { closed };
    }
    return { closed };
  }

  /** Snapshot of the current open segment for live preview (may be large). */
  getOpenSegmentSnapshot(sampleRate: number): VadClosedSegment | null {
    if (this.state === 'idle' || this.segmentChunks.length === 0) return null;
    const snapshot = concatChunks(this.segmentChunks, sampleRate);
    if (snapshot) snapshot.speechMs = this.segmentSpeechMs;
    return snapshot;
  }

  /**
   * Closes the open segment immediately (session stop / source removed). Returns the raw audio even if
   * it is shorter than `minSpeechMs`; the caller decides whether it is worth transcribing.
   */
  closeOpenSegment(sampleRate: number): VadClosedSegment | null {
    if (this.state === 'idle' || this.segmentChunks.length === 0) {
      this.resetToIdle();
      return null;
    }
    const raw = concatChunks(this.segmentChunks, sampleRate);
    if (raw) raw.speechMs = this.segmentSpeechMs;
    this.resetToIdle();
    return raw && raw.samples.length > 0 ? raw : null;
  }

  private pushPreRoll(data: Float32Array, frameStartSample: number): void {
    this.preRoll.push({ startSample: frameStartSample, data });
    this.preRollSamples += data.length;
  }

  private trimPreRoll(sampleRate: number): void {
    const maxSamples = Math.ceil((this.cfg.preRollMs / 1000) * sampleRate);
    while (this.preRoll.length > 0 && this.preRollSamples > maxSamples) {
      const first = this.preRoll[0];
      const over = this.preRollSamples - maxSamples;
      if (first.data.length <= over) {
        this.preRollSamples -= first.data.length;
        this.preRoll.shift();
      } else {
        const drop = over;
        this.preRoll[0] = {
          startSample: first.startSample + drop,
          data: first.data.subarray(drop),
        };
        this.preRollSamples -= drop;
      }
    }
  }

  private clearPreRoll(): void {
    this.preRoll = [];
    this.preRollSamples = 0;
  }

  private beginSegmentFromPreRollOnly(sampleRate: number): void {
    this.state = 'in_speech';
    this.quietMs = 0;
    this.segmentChunks = [];
    for (const chunk of this.preRoll) {
      this.segmentChunks.push({ startSample: chunk.startSample, data: chunk.data });
    }
    // Only the triggering frame (last pre-roll chunk) is speech; the rest of the pre-roll is context.
    const trigger = this.preRoll[this.preRoll.length - 1];
    this.segmentSpeechMs = trigger ? (trigger.data.length / sampleRate) * 1000 : 0;
  }

  private appendToSegment(samples: Float32Array, frameStartSample: number): void {
    this.segmentChunks.push({ startSample: frameStartSample, data: samples });
  }

  private finalizeSegment(sampleRate: number): VadClosedSegment | null {
    const raw = concatChunks(this.segmentChunks, sampleRate);
    if (!raw || raw.samples.length === 0) return null;
    raw.speechMs = this.segmentSpeechMs;

    if (raw.speechMs < this.cfg.minSpeechMs) {
      const energetic = raw.rms >= this.cfg.minClearRms || raw.peak >= this.cfg.minClearPeak;
      if (!energetic) return null;
    }

    return raw;
  }

  private resetToIdle(): void {
    this.state = 'idle';
    this.segmentChunks = [];
    this.segmentSpeechMs = 0;
    this.quietMs = 0;
    this.postRollMsLeft = 0;
  }
}

export function createVadEndpointing(config?: Partial<VadConfig>): VadEndpointing {
  return new VadEndpointing(config);
}
