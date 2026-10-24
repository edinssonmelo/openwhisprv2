import assert from 'node:assert/strict';
import path from 'node:path';
import { loadTsModules } from './lib/load-ts.mjs';

const root = process.cwd();
const modules = loadTsModules(
  [path.join(root, 'src', 'transcription', 'types.ts'), path.join(root, 'src', 'transcription', 'transcriptCoordinator.ts')],
  'openwhispr-coordinator-test',
);
const { createTranscriptCoordinator, describeEngine } = await modules.import('transcriptCoordinator');

const S = 'session-1';
const base = (segmentId, source = 'mic', generation = 1) => ({ sessionId: S, generation, source, segmentId });
const preview = (segmentId, text, extra = {}) => ({
  type: 'preview', ...base(segmentId, extra.source), text, startMs: extra.startMs ?? 0, endMs: extra.endMs ?? 1000,
  engine: 'parakeet-tdt-0.6b-v3', latencyMs: 120, ...extra,
});
const final = (segmentId, text, extra = {}) => ({
  type: 'final', ...base(segmentId, extra.source), text, startMs: extra.startMs ?? 0, endMs: extra.endMs ?? 1000,
  engine: extra.engine ?? 'parakeet-tdt-0.6b-v3', latencyMs: 300, audioMs: 1000, viaFallback: extra.viaFallback ?? false, ...extra,
});

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test('short phrase: preview then final commits once and clears preview', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent({ type: 'segment-open', ...base('a'), startMs: 0 });
  c.applyEvent(preview('a', 'yes that'));
  assert.equal(c.getState().visibleText, 'yes that');
  assert.equal(c.getState().provisionalText, 'yes that');
  c.applyEvent(preview('a', 'yes that works'));
  assert.equal(c.getState().visibleText, 'yes that works', 'preview is replaced, never appended');
  c.applyEvent(final('a', 'Yes, that works for me.'));
  const state = c.getState();
  assert.equal(state.committedText, 'Yes, that works for me.');
  assert.equal(state.provisionalText, '');
  assert.equal(state.visibleText, 'Yes, that works for me.');
  assert.equal(state.finals.length, 1);
});

test('divergent previews never touch committed text', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(final('a', 'first sentence.'));
  c.applyEvent(preview('b', 'hello how are'));
  c.applyEvent(preview('b', 'completely different noise'));
  const state = c.getState();
  assert.equal(state.committedText, 'first sentence.');
  assert.equal(state.provisionalText, 'completely different noise');
  assert.equal(state.provisional[0].revisions, 2);
});

test('empty final removes preview without committing', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'hmm'));
  c.applyEvent(final('a', ''));
  assert.equal(c.getState().visibleText, '');
  assert.equal(c.getState().stats.emptyFinals, 1);
});

test('late preview after final is rejected as stale', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(final('a', 'done.'));
  const result = c.applyEvent(preview('a', 'don'));
  assert.equal(result.applied, false);
  assert.equal(c.getState().visibleText, 'done.');
  assert.equal(c.getState().stats.staleRejected, 1);
});

test('duplicate final is ignored (append-only, immutable)', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(final('a', 'once.'));
  c.applyEvent(final('a', 'once again.'));
  assert.equal(c.getState().committedText, 'once.');
  assert.equal(c.getState().stats.duplicateFinals, 1);
});

test('events from another session or generation are rejected', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 2);
  assert.equal(c.applyEvent({ ...final('a', 'old'), generation: 1 }).applied, false);
  assert.equal(c.applyEvent({ ...final('b', 'other'), sessionId: 'other' }).applied, false);
  assert.equal(c.applyEvent({ ...final('c', 'current'), generation: 2 }).applied, true);
  assert.equal(c.getState().committedText, 'current');
  assert.equal(c.getState().stats.staleRejected, 2);
});

test('generation bump keeps finals, clears previews, invalidates old generation', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(final('a', 'kept.'));
  c.applyEvent(preview('b', 'in progress'));
  c.bumpGeneration(2);
  assert.equal(c.getState().committedText, 'kept.');
  assert.equal(c.getState().provisionalText, '');
  assert.equal(c.applyEvent({ ...final('b', 'late from gen 1'), generation: 1 }).applied, false);
  assert.equal(c.applyEvent({ ...final('c', 'gen 2'), generation: 2 }).applied, true);
  assert.equal(c.getState().committedText, 'kept. gen 2');
});

test('new session clears everything', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(final('a', 'old session'));
  c.beginSession('session-2', 1);
  assert.equal(c.getState().visibleText, '');
  assert.equal(c.applyEvent({ ...final('a', 'reused id in new session'), sessionId: 'session-2' }).applied, true, 'segment ids are scoped per session');
});

