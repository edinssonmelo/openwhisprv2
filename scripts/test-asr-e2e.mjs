/**
 * End-to-end session: start → speak → pause → speak → stop, then persist the coordinator snapshot.
 * Uses the real AsrSession + TranscriptCoordinator with a fake engine (no helper required).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadTsModules } from './lib/load-ts.mjs';

const root = process.cwd();
const asr = loadTsModules(
  [
    path.join(root, 'electron', 'asr', 'protocol.ts'),
    path.join(root, 'electron', 'asr', 'resample.ts'),
    path.join(root, 'electron', 'asr', 'vadEndpointing.ts'),
    path.join(root, 'electron', 'asr', 'asrSession.ts'),
  ],
  'openwhispr-asr-e2e-session',
);
const ui = loadTsModules(
  [path.join(root, 'src', 'transcription', 'types.ts'), path.join(root, 'src', 'transcription', 'transcriptCoordinator.ts')],
  'openwhispr-asr-e2e-coordinator',
);
const { AsrSession } = await asr.import('asrSession');
const { createTranscriptCoordinator } = await ui.import('transcriptCoordinator');

const RATE = 16_000;

function speech(ms, amplitude = 0.12, seed = 3) {
  const out = new Float32Array(Math.round((RATE * ms) / 1000));
  let x = seed;
  let last = 0;
  for (let i = 0; i < out.length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const white = (x / 0x7fffffff) * 2 - 1;
    last = 0.55 * last + 0.45 * white;
    out[i] = last * amplitude;
  }
  return out;
}
function silence(ms) {
  return new Float32Array(Math.round((RATE * ms) / 1000));
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

class ScriptedEngine {
  name = 'parakeet-tdt-0.6b-v3';
  supportsPreview = true;
  requests = [];
  transcribe(request) {
    this.requests.push(request);
    const uttered = request.kind === 'preview' ? `draft ${request.segmentId}` : `final ${request.segmentId}`;
    return Promise.resolve({ text: uttered, processingMs: 1, engine: this.name });
  }
  cancelPreviews() {}
}

async function feed(session, pcm, chunkMs = 80) {
  const step = Math.round((RATE * chunkMs) / 1000);
  for (let offset = 0; offset < pcm.length; offset += step) {
    session.pushAudio('mic', pcm.subarray(offset, Math.min(pcm.length, offset + step)), RATE);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const coordinator = createTranscriptCoordinator();
coordinator.beginSession('e2e', 1);
const engine = new ScriptedEngine();
const session = new AsrSession({
  sessionId: 'e2e',
  generation: 1,
  language: 'en',
  engine,
  emit: (event) => coordinator.applyEvent(event),
});

await feed(session, concat(silence(200), speech(1800), silence(1400)));
await new Promise((resolve) => setTimeout(resolve, 20));
assert.ok(coordinator.getState().committedText.length > 0, 'first utterance committed after pause');
const afterPause = coordinator.getState().committedText;

await feed(session, concat(speech(1600), silence(400)));
const drained = await session.stop();
assert.equal(drained.timedOut, false);
assert.ok(drained.finalsFlushed >= 1, 'stop flushes the open segment');
assert.equal(coordinator.getState().provisionalText, '');
assert.ok(coordinator.getState().committedText.startsWith(afterPause), 'confirmed text is append-only through stop');
assert.ok(coordinator.getState().lastDrain, 'drain recorded on the coordinator');

const snapshot = coordinator.getState();
const restored = createTranscriptCoordinator();
restored.hydrate('e2e', snapshot.generation, snapshot.finals.map((segment) => ({ ...segment })));
assert.equal(restored.getState().committedText, snapshot.committedText);
assert.equal(restored.getState().provisionalText, '');
assert.equal(restored.getState().finals.length, snapshot.finals.length);
assert.ok(session.stats.finalsEmitted >= 2, `expected ≥2 finals, got ${session.stats.finalsEmitted}`);

asr.cleanup();
ui.cleanup();
console.log(`ok - e2e start/pause/stop persist (“${snapshot.committedText}”)`);
console.log('\n1 e2e session test passed');
