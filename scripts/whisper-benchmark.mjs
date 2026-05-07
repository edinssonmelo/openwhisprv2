import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const whisperRoot = path.join(root, '.local', 'whisper.cpp');
const cliPath = process.platform === 'win32'
  ? path.join(whisperRoot, 'build', 'bin', 'Release', 'whisper-cli.exe')
  : path.join(whisperRoot, 'build', 'bin', 'whisper-cli');
const modelsDir = path.join(root, '.local', 'models');
const audioPath = process.argv[2] ?? findBenchmarkAudio();

const MINIMAL_TRANSCRIPTION_PROMPT = 'Transcripcion literal de una conversacion. No resumir.';
const PROMPT_VARIANTS = [
  { key: 'empty', prompt: '' },
  { key: 'minimal', prompt: MINIMAL_TRANSCRIPTION_PROMPT },
];
const whisperPeakTarget = 0.92;
const VAD_CFG = {
  frameSize: 1024,
  preRollMs: 500,
  silenceToCloseMs: 900,
  minSpeechMs: 800,
  maxSegmentMs: 25000,
  hangoverMs: 300,
  postRollMs: 700,
  minRms: 0.008,
  noiseMultiplier: 2.8,
  peakSpeechHint: 0.02,
  minClearRms: 0.028,
  minClearPeak: 0.05,
};

const MODEL_CANDIDATES = ['large-v3-turbo', 'large-v3'];

if (!audioPath) {
  console.error('No WAV. Pass: npm run whisper:benchmark -- /path/to/file.wav');
  process.exit(1);
}

if (!fs.existsSync(cliPath)) {
  console.error(`Missing whisper-cli. Run npm run whisper:setup. Expected: ${cliPath}`);
  process.exit(1);
}

