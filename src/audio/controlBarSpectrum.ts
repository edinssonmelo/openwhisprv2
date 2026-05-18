/** Bars in the session top bar mini spectrum (must match TopControlBar markup). */
export const CONTROL_BAR_WAVEFORM_BARS = 24;

/**
 * Downsample FFT magnitude into `smoothed` bars (in-place), tied to live capture audio.
 */
export function fillControlBarSpectrumFromAnalyser(analyser: AnalyserNode, smoothed: Float32Array): void {
  if (smoothed.length !== CONTROL_BAR_WAVEFORM_BARS) return;
  const binCount = analyser.frequencyBinCount;
  const data = new Uint8Array(binCount);
  analyser.getByteFrequencyData(data);
  const n = CONTROL_BAR_WAVEFORM_BARS;
  const alpha = 0.5;
  for (let i = 0; i < n; i += 1) {
    const lo = Math.floor((i / n) * binCount);
    const hi = i === n - 1 ? binCount : Math.floor(((i + 1) / n) * binCount);
    const loClamped = Math.min(binCount - 1, Math.max(0, lo));
    const hiClamped = Math.max(loClamped + 1, Math.min(binCount, hi));
    let sum = 0;
    for (let j = loClamped; j < hiClamped; j += 1) sum += data[j];
    const raw = sum / (hiClamped - loClamped) / 255;
    const shaped = Math.min(1, raw ** 0.5 * 2.85);
    smoothed[i] = smoothed[i] * (1 - alpha) + shaped * alpha;
  }
}
