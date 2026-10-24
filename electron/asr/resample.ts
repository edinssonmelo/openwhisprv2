/**
 * Small, dependency-free PCM helpers used by the main-process ASR session.
 * Quality target is ASR input (16 kHz mono), not playback.
 */

export const ASR_SAMPLE_RATE = 16_000;

/** Interleaved multi-channel float32 → mono (average). */
export function interleavedToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const mono = new Float32Array(frames);
  const scale = 1 / channels;
  for (let frame = 0, index = 0; frame < frames; frame += 1, index += channels) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += samples[index + channel];
    mono[frame] = sum * scale;
  }
  return mono;
}

/**
 * Stateless resampler with a box-filter anti-alias stage for integer down-sampling ratios (48k→16k, 32k→16k)
 * and linear interpolation otherwise (44.1k→16k). Chunks are small (≤ a few hundred ms), so ignoring
 * inter-chunk phase continuity costs far less than an ASR word error would.
 */
export function resampleToAsrRate(samples: Float32Array, inputRate: number): Float32Array {
  if (inputRate === ASR_SAMPLE_RATE || samples.length === 0) return samples;
  const ratio = inputRate / ASR_SAMPLE_RATE;
  if (Number.isInteger(ratio) && ratio > 1) {
    const outLength = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLength);
    const scale = 1 / ratio;
    for (let outIndex = 0, inIndex = 0; outIndex < outLength; outIndex += 1, inIndex += ratio) {
      let sum = 0;
      for (let tap = 0; tap < ratio; tap += 1) sum += samples[inIndex + tap];
      out[outIndex] = sum * scale;
    }
    return out;
  }
  // Non-integer ratio: pre-average `floor(ratio)` taps to tame aliasing, then interpolate linearly.
  const taps = Math.max(1, Math.floor(ratio));
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  const lastIndex = samples.length - 1;
  for (let outIndex = 0; outIndex < outLength; outIndex += 1) {
    const position = outIndex * ratio;
    const base = Math.floor(position);
    const fraction = position - base;
    let left = 0;
    let right = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      left += samples[Math.min(lastIndex, base + tap)];
      right += samples[Math.min(lastIndex, base + tap + 1)];
    }
    left /= taps;
    right /= taps;
    out[outIndex] = left * (1 - fraction) + right * fraction;
  }
  return out;
}

export function measurePcm(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    sum += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 16-bit PCM mono WAV encoder (whisper.cpp input). */
export function encodeWavPcm16Mono(samples: Float32Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), 44 + index * 2);
  }
  return buffer;
}

/** Minimal 16-bit PCM WAV reader (fixtures and tests). Returns mono float32 at the file's sample rate. */
export function decodeWavPcm16(buffer: Buffer): { sampleRate: number; channels: number; samples: Float32Array } | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataOffset = buffer.indexOf('data', 36, 'ascii');
  if (bitsPerSample !== 16 || dataOffset < 0) return null;
  const dataSize = Math.min(buffer.readUInt32LE(dataOffset + 4), buffer.length - dataOffset - 8);
  const start = dataOffset + 8;
  const frameCount = Math.floor(dataSize / 2 / channels);
  const samples = new Float32Array(frameCount);
  const scale = 1 / channels / 32768;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += buffer.readInt16LE(start + (frame * channels + channel) * 2);
    }
    samples[frame] = sum * scale;
  }
  return { sampleRate, channels, samples };
}