const durationSec = readWavDurationSec(audioPath);
if (!durationSec) {
  console.error(`Could not read WAV duration: ${audioPath}`);
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const benchmarkRoot = path.join(root, 'recordings', 'benchmarks');
const runDir = path.join(benchmarkRoot, runId);
fs.mkdirSync(runDir, { recursive: true });

const modelsFound = MODEL_CANDIDATES.map((name) => ({
  name,
  path: path.join(modelsDir, `ggml-${name}.bin`),
})).filter((m) => fs.existsSync(m.path));

if (modelsFound.length === 0) {
  console.error(`No ggml-large-v3-turbo.bin or ggml-large-v3.bin under ${modelsDir}`);
  process.exit(1);
}

const wav = readPcm16Wav(audioPath);
if (!wav) {
  console.error('Benchmark requires mono/stereo 16-bit PCM WAV.');
  process.exit(1);
}

const floatMono = int16ToFloatMono(wav.samples, wav.channels);
const metricsFull = measureFloat(floatMono);

console.log(`Benchmark audio: ${audioPath}`);
console.log(`Duration: ${durationSec.toFixed(2)}s`);
console.log(`Output: ${runDir}`);
console.log(`Models: ${modelsFound.map((m) => m.name).join(', ')}`);

const metadata = {
  runId,
  createdAt: new Date().toISOString(),
  audioPath,
  durationSec,
  fullAudio: { rms: metricsFull.rms, peak: metricsFull.peak, clipping: metricsFull.clippingCount },
  models: [],
  streaming: null,
  streamingVariants: [],
};

let streamingTextForFile = '';

for (const { name: modelName, path: modelPath } of modelsFound) {
  const modelMeta = {
    model: modelName,
    fullEs: null,
    fullAuto: null,
    vadEs: null,
    vadAuto: null,
    fullVariants: [],
    vadVariants: [],
  };

  for (const language of ['es', 'auto']) {
    for (const promptVariant of PROMPT_VARIANTS) {
      const legacyEmpty = promptVariant.key === 'empty';
      const key = language === 'es' ? 'fullEs' : 'fullAuto';
      const fileLabel = legacyEmpty
        ? `full-audio-${modelName}-${language}.txt`
        : `full-audio-${modelName}-${language}-${promptVariant.key}.txt`;
      const outPath = path.join(runDir, fileLabel);
      const { text, latencySec, exitCode, stderrTail, args, clippingEvents } = runWhisperFull({
        cliPath,
        modelPath,
        wavPath: audioPath,
        language,
        prompt: promptVariant.prompt,
      });
      fs.writeFileSync(outPath, text, 'utf8');
      const entry = {
        file: fileLabel,
        language,
        promptMode: promptVariant.key,
        latencySec,
        exitCode,
        wordCount: countWords(text),
        stderrTail,
        args,
        clippingEvents,
      };
      modelMeta.fullVariants.push(entry);
      if (legacyEmpty) modelMeta[key] = entry;
    }
  }

  const vadSegments = vadSegmentFloat(floatMono, wav.sampleRate);
  for (const language of ['es', 'auto']) {
    for (const promptVariant of PROMPT_VARIANTS) {
      const legacyEmpty = promptVariant.key === 'empty';
      const key = language === 'es' ? 'vadEs' : 'vadAuto';
      const fileLabel = legacyEmpty
        ? `vad-segments-${modelName}-${language}.txt`
        : `vad-segments-${modelName}-${language}-${promptVariant.key}.txt`;
      const outPath = path.join(runDir, fileLabel);
      const tempDir = path.join(runDir, `.tmp-vad-${modelName}-${language}-${promptVariant.key}`);
      fs.mkdirSync(tempDir, { recursive: true });
      let combined = '';
      let totalLatency = 0;
      let clippingEvents = 0;
      let i = 0;
      for (const seg of vadSegments) {
        const norm = normalizeForWhisper(seg.samples, seg.peak);
        clippingEvents += norm.usedGain ? 1 : 0;
        const segPath = path.join(tempDir, `seg-${String(i).padStart(4, '0')}.wav`);
        fs.writeFileSync(segPath, encodePcm16MonoWavFromFloat(norm.samples, wav.sampleRate));
        const r = runWhisperFull({
          cliPath,
          modelPath,
          wavPath: segPath,
          language,
          prompt: promptVariant.prompt,
        });
        totalLatency += r.latencySec;
        if (r.exitCode === 0 && r.text) {
          combined = [combined, r.text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        }
        i += 1;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.writeFileSync(outPath, combined, 'utf8');
      const entry = {
        file: fileLabel,
        language,
        promptMode: promptVariant.key,
        segmentCount: vadSegments.length,
        averageSegmentDurationMs: vadSegments.length
          ? vadSegments.reduce((a, s) => a + s.durationMs, 0) / vadSegments.length
          : 0,
        sumLatencySec: totalLatency,
        wordCount: countWords(combined),
        clippingEvents,
      };
      modelMeta.vadVariants.push(entry);
      if (legacyEmpty) modelMeta[key] = entry;
    }
  }

  metadata.models.push(modelMeta);
}

// Current streaming simulation (accumulated buffer + local agreement) — turbo only if available
const turbo = modelsFound.find((m) => m.name === 'large-v3-turbo');
if (turbo && wav) {
  for (const language of ['es', 'auto']) {
    for (const promptVariant of PROMPT_VARIANTS) {
      const streaming = runStreamingLocalAgreement({
        cliPath,
        modelPath: turbo.path,
        audioPath,
        runDir,
        language,
        prompt: promptVariant.prompt,
        promptMode: promptVariant.key,
      });
      const legacyEmptyEs = language === 'es' && promptVariant.key === 'empty';
      const fileLabel = legacyEmptyEs
        ? 'current-streaming-output.txt'
        : `current-streaming-output-${language}-${promptVariant.key}.txt`;
      fs.writeFileSync(path.join(runDir, fileLabel), streaming.finalText || '(streaming not run)', 'utf8');
      const entry = { ...streaming.meta, file: fileLabel, language, promptMode: promptVariant.key };
      metadata.streamingVariants.push(entry);
      if (legacyEmptyEs) {
        metadata.streaming = entry;
        streamingTextForFile = streaming.finalText;
      }
    }
  }
}

const streamingPath = path.join(runDir, 'current-streaming-output.txt');
fs.writeFileSync(streamingPath, streamingTextForFile || '(streaming not run)', 'utf8');

metadata.benchmarkFiles = fs.readdirSync(runDir).filter((f) => !f.startsWith('.'));
fs.writeFileSync(path.join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

console.log(`Wrote ${runDir}`);
console.log(`- metadata.json`);
for (const f of metadata.benchmarkFiles) {
  if (f.endsWith('.txt')) console.log(`- ${f}`);
}

// ——— helpers ———

function findBenchmarkAudio() {
  const recordingsDir = path.join(root, 'recordings');
  if (!fs.existsSync(recordingsDir)) return null;
  const candidates = fs.readdirSync(recordingsDir)
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .map((name) => path.join(recordingsDir, name))
    .filter((filePath) => fs.statSync(filePath).size > 44)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function readWavDurationSec(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataSize = buffer.readUInt32LE(40);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return bytesPerSecond > 0 ? dataSize / bytesPerSecond : null;
}

function readPcm16Wav(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataOffset = buffer.indexOf('data', 36, 'ascii');
  if (bitsPerSample !== 16 || dataOffset < 0) return null;
  const dataSize = buffer.readUInt32LE(dataOffset + 4);
  const start = dataOffset + 8;
  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = buffer.readInt16LE(start + index * 2);
  }
  return { channels, sampleRate, samples };
}

function int16ToFloatMono(int16, channels) {
  const mono = new Float32Array(int16.length / channels);
  for (let i = 0, j = 0; j < mono.length; i += channels, j += 1) {
    mono[j] = int16[i] / 32768;
  }
  return mono;
}

function measureFloat(samples) {
  if (samples.length === 0) return { rms: 0, peak: 0, clippingCount: 0 };
  let sum = 0;
  let peak = 0;
  let clippingCount = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    sum += s * s;
    const a = Math.abs(s);
    peak = Math.max(peak, a);
    if (a >= 0.98) clippingCount += 1;
  }
  return {
    rms: Math.sqrt(sum / samples.length),
    peak,
    clippingCount,
  };
}

function measureFloatSlice(samples, offset, length) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const s = samples[offset + i];
    sum += s * s;
    peak = Math.max(peak, Math.abs(s));
  }
  return { rms: Math.sqrt(sum / length), peak };
}

/**
 * Returns closed speech segments (aligned with src/audio/vadEndpointing.ts intent).
 */
function vadSegmentFloat(full, sampleRate) {
  /** @type {{ startSample: number, endSample: number, samples: Float32Array, rms: number, peak: number, durationMs: number }[]} */
  const segments = [];
  let state = 'idle';
  let noiseFloor = 0.012;
  /** @type {{ off: number, len: number }[]} */
  const preRoll = [];
  let preRollSamples = 0;
  /** @type {{ off: number, len: number }[]} */
  let segmentChunks = [];
  let segmentSpeechMs = 0;
  let quietMs = 0;
  let postRollMsLeft = 0;
  const maxPreSamples = Math.ceil((VAD_CFG.preRollMs / 1000) * sampleRate);
  const fsz = VAD_CFG.frameSize;

  function trimPre() {
    while (preRoll.length > 0 && preRollSamples > maxPreSamples) {
      const first = preRoll[0];
      const over = preRollSamples - maxPreSamples;
      if (first.len <= over) {
        preRollSamples -= first.len;
        preRoll.shift();
      } else {
        first.off += over;
        first.len -= over;
        preRollSamples -= over;
      }
    }
  }

  function clearPre() {
    preRoll.length = 0;
    preRollSamples = 0;
  }

  function finalizeSegment() {
    if (segmentChunks.length === 0) return;
    let total = 0;
    for (const c of segmentChunks) total += c.len;
    const out = new Float32Array(total);
    let o = 0;
    const startSample = segmentChunks[0].off;
    for (const c of segmentChunks) {
      out.set(full.subarray(c.off, c.off + c.len), o);
      o += c.len;
    }
    const m = measureFloat(out);
    const durationMs = (out.length / sampleRate) * 1000;
    if (durationMs < VAD_CFG.minSpeechMs && m.rms < VAD_CFG.minClearRms && m.peak < VAD_CFG.minClearPeak) {
      return;
    }
    segments.push({
      startSample,
      endSample: startSample + out.length,
      samples: out,
      rms: m.rms,
      peak: m.peak,
      durationMs,
    });
  }

  function resetIdle() {
    state = 'idle';
    segmentChunks = [];
    segmentSpeechMs = 0;
    quietMs = 0;
    postRollMsLeft = 0;
  }

  function pushPre(off, len) {
    preRoll.push({ off, len });
    preRollSamples += len;
    trimPre();
  }

  for (let start = 0; start + fsz <= full.length; start += fsz) {
    const { rms, peak } = measureFloatSlice(full, start, fsz);
    const frameMs = (fsz / sampleRate) * 1000;
    if (state === 'idle') noiseFloor = 0.96 * noiseFloor + 0.04 * rms;
    const threshold = Math.max(VAD_CFG.minRms, noiseFloor * VAD_CFG.noiseMultiplier);
    const isSpeech = rms >= threshold || peak >= VAD_CFG.peakSpeechHint;

    if (state === 'idle') {
      pushPre(start, fsz);
      if (isSpeech) {
        state = 'in_speech';
        segmentChunks = [];
        segmentSpeechMs = 0;
        quietMs = 0;
        for (const c of preRoll) segmentChunks.push({ off: c.off, len: c.len });
        segmentChunks.push({ off: start, len: fsz });
        segmentSpeechMs += frameMs;
        clearPre();
      }
      continue;
    }
    if (state === 'in_speech') {
      segmentChunks.push({ off: start, len: fsz });
      if (isSpeech) {
        segmentSpeechMs += frameMs;
        quietMs = 0;
        if (segmentSpeechMs >= VAD_CFG.maxSegmentMs) {
          finalizeSegment();
          resetIdle();
        }
      } else {
        quietMs += frameMs;
        const effectiveSilence = Math.max(0, quietMs - VAD_CFG.hangoverMs);
        if (effectiveSilence >= VAD_CFG.silenceToCloseMs) {
          state = 'post_roll';
          postRollMsLeft = VAD_CFG.postRollMs;
          quietMs = 0;
        }
      }
      continue;
    }
    // post_roll
    segmentChunks.push({ off: start, len: fsz });
    if (isSpeech) {
      state = 'in_speech';
      quietMs = 0;
      continue;
    }
    postRollMsLeft -= frameMs;
    if (postRollMsLeft <= 0) {
      finalizeSegment();
      resetIdle();
    }
  }

  return segments;
}

function normalizeForWhisper(samples, peak) {
  const gain = peak > whisperPeakTarget ? whisperPeakTarget / peak : 1;
  if (gain === 1) return { samples, usedGain: false };
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return { samples: out, usedGain: true };
}

function encodePcm16MonoWavFromFloat(floatSamples, sampleRate) {
  const int16 = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return encodePcm16Wav(int16, sampleRate, 1);
}

function encodePcm16Wav(samples, sampleRate, channels) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }
  return buffer;
}

