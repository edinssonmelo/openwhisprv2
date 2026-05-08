import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-transcript-store-'));
const sourceFiles = [
  path.join(root, 'src', 'transcription', 'types.ts'),
  path.join(root, 'src', 'transcription', 'transcriptStore.ts'),
];

for (const sourcePath of sourceFiles) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  fs.writeFileSync(path.join(outDir, path.basename(sourcePath).replace(/\.ts$/, '.mjs')), compiled.replace('./types', './types.mjs'));
}

const { createTranscriptStore } = await import(path.join(outDir, 'transcriptStore.mjs'));

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 3 });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas ahora mismo' });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas bien ahora' });
  assert.equal(store.getState().previewSuffix, 'hola como', 'preview hides unstable tail words');
  assert.equal(store.getState().rawPreview, 'hola como estas bien ahora', 'raw preview is kept only as debug state');
}

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 2 });
  store.acceptFinal({ segmentId: 'base', text: 'texto confirmado' });
  store.acceptPreview({ segmentId: 'p', text: 'nuevo texto provisional aqui' });
  store.acceptPreview({ segmentId: 'p', text: 'nuevo texto provisional cambia' });
  assert.equal(store.getState().committedText, 'texto confirmado', 'preview never deletes committed text');
}

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 2 });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas hoy aqui' });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas bien aqui' });
  assert.equal(store.getState().previewSuffix, 'hola como estas', 'similar previews reveal stable progress');
}

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 2 });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas hoy aqui' });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas bien aqui' });
  store.acceptPreview({ segmentId: 'a', text: 'totalmente distinto ruido raro' });
  assert.equal(store.getState().previewSuffix, 'hola como estas', 'very different preview does not replace visible preview');
}

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 2 });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas hoy aqui' });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas bien aqui' });
  store.acceptFinal({ segmentId: 'a', text: 'hola como estas bien' });
  assert.equal(store.getState().committedText, 'hola como estas bien', 'final commits the authoritative text');
  assert.equal(store.getState().visibleText, 'hola como estas bien', 'final does not duplicate text that was already visible as preview');
  assert.equal(store.getState().previewSuffix, '', 'final clears preview suffix');
}

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 2 });
  store.acceptFinal({ segmentId: 'a', text: 'hola como' });
  store.acceptFinal({ segmentId: 'b', text: 'como estas bien' });
  assert.equal(store.getState().committedText, 'hola como estas bien', 'final appends missing text by overlap');
}

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 1 });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas ahora' });
  store.acceptPreview({ segmentId: 'a', text: 'hola como estas bien' });
  assert.equal(store.getState().previewSuffix, 'hola como estas', 'test setup has visible preview');
  store.acceptFinal({ segmentId: 'a', text: 'hola como estas bien' });
  assert.equal(store.getState().visibleText, 'hola como estas bien', 'visible/preview plus final does not duplicate');
}

{
  const store = createTranscriptStore({ hiddenPreviewTailWords: 2 });
  store.acceptPreview({ segmentId: 'a', text: 'primer segmento estable aqui' });
  store.acceptPreview({ segmentId: 'a', text: 'primer segmento estable listo' });
  assert.equal(store.getState().previewSuffix, 'primer segmento', 'first segment preview exists');
  store.acceptPreview({ segmentId: 'b', text: 'segundo segmento nuevo aqui' });
  assert.equal(store.getState().previewSuffix, '', 'segment change resets preview');
  assert.equal(store.getState().segmentId, 'b', 'new segment id is active');
}

console.log('transcriptStore tests passed');
