import assert from 'node:assert/strict';
import path from 'node:path';
import { loadTsModules } from './lib/load-ts.mjs';

const root = process.cwd();
const modules = loadTsModules(
  [
    path.join(root, 'electron', 'asr', 'protocol.ts'),
    path.join(root, 'electron', 'asr', 'resample.ts'),
    path.join(root, 'electron', 'asr', 'vadEndpointing.ts'),
    path.join(root, 'electron', 'asr', 'asrSession.ts'),
  ],
  'openwhispr-asr-session-test',
);
const { AsrSession, RequestDroppedError } = await modules.import('asrSession');
const { resampleToAsrRate, interleavedToMono } = await modules.import('resample');

const RATE = 16_000;

/** Deterministic "speech": band-limited noise bursts at a stable RMS; silence is near-zero noise. */
function speech(ms, amplitude = 0.12, seed = 1) {
  const out = new Float32Array(Math.round((RATE * ms) / 1000));
  let x = seed;
  let last = 0;
  for (let i = 0; i < out.length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const white = (x / 0x7fffffff) * 2 - 1;
    last = 0.6 * last + 0.4 * white;
    out[i] = last * amplitude;
  }
  return out;
}
function silence(ms) {
  const out = new Float32Array(Math.round((RATE * ms) / 1000));
  let x = 7;
  for (let i = 0; i < out.length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((x / 0x7fffffff) * 2 - 1) * 0.0005;
  }
  return out;
}
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

class FakeEngine {
  constructor({ name = 'fake', supportsPreview = true, delayMs = 5, fail = () => false, text = (req) => `${req.kind}:${Math.round(req.endMs - req.startMs)}` } = {}) {
    this.name = name;
    this.supportsPreview = supportsPreview;
    this.delayMs = delayMs;
    this.fail = fail;
    this.text = text;
    this.requests = [];
    this.cancelledSessions = [];
  }
  transcribe(request) {
    this.requests.push(request);
    const delay = typeof this.delayMs === 'function' ? this.delayMs(request) : this.delayMs;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this.fail(request)) reject(new Error('engine failure'));
        else resolve({ text: this.text(request), processingMs: delay, engine: this.name });
      }, delay);
    });
  }
  cancelPreviews(sessionId) {
    this.cancelledSessions.push(sessionId);
  }
}

async function feed(session, source, pcm, { chunkMs = 100, realtime = false } = {}) {
  const step = Math.round((RATE * chunkMs) / 1000);
  for (let offset = 0; offset < pcm.length; offset += step) {
    session.pushAudio(source, pcm.subarray(offset, Math.min(pcm.length, offset + step)), RATE);
    // Yield so engine promises resolve between frames (previews depend on this).
    await new Promise((resolve) => setTimeout(resolve, realtime ? chunkMs : 0));
  }
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

await test('1–4 s phrase produces exactly one non-empty final after silence', async () => {
  const events = [];
  const engine = new FakeEngine();
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e) });
  await feed(session, 'mic', concat(silence(300), speech(2000), silence(1500)));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.ok(finals[0].text.startsWith('final:'));
  // 300 ms pre-roll + 2000 ms speech + ~1100 ms endpointing tail (silenceToClose + hangover + postRoll).
  assert.ok(finals[0].audioMs >= 2000 && finals[0].audioMs <= 3600, `audioMs ${finals[0].audioMs}`);
  assert.equal(finals[0].viaFallback, false);
  assert.equal(events.filter((e) => e.type === 'segment-open').length, 1);
});

await test('pure silence produces no segments and no engine calls', async () => {
  const events = [];
  const engine = new FakeEngine();
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e) });
  await feed(session, 'mic', silence(5000));
  const drained = await session.stop();
  assert.equal(engine.requests.length, 0);
  assert.equal(events.filter((e) => e.type !== 'drained').length, 0);
  assert.equal(drained.finalsFlushed, 0);
});