function buildWhisperArgs({ modelPath, wavPath, language, prompt }) {
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '--no-timestamps',
    '-sns',
    '-t', '8',
    '-bo', '2',
    '-bs', '5',
    '-tp', '0',
    '-nf',
    '-np',
  ];
  if (language === 'es') args.push('-l', 'es');
  if (prompt) args.push('--prompt', prompt);
  return args;
}

function runWhisperFull({ cliPath: cli, modelPath, wavPath, language, prompt }) {
  const args = buildWhisperArgs({ modelPath, wavPath, language, prompt });
  const buf = fs.readFileSync(wavPath);
  const pcm = readPcm16WavFromBuffer(buf);
  let clippingEvents = 0;
  if (pcm) {
    const f = int16ToFloatMono(pcm.samples, pcm.channels);
    const m = measureFloat(f);
    clippingEvents = m.clippingCount > 0 ? 1 : 0;
  }
  const startedAt = performance.now();
  const result = spawnSync(cli, args, { encoding: 'utf8' });
  const latencySec = (performance.now() - startedAt) / 1000;
  return {
    text: parseWhisperText(result.stdout ?? ''),
    latencySec,
    exitCode: result.status,
    stderrTail: summarizeStderr(result.stderr ?? ''),
    args,
    clippingEvents,
  };
}

