import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const whisperRoot = path.join(root, '.local', 'whisper.cpp');
const modelsDir = path.join(root, '.local', 'models');
const downloader = path.join(whisperRoot, 'models', process.platform === 'win32' ? 'download-ggml-model.cmd' : 'download-ggml-model.sh');

if (!fs.existsSync(downloader)) {
  console.error(`Missing whisper.cpp downloader. Run npm run whisper:setup first. Expected: ${downloader}`);
  process.exit(1);
}

fs.mkdirSync(modelsDir, { recursive: true });

for (const model of ['small', 'large-v3-turbo']) {
  const expected = path.join(modelsDir, `ggml-${model}.bin`);
  if (fs.existsSync(expected)) {
    console.log(`✓ ${model} already exists at ${expected}`);
    continue;
  }

  console.log(`Downloading ${model} into ${modelsDir}`);
  const command = process.platform === 'win32' ? 'cmd' : 'bash';
  const args = process.platform === 'win32' ? ['/c', downloader, model, modelsDir] : [downloader, model, modelsDir];
  const result = spawnSync(command, args, { cwd: whisperRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('✓ Whisper turbo setup ready');
