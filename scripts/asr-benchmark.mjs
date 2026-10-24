#!/usr/bin/env node
/**
 * Reproducible ASR benchmark for the live transcription engines.
 *
 *   node scripts/asr-benchmark.mjs [--engines parakeet,whisper] [--fixtures id1,id2] [--no-streaming]
 *                                  [--pace 1] [--regen-fixtures] [--language auto|fixture]
 *
 * Corpus: scripts/asr-benchmark-fixtures.json rendered with macOS `say` (16 kHz mono WAV) into
 * recordings/benchmarks/fixtures/ (gitignored). Metrics per engine and fixture:
 *   batch     — WER, CER, processing time, RTF (processing / audio)
 *   streaming — drives electron/asr/asrSession.ts exactly like the app (VAD, previews, finals, drain):
 *               time-to-first-hypothesis, final latency after endpoint, expected vs received finals
 *               (lost segments), WER of the concatenated finals, stop() drain time.
 * Report: recordings/benchmarks/asr-<runId>/report.{json,md}
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadTsModules } from './lib/load-ts.mjs';

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ES_ONES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve'];
const ES_TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const ES_HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const manifestPath = path.join(root, 'scripts', 'asr-benchmark-fixtures.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const fixturesDir = path.join(root, 'recordings', 'benchmarks', 'fixtures');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(root, 'recordings', 'benchmarks', `asr-${runId}`);

const helperPath = path.join(root, 'tools', 'macos-asr-helper', '.build', 'release', 'openwhispr-asr-helper');
const parakeetModelDir = path.join(root, '.local', 'models', 'parakeet-tdt-0.6b-v3');
const whisperBin = path.join(root, '.local', 'whisper.cpp', 'build', 'bin');
const whisperCli = path.join(whisperBin, 'whisper-cli');
const whisperServer = path.join(whisperBin, 'whisper-server');
const whisperModel = path.join(root, '.local', 'models', 'ggml-large-v3-turbo.bin');

const modules = loadTsModules(
  [
    path.join(root, 'electron', 'asr', 'protocol.ts'),
    path.join(root, 'electron', 'asr', 'resample.ts'),
    path.join(root, 'electron', 'asr', 'vadEndpointing.ts'),
    path.join(root, 'electron', 'asr', 'asrSession.ts'),
    path.join(root, 'electron', 'asr', 'parakeetHelperClient.ts'),
    path.join(root, 'electron', 'asr', 'whisperEngine.ts'),
  ],
  'openwhispr-asr-benchmark',
);
const { decodeWavPcm16 } = await modules.import('resample');
const { AsrSession } = await modules.import('asrSession');
const { ParakeetHelperClient } = await modules.import('parakeetHelperClient');
const { WhisperEngine } = await modules.import('whisperEngine');

const fixtures = ensureFixtures(manifest, fixturesDir, args.regenFixtures).filter(
  (fixture) => !args.fixtures || args.fixtures.includes(fixture.id),
);
if (fixtures.length === 0) {
  console.error('No fixtures selected.');
  process.exit(1);
}

const engines = await createEngines(args.engines);
if (engines.length === 0) {
  console.error('No engine available. Build the helper (npm run build:macos-asr-helper) or run npm run whisper:setup.');
  process.exit(1);
}

fs.mkdirSync(runDir, { recursive: true });
const report = {
  runId,
  createdAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, node: process.version },
  options: args,
  engines: engines.map((engine) => ({ name: engine.name, label: engine.label })),
  fixtures: fixtures.map((fixture) => ({
    id: fixture.id,
    language: fixture.language,
    durationMs: fixture.durationMs,
    utterances: fixture.utterances.length,
    words: tokenize(normalizeText(fixture.reference, fixture.language)).length,
  })),
  results: [],
  summary: {},
};

console.log(`ASR benchmark ${runId}`);
console.log(`fixtures: ${fixtures.length} (${fixtures.map((f) => f.id).join(', ')})`);
console.log(`engines: ${engines.map((e) => e.label).join(', ')}`);
console.log(`output: ${runDir}`);

for (const engine of engines) {
  console.log(`\n== ${engine.label} ==`);
  await engine.start();
  for (const fixture of fixtures) {
    const language = args.language === 'auto' ? 'auto' : fixture.language;
    const entry = { engine: engine.name, fixture: fixture.id, language, batch: null, streaming: null };

    entry.batch = await runBatch(engine, fixture, language);
    console.log(
      `${fixture.id.padEnd(26)} batch  WER ${pct(entry.batch.wer)}  CER ${pct(entry.batch.cer)}  ` +
        `${entry.batch.processingMs.toFixed(0)} ms  RTF ${entry.batch.rtf.toFixed(3)}`,
    );

    if (!args.noStreaming) {
      entry.streaming = await runStreaming(engine, fixture, language);
      const s = entry.streaming;
      console.log(
        `${''.padEnd(26)} stream WER ${pct(s.wer)}  finals ${s.finalsWithText}/${s.expectedFinals}` +
          `${s.finalsEmpty ? ` (+${s.finalsEmpty} empty)` : ''}  ` +
          `TTFH ${fmtStat(s.firstHypothesisMs)}  final ${fmtStat(s.finalLatencyMs)}  drain ${s.drainMs.toFixed(0)} ms` +
          `${s.errors.length ? `  errors ${s.errors.length}` : ''}`,
      );
    }
    report.results.push(entry);
  }
  await engine.stop();
}

report.summary = summarize(report.results, engines);
fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(runDir, 'report.md'), renderMarkdown(report));
modules.cleanup();
console.log(`\n${renderMarkdown(report)}`);
console.log(`Wrote ${path.join(runDir, 'report.md')}`);

// ——— engines ———

async function createEngines(requested) {
  const wanted = requested ?? ['parakeet', 'whisper'];
  const list = [];
  for (const name of wanted) {
    if (name === 'parakeet') {
      if (!fs.existsSync(helperPath)) {
        console.warn(`skip parakeet: helper not built at ${helperPath}`);
        continue;
      }
      const client = new ParakeetHelperClient({
        helperPath,
        modelDir: parakeetModelDir,
        onEvent: (event) => {
          if (event.type === 'progress' && event.stage === 'download') {
            process.stdout.write(`\rparakeet model download ${(event.fraction * 100).toFixed(0)}%   `);
          }
          if (event.type === 'fatal') console.error(`parakeet fatal: ${event.message}`);
        },
      });
      client.on('stderr', (text) => {
        if (args.verbose) console.error(`[helper] ${text}`);
      });
      list.push({
        name: client.name,
        label: 'Parakeet TDT 0.6B v3 (FluidAudio helper)',
        engine: client,
        start: async () => {
          const startedAt = performance.now();
          const ready = await client.start();
          console.log(`helper ready in ${(performance.now() - startedAt).toFixed(0)} ms (load ${ready.loadMs.toFixed(0)} ms, warm-up ${ready.warmupMs.toFixed(0)} ms)`);
        },
        stop: () => client.stop(),
      });
    } else if (name === 'whisper') {
      if (!WhisperEngine.isConfigured({ cliPath: whisperCli, modelPath: whisperModel })) {
        console.warn(`skip whisper: missing ${whisperCli} or ${whisperModel}`);
        continue;
      }
      const engine = new WhisperEngine({
        cliPath: whisperCli,
        serverPath: fs.existsSync(whisperServer) ? whisperServer : null,
        modelPath: whisperModel,
        useServer: !args.whisperCli,
        log: (message) => {
          if (args.verbose) console.error(`[whisper] ${message}`);
        },
      });
      list.push({
        name: engine.name,
        label: `Whisper large-v3-turbo (whisper.cpp ${args.whisperCli ? 'cli' : 'server'})`,
        engine,
        start: async () => {
          const startedAt = performance.now();
          await engine.warmUp();
          console.log(`whisper ready in ${(performance.now() - startedAt).toFixed(0)} ms`);
        },
        stop: () => engine.stop(),
      });
    } else {
      console.warn(`unknown engine: ${name}`);
    }
  }
  return list;
}

// ——— batch ———

async function runBatch(engine, fixture, language) {
  const startedAt = performance.now();
  let text = '';
  let error = null;
  try {
    const result = await engine.engine.transcribe({
      requestId: `batch-${fixture.id}`,
      sessionId: 'benchmark',
      generation: 0,
      source: 'mic',
      segmentId: `batch-${fixture.id}`,
      kind: 'final',
      samples: fixture.samples,
      sampleRate: fixture.sampleRate,
      startMs: 0,
      endMs: fixture.durationMs,
      language,
    });
    text = result.text;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const processingMs = performance.now() - startedAt;
  const scores = score(fixture.reference, text, fixture.language);
  return { text, error, processingMs, rtf: processingMs / fixture.durationMs, ...scores };
}

// ——— streaming ———

async function runStreaming(engine, fixture, language) {
  const events = [];
  const wallStart = performance.now();
  const segmentOpenedAt = new Map();
  const firstHypothesisMs = [];
  const session = new AsrSession({
    sessionId: `bench-${fixture.id}`,
    generation: 1,
    language,
    engine: engine.engine,
    emit: (event) => {
      const at = performance.now() - wallStart;
      events.push({ at, ...event, text: event.text });
      if (event.type === 'segment-open') segmentOpenedAt.set(event.segmentId, at);
      if (event.type === 'preview' && segmentOpenedAt.has(event.segmentId)) {
        firstHypothesisMs.push(at - segmentOpenedAt.get(event.segmentId));
        segmentOpenedAt.delete(event.segmentId);
      }
    },
  });

  const chunkMs = 100;
  const chunkSamples = Math.round((fixture.sampleRate * chunkMs) / 1000);
  const pace = Number.isFinite(args.pace) ? args.pace : 1;
  let nextDue = performance.now();
  for (let offset = 0; offset < fixture.samples.length; offset += chunkSamples) {
    const chunk = fixture.samples.subarray(offset, Math.min(fixture.samples.length, offset + chunkSamples));
    session.pushAudio('mic', chunk, fixture.sampleRate);
    if (pace > 0) {
      nextDue += chunkMs / pace;
      const wait = nextDue - performance.now();
      if (wait > 0) await sleep(wait);
    }
  }
  // Trailing silence so VAD closes the last utterance the same way it would in a meeting; stop() flushes anyway.
  const tail = new Float32Array(Math.round(fixture.sampleRate * 0.4));
  session.pushAudio('mic', tail, fixture.sampleRate);
  const drainStartedAt = performance.now();
  const drained = await session.stop({ timeoutMs: 60_000 });
  const drainMs = performance.now() - drainStartedAt;

  const finals = events.filter((event) => event.type === 'final').sort((a, b) => a.startMs - b.startMs);
  const finalsWithText = finals.filter((event) => event.text);
  const text = finalsWithText.map((event) => event.text).join(' ');
  const scores = score(fixture.reference, text, fixture.language);
  return {
    text,
    ...scores,
    expectedFinals: fixture.utterances.length,
    finalsWithText: finalsWithText.length,
    finalsEmpty: finals.length - finalsWithText.length,
    segmentsOpened: events.filter((event) => event.type === 'segment-open').length,
    droppedSegments: events.filter((event) => event.type === 'segment-dropped').map((event) => event.reason),
    previews: events.filter((event) => event.type === 'preview').length,
    firstHypothesisMs: stats(firstHypothesisMs),
    finalLatencyMs: stats(finalsWithText.map((event) => event.latencyMs)),
    drainMs,
    drained,
    errors: events.filter((event) => event.type === 'error').map((event) => `${event.kind}: ${event.message}`),
    sessionStats: session.stats,
    timeline: events.map((event) => ({
      at: Math.round(event.at),
      type: event.type,
      segmentId: event.segmentId,
      text: event.text,
      latencyMs: event.latencyMs,
    })),
  };
}

// ——— fixtures ———

function ensureFixtures(manifestData, dir, regen) {
  fs.mkdirSync(dir, { recursive: true });
  const list = [];
  for (const fixture of manifestData.fixtures) {
    const voice = manifestData.voices[fixture.language];
    const pauseMs = fixture.pauseMs ?? manifestData.defaultPauseMs ?? 1500;
    const spoken = fixture.utterances.join(` [[slnc ${pauseMs}]] `);
    const reference = fixture.utterances.join(' ');
    const hash = crypto.createHash('sha1').update(JSON.stringify({ voice, spoken, rate: fixture.rate ?? null })).digest('hex').slice(0, 12);
    const wavPath = path.join(dir, `${fixture.id}.wav`);
    const metaPath = path.join(dir, `${fixture.id}.json`);
    let needsRender = regen || !fs.existsSync(wavPath) || !fs.existsSync(metaPath);
    if (!needsRender) {
      try {
        needsRender = JSON.parse(fs.readFileSync(metaPath, 'utf8')).hash !== hash;
      } catch {
        needsRender = true;
      }
    }
    if (needsRender) {
      renderFixture({ voice, spoken, rate: fixture.rate, wavPath });
      fs.writeFileSync(metaPath, JSON.stringify({ id: fixture.id, language: fixture.language, voice, hash, reference, utterances: fixture.utterances }, null, 2));
      console.log(`rendered fixture ${fixture.id}`);
    }
    const wav = decodeWavPcm16(fs.readFileSync(wavPath));
    if (!wav) throw new Error(`Fixture is not 16-bit PCM WAV: ${wavPath}`);
    list.push({
      ...fixture,
      reference,
      wavPath,
      samples: wav.samples,
      sampleRate: wav.sampleRate,
      durationMs: (wav.samples.length / wav.sampleRate) * 1000,
    });
  }
  return list;
}

function renderFixture({ voice, spoken, rate, wavPath }) {
  if (process.platform !== 'darwin') throw new Error('Fixture rendering requires macOS `say`.');
  const aiffPath = `${wavPath}.aiff`;
  const sayArgs = ['-v', voice, '-o', aiffPath];
  if (rate) sayArgs.push('-r', String(rate));
  sayArgs.push(spoken);
  const say = spawnSync('say', sayArgs, { encoding: 'utf8' });
  if (say.status !== 0) throw new Error(`say failed for ${wavPath}: ${say.stderr}`);
  const convert = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiffPath, wavPath], { encoding: 'utf8' });
  fs.rmSync(aiffPath, { force: true });
  if (convert.status !== 0) throw new Error(`afconvert failed for ${wavPath}: ${convert.stderr}`);
}

// ——— scoring ———

/**
 * Scoring normalization: lowercase, strip accents/punctuation, and spell out digits/percent so that
 * "80%" and "eighty percent" compare equal (ASR engines emit digits; references are written as spoken).
 */