test('simultaneous mic and system previews are both visible, mic first, finals in arrival order', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('sys-1', 'they said', { source: 'system', startMs: 0 }));
  c.applyEvent(preview('mic-1', 'I said', { source: 'mic', startMs: 200 }));
  assert.equal(c.getState().provisionalText, 'I said they said');
  c.applyEvent(final('sys-1', 'They said hello.', { source: 'system' }));
  assert.equal(c.getState().visibleText, 'They said hello. I said');
  c.applyEvent(final('mic-1', 'I said hi.', { source: 'mic' }));
  assert.equal(c.getState().visibleText, 'They said hello. I said hi.');
  assert.deepEqual(c.getState().finals.map((f) => f.source), ['system', 'mic']);
});

test('segment-dropped clears its preview', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'noise'));
  c.applyEvent({ type: 'segment-dropped', ...base('a'), startMs: 0, endMs: 200, reason: 'too-short' });
  assert.equal(c.getState().visibleText, '');
  assert.equal(c.applyEvent(preview('a', 'late')).applied, false, 'dropped segment cannot come back');
});

test('drained clears previews and records the drain report', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'pending'));
  c.applyEvent(final('a', 'flushed on stop.'));
  c.applyEvent({ type: 'drained', sessionId: S, generation: 1, finalsFlushed: 1, finalsFailed: 0, previewsCancelled: 1, timedOut: false, elapsedMs: 420 });
  assert.equal(c.getState().visibleText, 'flushed on stop.');
  assert.equal(c.getState().lastDrain.finalsFlushed, 1);
});

test('engine labels reflect the engines that actually produced text', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'live'));
  c.applyEvent(final('a', 'final via whisper', { engine: 'whisper-large-v3-turbo', viaFallback: true }));
  const state = c.getState();
  assert.equal(describeEngine(state.liveEngine), 'Parakeet TDT v3');
  assert.equal(describeEngine(state.finalEngine), 'Whisper Turbo');
  assert.equal(state.fallbackUsed, true);
});

test('subscribe notifies on every state change', () => {
  const c = createTranscriptCoordinator();
  let calls = 0;
  const unsubscribe = c.subscribe(() => {
    calls += 1;
  });
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'x'));
  c.applyEvent(final('a', 'x.'));
  unsubscribe();
  c.applyEvent(final('b', 'y.'));
  assert.equal(calls, 3);
});

test('hydrate restores finals and marks them finalized', () => {
  const c = createTranscriptCoordinator();
  c.hydrate(S, 3, [
    { segmentId: 'r1', source: 'mic', text: 'restored.', startMs: 0, endMs: 1000, engine: 'parakeet-tdt-0.6b-v3', viaFallback: false, receivedAtMs: 1 },
  ]);
  assert.equal(c.getState().visibleText, 'restored.');
  assert.equal(c.applyEvent({ ...final('r1', 'dup'), generation: 3 }).applied, false);
});

test('silence: no events leave empty committed and provisional text', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  assert.equal(c.getState().committedText, '');
  assert.equal(c.getState().provisionalText, '');
  assert.equal(c.getState().visibleText, '');
});

test('clipping is not a coordinator concern: a final still commits', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'loud'));
  c.applyEvent(final('a', 'That was clipped audio.'));
  assert.equal(c.getState().committedText, 'That was clipped audio.');
  assert.equal(c.getState().provisionalText, '');
});

test('late final still appends while a newer segment is previewing', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'first draft'));
  c.applyEvent(preview('b', 'second in progress'));
  c.applyEvent(final('a', 'First sentence.'));
  const state = c.getState();
  assert.equal(state.committedText, 'First sentence.');
  assert.equal(state.provisionalText, 'second in progress');
  assert.equal(state.visibleText, 'First sentence. second in progress');
});

test('stop with pending audio: drain clears leftover preview after the flushed final', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(preview('a', 'trailing words'));
  c.applyEvent(final('a', 'Trailing words committed on stop.'));
  c.applyEvent({
    type: 'drained', sessionId: S, generation: 1,
    finalsFlushed: 1, finalsFailed: 0, previewsCancelled: 1, timedOut: false, elapsedMs: 80,
  });
  assert.equal(c.getState().committedText, 'Trailing words committed on stop.');
  assert.equal(c.getState().provisionalText, '');
  assert.equal(c.getState().lastDrain.timedOut, false);
});

test('persist snapshot after drain hydrates to the exact committed text', () => {
  const c = createTranscriptCoordinator();
  c.beginSession(S, 1);
  c.applyEvent(final('a', 'Hello from the meeting.'));
  c.applyEvent(preview('b', 'should not persist'));
  c.applyEvent({
    type: 'drained', sessionId: S, generation: 1,
    finalsFlushed: 1, finalsFailed: 0, previewsCancelled: 1, timedOut: false, elapsedMs: 12,
  });
  const snapshot = c.getState();
  const restored = createTranscriptCoordinator();
  restored.hydrate(S, snapshot.generation, snapshot.finals.map((segment) => ({ ...segment })));
  assert.equal(restored.getState().committedText, 'Hello from the meeting.');
  assert.equal(restored.getState().provisionalText, '');
  assert.equal(restored.getState().visibleText, snapshot.committedText);
});

modules.cleanup();
console.log(`\n${passed} coordinator tests passed`);