await test('previews are emitted while the segment is open and never after its final', async () => {
  const events = [];
  let now = 0;
  const engine = new FakeEngine({ delayMs: 1 });
  const session = new AsrSession({
    sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push({ ...e, at: now }), now: () => now, previewIntervalMs: 500,
  });
  const pcm = concat(speech(3000), silence(1500));
  const step = RATE / 10;
  for (let offset = 0; offset < pcm.length; offset += step) {
    now += 100;
    session.pushAudio('mic', pcm.subarray(offset, offset + step), RATE);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const previews = events.filter((e) => e.type === 'preview');
  const finalEvent = events.find((e) => e.type === 'final');
  assert.ok(previews.length >= 3, `expected several previews, got ${previews.length}`);
  assert.ok(finalEvent, 'final emitted');
  assert.ok(previews.every((p) => p.segmentId === finalEvent.segmentId));
  assert.ok(previews.every((p) => p.at <= finalEvent.at), 'no preview after final');
  const lastPreview = previews[previews.length - 1];
  assert.ok(lastPreview.endMs > previews[0].endMs, 'previews cover a growing window');
});

await test('slow preview result that lands after the segment closed is discarded as stale', async () => {
  const events = [];
  const engine = new FakeEngine({ delayMs: (req) => (req.kind === 'preview' ? 400 : 1) });
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e), previewIntervalMs: 200 });
  await feed(session, 'mic', concat(speech(1500), silence(1500)));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  const previewAfterFinal = events.findIndex((e) => e.type === 'preview') > events.findIndex((e) => e.type === 'final');
  assert.equal(previewAfterFinal, false, 'stale preview must not surface after the final');
  assert.ok(session.stats.previewsStale >= 1, 'stale preview counted');
});

await test('stop() with an open segment flushes it as a final and cancels only previews', async () => {
  const events = [];
  const engine = new FakeEngine({ delayMs: 20 });
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e) });
  await feed(session, 'mic', concat(silence(200), speech(1200)));
  const drained = await session.stop();
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1, 'pending audio becomes a final on stop');
  assert.ok(finals[0].audioMs >= 1000);
  assert.equal(drained.finalsFlushed, 1);
  assert.equal(drained.timedOut, false);
  assert.deepEqual(engine.cancelledSessions, ['s']);
  assert.equal(session.isStopped, true);
  session.pushAudio('mic', speech(500), RATE);
  assert.equal(engine.requests.filter((r) => r.kind === 'final').length, 1, 'audio after stop is ignored');
});

await test('stop() flushes a short trailing fragment (< 1 s) instead of discarding it', async () => {
  const events = [];
  const engine = new FakeEngine({ delayMs: 1 });
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e) });
  await feed(session, 'mic', speech(600));
  await session.stop();
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
});

await test('stop() times out but still reports instead of hanging forever', async () => {
  const events = [];
  const engine = new FakeEngine({ delayMs: 5_000 });
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e), finalTimeoutMs: 10_000 });
  await feed(session, 'mic', speech(1000));
  const drained = await session.stop({ timeoutMs: 100 });
  assert.equal(drained.timedOut, true);
  assert.equal(drained.finalsFlushed, 0);
});

await test('primary failure falls back to the secondary engine for finals', async () => {
  const events = [];
  const primary = new FakeEngine({ name: 'parakeet', fail: (req) => req.kind === 'final' });
  const fallback = new FakeEngine({ name: 'whisper', supportsPreview: false, text: () => 'from whisper' });
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'es', engine: primary, fallbackEngine: fallback, emit: (e) => events.push(e) });
  await feed(session, 'mic', concat(speech(1500), silence(1500)));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'from whisper');
  assert.equal(finals[0].engine, 'whisper');
  assert.equal(finals[0].viaFallback, true);
  assert.equal(fallback.requests[0].language, 'es');
  assert.equal(session.stats.fallbackFinals, 1);
});

