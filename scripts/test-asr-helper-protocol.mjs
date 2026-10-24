/**
 * Protocol test against the real Swift helper with a known WAV. Skips (exit 0) when the helper or models
 * are not installed, so `npm run test:asr` stays runnable on machines without the setup.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTsModules } from './lib/load-ts.mjs';

const root = process.cwd();
const helperPath = path.join(root, 'tools', 'macos-asr-helper', '.build', 'release', 'openwhispr-asr-helper');
const modelDir = path.join(root, '.local', 'models', 'parakeet-tdt-0.6b-v3');
const fixture = path.join(root, 'recordings', 'benchmarks', 'fixtures', 'en-short-question.wav');

if (!fs.existsSync(helperPath)) {
  console.log('skip - helper not built (npm run asr:setup)');
  process.exit(0);
}

const modules = loadTsModules(
  [
    path.join(root, 'electron', 'asr', 'protocol.ts'),
    path.join(root, 'electron', 'asr', 'resample.ts'),
    path.join(root, 'electron', 'asr', 'vadEndpointing.ts'),
    path.join(root, 'electron', 'asr', 'asrSession.ts'),
    path.join(root, 'electron', 'asr', 'parakeetHelperClient.ts'),
  ],
  'openwhispr-helper-protocol-test',
);
const { ParakeetHelperClient } = await modules.import('parakeetHelperClient');
const { RequestDroppedError } = await modules.import('asrSession');
const { decodeWavPcm16, encodeWavPcm16Mono } = await modules.import('resample');

let samples;
let sampleRate = 16_000;
if (fs.existsSync(fixture)) {
  const wav = decodeWavPcm16(fs.readFileSync(fixture));
  samples = wav.samples;
  sampleRate = wav.sampleRate;
} else {
  // No rendered fixture yet: synthesize one with `say` into a temp file.
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-helper-test-'));
  const aiff = path.join(tmp, 'q.aiff');
  const wavPath = path.join(tmp, 'q.wav');
  spawnSync('say', ['-v', 'Samantha', '-o', aiff, 'Can you share the dashboard link again?']);
  spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wavPath]);
  const wav = decodeWavPcm16(fs.readFileSync(wavPath));
  fs.rmSync(tmp, { recursive: true, force: true });
  samples = wav.samples;
  sampleRate = wav.sampleRate;
}
assert.ok(samples.length > 8000, 'fixture audio present');
assert.ok(encodeWavPcm16Mono(samples.subarray(0, 160), 16_000).length === 44 + 320, 'wav encoder sanity');

const events = [];
const client = new ParakeetHelperClient({ helperPath, modelDir, onEvent: (event) => events.push(event) });
client.on('stderr', (text) => console.error(`[helper] ${text}`));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

const ready = await client.start();
assert.equal(ready.type, 'ready');
assert.equal(ready.engine, 'parakeet-tdt-0.6b-v3');
assert.equal(ready.sampleRate, 16_000);
ok(`helper ready (load ${Math.round(ready.loadMs)} ms, warm-up ${Math.round(ready.warmupMs)} ms)`);

const request = (overrides) => ({
  requestId: overrides.requestId,
  sessionId: 'proto',
  generation: 1,
  source: 'mic',
  segmentId: overrides.segmentId ?? 'seg-1',
  kind: overrides.kind ?? 'final',
  samples: overrides.samples ?? samples,
  sampleRate: overrides.sampleRate ?? sampleRate,
  startMs: 0,
  endMs: (samples.length / sampleRate) * 1000,
  language: overrides.language ?? 'en',
});

{
  const result = await client.transcribe(request({ requestId: 'final-1' }));
  assert.match(result.text.toLowerCase(), /share the dashboard link/);
  assert.equal(result.engine, 'parakeet-tdt-0.6b-v3');
  assert.ok(result.processingMs < 2000, `processing ${result.processingMs} ms`);
  ok(`final transcribed: "${result.text}" in ${Math.round(result.processingMs)} ms`);
}

{
  // 48 kHz input is resampled inside the helper.
  const up = new Float32Array(samples.length * 3);
  for (let i = 0; i < up.length; i += 1) up[i] = samples[Math.floor(i / 3)];
  const result = await client.transcribe(request({ requestId: 'final-48k', samples: up, sampleRate: 48_000 }));
  assert.match(result.text.toLowerCase(), /dashboard/);
  ok('48 kHz payload resampled by helper');
}

{
  // Short preview (first 700 ms) is padded and decodes without error.
  const result = await client.transcribe(request({ requestId: 'preview-short', kind: 'preview', samples: samples.subarray(0, Math.round(sampleRate * 0.7)) }));
  assert.equal(typeof result.text, 'string');
  ok(`short preview decoded: "${result.text}"`);
}

{
  // Two previews for the same segment queued back-to-back: the first is superseded (dropped), the second runs.
  const first = client.transcribe(request({ requestId: 'preview-a', kind: 'preview', segmentId: 'seg-p' }));
  const second = client.transcribe(request({ requestId: 'preview-b', kind: 'preview', segmentId: 'seg-p' }));
  const finalReq = client.transcribe(request({ requestId: 'final-priority', kind: 'final', segmentId: 'seg-f' }));
  const outcomes = await Promise.allSettled([first, second, finalReq]);
  const dropped = outcomes.filter((o) => o.status === 'rejected' && o.reason instanceof RequestDroppedError);
  assert.ok(outcomes[2].status === 'fulfilled', 'final always completes');
  assert.ok(outcomes[1].status === 'fulfilled', 'latest preview completes');
  assert.ok(dropped.length <= 1, 'at most the older preview is dropped');
  ok(`preview supersede/priority (${dropped.length} dropped)`);
}

{
  client.cancelPreviews('proto');
  const health = client.health();
  assert.equal(health.pending, 0);
  assert.equal(health.ready, true);
  ok('cancel with empty queue is harmless; health reports ready');
}

{
  const before = Date.now();
  await client.stop();
  assert.equal(client.isRunning, false);
  ok(`graceful stop in ${Date.now() - before} ms`);
}

modules.cleanup();
console.log(`\n${passed} helper protocol tests passed`);
