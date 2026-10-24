#!/usr/bin/env node
/**
 * Continuous-session soak for the live ASR pipeline (AsrSession + VAD).
 *
 * Feeds repeating speech/silence as fast as possible for `--minutes` of *audio*
 * (default 30) using an in-process fake engine, so a 30-minute session finishes
 * in well under wall-clock 30 minutes. Pass `--realtime` to match wall clock.
 *
 *   node scripts/asr-soak.mjs [--minutes 30] [--realtime] [--with-previews] [--heap-limit-mb 96]
 *
 * Fails if heap grows without bound, if stop() times out, or if opened segments
 * are lost (no final / drop / empty) when the session drains.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadTsModules } from './lib/load-ts.mjs';

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const minutes = args.minutes;
const heapLimitMb = args.heapLimitMb;
const RATE = 16_000;

const modules = loadTsModules(
  [
    path.join(root, 'electron', 'asr', 'protocol.ts'),
    path.join(root, 'electron', 'asr', 'resample.ts'),
    path.join(root, 'electron', 'asr', 'vadEndpointing.ts'),
    path.join(root, 'electron', 'asr', 'asrSession.ts'),
  ],
  'openwhispr-asr-soak',
);
const { AsrSession } = await modules.import('asrSession');

function speechBurst(ms, seed) {
  const out = new Float32Array(Math.round((RATE * ms) / 1000));
  let x = seed;
  let last = 0;
  for (let i = 0; i < out.length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const white = (x / 0x7fffffff) * 2 - 1;
    last = 0.6 * last + 0.4 * white;
    out[i] = last * 0.14;
  }
  return out;
}
function silence(ms) {
  return new Float32Array(Math.round((RATE * ms) / 1000));
}

class FakeEngine {
  constructor({ supportsPreview }) {
    this.name = 'soak-fake';
    this.supportsPreview = supportsPreview;
    this.finals = 0;
    this.previews = 0;
  }
  transcribe(request) {
    if (request.kind === 'preview') {
      this.previews += 1;
      return Promise.resolve({ text: `p${this.previews}`, processingMs: 0, engine: this.name });
    }
    this.finals += 1;
    return Promise.resolve({ text: `f${this.finals}`, processingMs: 0, engine: this.name });
  }
  cancelPreviews() {}
}

const engine = new FakeEngine({ supportsPreview: args.withPreviews });
const events = { finals: 0, dropped: 0, errors: 0, previews: 0 };
const session = new AsrSession({
  sessionId: 'soak',
  generation: 1,
  language: 'en',
  engine,
  emit: (event) => {
    if (event.type === 'final') events.finals += 1;
    else if (event.type === 'segment-dropped') events.dropped += 1;
    else if (event.type === 'error') events.errors += 1;
    else if (event.type === 'preview') events.previews += 1;
  },
  previewsEnabled: args.withPreviews,
  previewIntervalMs: 800,
});

const cycle = concat(speechBurst(1800, 11), silence(1400));
const audioMsTarget = Math.round(minutes * 60_000);
const samplesTarget = Math.round((RATE * audioMsTarget) / 1000);
const heapSamples = [];
const startedAt = Date.now();
let pushed = 0;
let lastHeapLogAt = 0;

if (typeof global.gc === 'function') global.gc();
const heapWarmup = process.memoryUsage().heapUsed;

while (pushed < samplesTarget) {
  const remaining = samplesTarget - pushed;
  const chunk = remaining >= cycle.length ? cycle : cycle.subarray(0, remaining);
  session.pushAudio('mic', chunk, RATE);
  pushed += chunk.length;
  if (args.realtime) {
    await sleep((chunk.length / RATE) * 1000);
  }
  const audioMs = (pushed / RATE) * 1000;
  if (audioMs - lastHeapLogAt >= 60_000 || pushed >= samplesTarget) {
    if (typeof global.gc === 'function') global.gc();
    const heap = process.memoryUsage();
    heapSamples.push({ audioMs: Math.round(audioMs), heapUsed: heap.heapUsed, rss: heap.rss });
    lastHeapLogAt = audioMs;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      `soak ${Math.round(audioMs / 1000)}s audio · heap ${(heap.heapUsed / 1024 / 1024).toFixed(1)} MB · wall ${elapsed}s\n`,
    );
  }
}

const drained = await session.stop({ timeoutMs: 15_000 });
if (typeof global.gc === 'function') global.gc();
const heapEnd = process.memoryUsage().heapUsed;
const heapDeltaMb = (heapEnd - heapWarmup) / (1024 * 1024);
const accounted = session.stats.finalsEmitted + session.stats.finalsEmpty + events.dropped;

assert.equal(drained.timedOut, false, 'stop() must not time out');
assert.equal(events.errors, 0, 'engine errors during soak');
assert.equal(accounted, session.stats.segmentsOpened, `lost segments: opened=${session.stats.segmentsOpened} accounted=${accounted}`);
assert.ok(heapDeltaMb < heapLimitMb, `heap grew ${heapDeltaMb.toFixed(1)} MB (limit ${heapLimitMb} MB)`);

const report = {
  minutes,
  wallMs: Date.now() - startedAt,
  audioMs: Math.round((pushed / RATE) * 1000),
  realtime: args.realtime,
  previews: args.withPreviews,
  stats: session.stats,
  drained,
  heapWarmupMb: heapWarmup / (1024 * 1024),
  heapEndMb: heapEnd / (1024 * 1024),
  heapDeltaMb,
  heapSamples,
};
console.log(JSON.stringify(report, null, 2));
console.log(`\nok - ${minutes}-minute audio soak (Δheap ${heapDeltaMb.toFixed(1)} MB, ${session.stats.finalsEmitted} finals)`);
modules.cleanup();

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseArgs(argv) {
  const out = { minutes: 30, realtime: false, withPreviews: false, heapLimitMb: 96 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime') out.realtime = true;
    else if (arg === '--with-previews') out.withPreviews = true;
    else if (arg === '--minutes') out.minutes = Number(argv[++i]);
    else if (arg.startsWith('--minutes=')) out.minutes = Number(arg.slice('--minutes='.length));
    else if (arg === '--heap-limit-mb') out.heapLimitMb = Number(argv[++i]);
    else if (arg.startsWith('--heap-limit-mb=')) out.heapLimitMb = Number(arg.slice('--heap-limit-mb='.length));
  }
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) {
    console.error('--minutes must be a positive number');
    process.exit(1);
  }
  return out;
}