await test('both engines failing yields error + segment-dropped, never a silent loss', async () => {
  const events = [];
  const primary = new FakeEngine({ fail: () => true });
  const fallback = new FakeEngine({ fail: () => true, supportsPreview: false });
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine: primary, fallbackEngine: fallback, emit: (e) => events.push(e) });
  await feed(session, 'mic', concat(speech(1500), silence(1500)));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(events.filter((e) => e.type === 'error' && e.kind === 'final').length, 1);
  assert.equal(events.filter((e) => e.type === 'segment-dropped' && e.reason === 'error').length, 1);
});

await test('mic and system are segmented independently and tagged by source', async () => {
  const events = [];
  const engine = new FakeEngine();
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'auto', engine, emit: (e) => events.push(e) });
  const mic = concat(speech(1500), silence(1500), silence(2000));
  const system = concat(silence(1000), speech(2500), silence(1500));
  const step = RATE / 10;
  for (let offset = 0; offset < mic.length; offset += step) {
    session.pushAudio('mic', mic.subarray(offset, offset + step), RATE);
    session.pushAudio('system', system.subarray(offset, offset + step), RATE);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const finals = events.filter((e) => e.type === 'final');
  assert.deepEqual(finals.map((f) => f.source).sort(), ['mic', 'system']);
  assert.ok(finals.every((f) => f.segmentId.includes(`:${f.source}:`)));
});

await test('a short low-energy blip is dropped as too-short, clipping is not a reason to drop', async () => {
  const events = [];
  const engine = new FakeEngine();
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e), minFinalAudioMs: 800, vad: { minSpeechMs: 100, minClearRms: 1, minClearPeak: 1 } });
  await feed(session, 'mic', concat(speech(150, 0.03), silence(1500)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((e) => e.type === 'final').length, 0);
  assert.equal(events.filter((e) => e.type === 'segment-dropped' && e.reason === 'too-short').length, 1);

  const clipped = speech(1500, 1.4).map((v) => Math.max(-1, Math.min(1, v)));
  await feed(session, 'mic', concat(clipped, silence(1500)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((e) => e.type === 'final').length, 1, 'clipped audio still gets a final');
});

await test('audio at 48 kHz stereo is resampled and yields the same segment duration', async () => {
  const events = [];
  const engine = new FakeEngine();
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e) });
  const mono48 = new Float32Array(48_000 * 2);
  const src = speech(2000);
  for (let i = 0; i < mono48.length; i += 1) mono48[i] = src[Math.min(src.length - 1, Math.floor(i / 3))];
  const stereo = new Float32Array(mono48.length * 2);
  for (let i = 0; i < mono48.length; i += 1) {
    stereo[i * 2] = mono48[i];
    stereo[i * 2 + 1] = mono48[i];
  }
  const mono = interleavedToMono(stereo, 2);
  assert.equal(mono.length, mono48.length);
  assert.equal(resampleToAsrRate(mono, 48_000).length, 32_000);
  session.pushAudio('mic', mono, 48_000);
  const tail = silence(1500);
  session.pushAudio('mic', tail, RATE);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.ok(finals[0].audioMs >= 2000 && finals[0].audioMs <= 3600, `audioMs ${finals[0].audioMs}`);
});

await test('RequestDroppedError from the engine is not reported as an error', async () => {
  const events = [];
  const engine = new FakeEngine();
  engine.transcribe = (req) => (req.kind === 'preview' ? Promise.reject(new RequestDroppedError(req.requestId, 'superseded')) : Promise.resolve({ text: 'ok', processingMs: 1, engine: 'fake' }));
  const session = new AsrSession({ sessionId: 's', generation: 1, language: 'en', engine, emit: (e) => events.push(e) });
  await feed(session, 'mic', concat(speech(2000), silence(1500)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
});

modules.cleanup();
console.log(`\n${passed} session tests passed`);