function readPcm16WavFromBuffer(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataOffset = buffer.indexOf('data', 36, 'ascii');
  if (bitsPerSample !== 16 || dataOffset < 0) return null;
  const dataSize = buffer.readUInt32LE(dataOffset + 4);
  const start = dataOffset + 8;
  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = buffer.readInt16LE(start + index * 2);
  }
  return { channels, sampleRate, samples };
}

function runStreamingLocalAgreement({ cliPath: cli, modelPath, audioPath: pathToWav, runDir: _runDir, language, prompt, promptMode }) {
  const wavFile = readPcm16Wav(pathToWav);
  if (!wavFile) {
    return { finalText: '', meta: { ok: false, error: 'PCM 16-bit required' } };
  }
  const advanceSec = 3;
  const minFirstWindowSec = 3;
  const coldStartSec = 12;
  const rightEdgeGuardSec = 2.5;
  const confirmedAudioRetainSec = 2;
  const durationSecLocal = wavFile.samples.length / wavFile.channels / wavFile.sampleRate;
  const tempDir = path.join(_runDir, `.tmp-stream-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  let bufferStartSec = 0;
  let committedWords = [];
  let unstableWords = [];
  const hypotheses = [];
  let previousWords = [];
  let previousText = '';
  let repeatedShortKey = '';
  let repeatedShortCount = 0;

  const config = { language, prompt };

  for (let endSec = minFirstWindowSec; endSec <= durationSecLocal + 0.25; endSec += advanceSec) {
    const startSec = bufferStartSec;
    const actualEndSec = Math.min(durationSecLocal, endSec);
    const slice = sliceWav(wavFile, startSec, actualEndSec);
    if (!slice.samples.length) continue;
    const chunkPath = path.join(tempDir, `c-${hypotheses.length}.wav`);
    const metrics = measureInt16(slice.samples);
    const { samples: whisperSamples, gain } = normalizeInt16ForWhisper(slice.samples, metrics.peak);
    fs.writeFileSync(chunkPath, encodePcm16Wav(whisperSamples, wavFile.sampleRate, wavFile.channels));
    const result = runWhisperFull({ cliPath: cli, modelPath, wavPath: chunkPath, language: config.language, prompt: config.prompt });
    const text = result.text;
    const words = tokenize(text);
    const currentKey = normalizeText(text);
    repeatedShortCount = currentKey && currentKey === repeatedShortKey ? (repeatedShortCount + 1) : 1;
    repeatedShortKey = currentKey;

    if (actualEndSec < coldStartSec) {
      previousWords = words;
      previousText = text;
      unstableWords = words.slice(-40);
      hypotheses.push({ text, rejected: 'cold-start' });
      continue;
    }

    const agreementLength = Math.max(commonPrefixLength(previousWords, words), suffixPrefixOverlap(previousWords, words));
    const confirmableAgreementLength = trimRightEdgeAgreement(words, agreementLength, startSec, actualEndSec, rightEdgeGuardSec);
    const hasAgreement = confirmableAgreementLength >= 2;
    const rejectReason = getStreamingRejectReason(text, words, previousWords, hasAgreement, repeatedShortCount, metrics.rms);
    const canAcceptRepeatedShort = words.length < 4 && repeatedShortCount >= 2 && !isGenericShort(text);

    if (rejectReason && !canAcceptRepeatedShort) {
      previousWords = words;
      previousText = text;
      hypotheses.push({ text, rejected: rejectReason });
      continue;
    }

    const agreementWords = hasAgreement || canAcceptRepeatedShort
      ? words.slice(0, canAcceptRepeatedShort ? words.length : confirmableAgreementLength)
      : [];
    committedWords = appendWithOverlap(committedWords, agreementWords);
    if (committedWords.length > 0) {
      const approxCommittedWordsInBuffer = Math.min(committedWords.length, words.length);
      const approxCommittedEndSec = startSec + (actualEndSec - startSec) * approxCommittedWordsInBuffer / Math.max(words.length, 1);
      bufferStartSec = Math.max(bufferStartSec, Math.max(0, approxCommittedEndSec - confirmedAudioRetainSec));
    }
    const committedOverlap = suffixPrefixOverlap(committedWords, words);
    const unstableStart = Math.max(agreementWords.length, committedOverlap);
    unstableWords = words.slice(unstableStart).slice(-40);
    hypotheses.push({ text, rejected: '' });
    previousWords = words;
    previousText = text;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  const finalText = untokenize(committedWords) + (unstableWords.length ? ` ${untokenize(unstableWords)}` : '');
  return {
    finalText: finalText.trim(),
    meta: {
      ok: true,
      pipeline: 'accumulated-stream-local-agreement',
      hypotheses: hypotheses.length,
      model: 'large-v3-turbo',
      language,
      promptMode,
    },
  };
}

function sliceWav(wav, startSec, endSec) {
  const frameStart = Math.max(0, Math.floor(startSec * wav.sampleRate));
  const frameEnd = Math.min(Math.floor(wav.samples.length / wav.channels), Math.ceil(endSec * wav.sampleRate));
  const sampleStart = frameStart * wav.channels;
  const sampleEnd = frameEnd * wav.channels;
  return { samples: wav.samples.slice(sampleStart, sampleEnd) };
}

function measureInt16(samples) {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    peak = Math.max(peak, Math.abs(normalized));
    sum += normalized * normalized;
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

function normalizeInt16ForWhisper(samples, peak) {
  const gain = peak > whisperPeakTarget ? whisperPeakTarget / peak : 1;
  if (gain === 1) return { samples, gain };
  const normalized = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    normalized[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain)));
  }
  return { samples: normalized, gain };
}

function parseWhisperText(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/u, '').trim())
    .filter((line) => line && !line.startsWith('whisper_') && !line.startsWith('system_info:'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeStderr(stderr) {
  return stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-8).join('\n');
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function tokenize(text) {
  return text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function untokenize(words) {
  return words.join(' ').replace(/\s+([,.?!;:])/g, '$1').trim();
}

function normalizeText(text) {
  return tokenize(text)
    .map((word) => word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{Letter}\p{Number}]+/gu, ''))
    .filter(Boolean)
    .join(' ');
}

function normalizeToken(t) {
  return normalizeText(t);
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let len = 0;
  for (; len < max; len += 1) {
    if (!normalizeToken(left[len]) || normalizeToken(left[len]) !== normalizeToken(right[len])) break;
  }
  return len;
}

function trimRightEdgeAgreement(words, agreementLength, startSec, endSec, rightEdgeGuardSec) {
  if (agreementLength === 0) return 0;
  const durationSec = Math.max(0.001, endSec - startSec);
  const wordStepSec = durationSec / Math.max(words.length, 1);
  let length = 0;
  for (; length < agreementLength; length += 1) {
    const wordEndSec = startSec + wordStepSec * (length + 1);
    if (wordEndSec > endSec - rightEdgeGuardSec) break;
  }
  return length;
}

function suffixPrefixOverlap(left, right) {
  const max = Math.min(left.length, right.length, 45);
  for (let length = max; length >= 2; length -= 1) {
    const ls = left.slice(left.length - length).map(normalizeToken);
    const rp = right.slice(0, length).map(normalizeToken);
    if (ls.every((w, i) => w && w === rp[i])) return length;
  }
  return 0;
}

function appendWithOverlap(existing, incoming) {
  if (!incoming.length) return existing;
  const o = suffixPrefixOverlap(existing, incoming);
  return removeDupTail([...existing, ...incoming.slice(o)]);
}

function removeDupTail(words) {
  for (let length = Math.min(18, Math.floor(words.length / 2)); length >= 4; length -= 1) {
    const left = words.slice(words.length - length * 2, words.length - length).map(normalizeToken).join(' ');
    const right = words.slice(words.length - length).map(normalizeToken).join(' ');
    if (left && left === right) return words.slice(0, words.length - length);
  }
  return words;
}

function getStreamingRejectReason(text, words, previousWords, hasAgreement, repeatedShortCount, rms) {
  if (hasAgreement) return '';
  if (isGenericShort(text)) return 'generic-short';
  if (words.length < 4 && repeatedShortCount < 2) return 'short-unconfirmed';
  if (rms < 0.015 && words.length < 6) return 'low-rms-unconfirmed';
  if (previousWords.length > 0 && words.length < 6 && textSimilarity(untokenize(previousWords), text) < 0.15) return 'abrupt-short-change';
  return '';
}

function isGenericShort(text) {
  const n = normalizeText(text);
  return ['gracias', 'muchas gracias', 'nos vemos', 'hasta luego', 'subtitulos', 'subtitulos realizados']
    .some((p) => n === normalizeText(p));
}

function textSimilarity(left, right) {
  const lw = new Set(tokenize(left).map(normalizeToken).filter(Boolean));
  const rw = new Set(tokenize(right).map(normalizeToken).filter(Boolean));
  if (lw.size === 0 || rw.size === 0) return 0;
  let inter = 0;
  for (const w of lw) if (rw.has(w)) inter += 1;
  return inter / Math.max(lw.size, rw.size);
}