function normalizeText(text, language = 'en') {
  const spelled = String(text ?? '')
    .toLowerCase()
    .replace(/(\d+)[.,](\d+)/g, (_m, whole, fraction) => `${whole} ${language === 'es' ? 'coma' : 'point'} ${fraction.split('').join(' ')}`)
    .replace(/(\d)\s*%/g, `$1 ${language === 'es' ? 'por ciento' : 'percent'}`)
    .replace(/\b(\d{1,9})\b/g, (match) => numberToWords(Number(match), language));
  return spelled
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberToWords(n, language) {
  if (!Number.isFinite(n)) return String(n);
  // Years like 2023 are spoken "twenty twenty three" in English; keep the reference convention.
  if (language !== 'es' && n >= 1100 && n <= 2099 && n % 100 !== 0) {
    return `${englishBelowThousand(Math.floor(n / 100))} ${englishBelowThousand(n % 100)}`;
  }
  return language === 'es' ? spanishNumber(n) : englishNumber(n);
}

function englishBelowThousand(n) {
  if (n < 20) return EN_ONES[n];
  if (n < 100) return `${EN_TENS[Math.floor(n / 10)]}${n % 10 ? ` ${EN_ONES[n % 10]}` : ''}`;
  return `${EN_ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${englishBelowThousand(n % 100)}` : ''}`;
}

function englishNumber(n) {
  if (n < 1000) return englishBelowThousand(n);
  const units = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1_000, 'thousand']];
  const parts = [];
  let rest = n;
  for (const [value, label] of units) {
    if (rest >= value) {
      parts.push(`${englishBelowThousand(Math.floor(rest / value))} ${label}`);
      rest %= value;
    }
  }
  if (rest) parts.push(englishBelowThousand(rest));
  return parts.join(' ');
}

function spanishBelowThousand(n) {
  if (n < 30) return ES_ONES[n];
  if (n < 100) return `${ES_TENS[Math.floor(n / 10)]}${n % 10 ? ` y ${ES_ONES[n % 10]}` : ''}`;
  if (n === 100) return 'cien';
  return `${ES_HUNDREDS[Math.floor(n / 100)]}${n % 100 ? ` ${spanishBelowThousand(n % 100)}` : ''}`;
}

function spanishNumber(n) {
  if (n < 1000) return spanishBelowThousand(n);
  const parts = [];
  let rest = n;
  if (rest >= 1_000_000) {
    const millions = Math.floor(rest / 1_000_000);
    parts.push(millions === 1 ? 'un millon' : `${spanishBelowThousand(millions)} millones`);
    rest %= 1_000_000;
  }
  if (rest >= 1000) {
    const thousands = Math.floor(rest / 1000);
    parts.push(thousands === 1 ? 'mil' : `${spanishBelowThousand(thousands)} mil`);
    rest %= 1000;
  }
  if (rest) parts.push(spanishBelowThousand(rest));
  return parts.join(' ');
}

function tokenize(text) {
  return text.split(' ').filter(Boolean);
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array(cols);
  let current = new Array(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[cols - 1];
}

function score(reference, hypothesis, language) {
  const refWords = tokenize(normalizeText(reference, language));
  const hypWords = tokenize(normalizeText(hypothesis ?? '', language));
  const refChars = Array.from(refWords.join(''));
  const hypChars = Array.from(hypWords.join(''));
  return {
    wer: refWords.length ? levenshtein(refWords, hypWords) / refWords.length : 0,
    cer: refChars.length ? levenshtein(refChars, hypChars) / refChars.length : 0,
    referenceWords: refWords.length,
    hypothesisWords: hypWords.length,
  };
}

function stats(values) {
  if (!values.length) return { count: 0, p50: null, p90: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    p50: pick(0.5),
    p90: pick(0.9),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

function summarize(results, engineList) {
  const summary = {};
  for (const engine of engineList) {
    const rows = results.filter((row) => row.engine === engine.name);
    const batch = rows.map((row) => row.batch).filter(Boolean);
    const streaming = rows.map((row) => row.streaming).filter(Boolean);
    const weightedWer = (items) => {
      const ref = items.reduce((sum, item) => sum + item.referenceWords, 0);
      const errors = items.reduce((sum, item) => sum + item.wer * item.referenceWords, 0);
      return ref ? errors / ref : 0;
    };
    summary[engine.name] = {
      label: engine.label,
      batchWer: weightedWer(batch),
      batchRtf: batch.length ? batch.reduce((sum, item) => sum + item.rtf, 0) / batch.length : null,
      streamingWer: streaming.length ? weightedWer(streaming) : null,
      expectedFinals: streaming.reduce((sum, item) => sum + item.expectedFinals, 0),
      finalsWithText: streaming.reduce((sum, item) => sum + item.finalsWithText, 0),
      firstHypothesisMs: stats(collectTtfh(streaming)),
      finalLatencyMs: stats(collectFinalLatencies(streaming)),
      drainMs: stats(streaming.map((item) => item.drainMs)),
      errors: streaming.reduce((sum, item) => sum + item.errors.length, 0),
    };
  }
  return summary;
}

function collectTtfh(streaming) {
  const values = [];
  for (const item of streaming) {
    const opened = new Map();
    for (const event of item.timeline) {
      if (event.type === 'segment-open') opened.set(event.segmentId, event.at);
      if (event.type === 'preview' && opened.has(event.segmentId)) {
        values.push(event.at - opened.get(event.segmentId));
        opened.delete(event.segmentId);
      }
    }
  }
  return values;
}

function collectFinalLatencies(streaming) {
  return streaming.flatMap((item) => item.timeline.filter((event) => event.type === 'final' && event.text).map((event) => event.latencyMs));
}

function renderMarkdown(reportData) {
  const lines = [];
  lines.push(`# ASR benchmark ${reportData.runId}`);
  lines.push('');
  lines.push(`Fixtures: ${reportData.fixtures.length} · total audio ${(reportData.fixtures.reduce((sum, f) => sum + f.durationMs, 0) / 1000).toFixed(1)} s · ${reportData.fixtures.reduce((sum, f) => sum + f.words, 0)} reference words`);
  lines.push('');
  lines.push('| Engine | Batch WER | Batch RTF | Stream WER | Finals | TTFH p50/p90 | Final latency p50/p90 | Drain p90 | Errors |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const [name, s] of Object.entries(reportData.summary)) {
    lines.push(
      `| ${s.label} (\`${name}\`) | ${pct(s.batchWer)} | ${s.batchRtf === null ? '–' : s.batchRtf.toFixed(3)} | ` +
        `${s.streamingWer === null ? '–' : pct(s.streamingWer)} | ${s.finalsWithText}/${s.expectedFinals} | ` +
        `${fmtStat(s.firstHypothesisMs)} | ${fmtStat(s.finalLatencyMs)} | ${s.drainMs.p90 === null ? '–' : `${s.drainMs.p90.toFixed(0)} ms`} | ${s.errors} |`,
    );
  }
  lines.push('');
  lines.push('## Per fixture');
  lines.push('');
  lines.push('| Engine | Fixture | Batch WER | Stream WER | Finals | TTFH p50 | Final p50 | Batch text |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of reportData.results) {
    const s = row.streaming;
    lines.push(
      `| \`${row.engine}\` | ${row.fixture} | ${pct(row.batch.wer)} | ${s ? pct(s.wer) : '–'} | ${s ? `${s.finalsWithText}/${s.expectedFinals}` : '–'} | ` +
        `${s ? fmtMs(s.firstHypothesisMs.p50) : '–'} | ${s ? fmtMs(s.finalLatencyMs.p50) : '–'} | ${escapeCell(row.batch.text || row.batch.error || '')} |`,
    );
  }
  lines.push('');
  lines.push('Targets (plan): first hypothesis ≤ 1500 ms, final ≤ 1200 ms after endpoint, zero lost finals, zero stale results.');
  return lines.join('\n');
}

// ——— utils ———

function parseArgs(argv) {
  const out = { engines: null, fixtures: null, noStreaming: false, pace: 1, regenFixtures: false, language: 'fixture', verbose: false, whisperCli: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--engines') out.engines = argv[++index].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--fixtures') out.fixtures = argv[++index].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--no-streaming') out.noStreaming = true;
    else if (arg === '--pace') out.pace = Number(argv[++index]);
    else if (arg === '--regen-fixtures') out.regenFixtures = true;
    else if (arg === '--language') out.language = argv[++index];
    else if (arg === '--verbose') out.verbose = true;
    else if (arg === '--whisper-cli') out.whisperCli = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/asr-benchmark.mjs [--engines parakeet,whisper] [--fixtures a,b] [--no-streaming] [--pace 1] [--regen-fixtures] [--language auto|fixture] [--whisper-cli] [--verbose]');
      process.exit(0);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pct(value) {
  return value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`;
}

function fmtMs(value) {
  return value === null || value === undefined ? '–' : `${Math.round(value)} ms`;
}

function fmtStat(stat) {
  if (!stat || !stat.count) return '–';
  return `${Math.round(stat.p50)}/${Math.round(stat.p90)} ms`;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);
}
