import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const localDir = path.join(root, '.local');
const whisperRoot = path.join(localDir, 'whisper.cpp');
const modelsDir = path.join(localDir, 'models');
const repoUrl = 'https://github.com/ggml-org/whisper.cpp.git';

fs.mkdirSync(localDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });

if (!fs.existsSync(whisperRoot)) {
  run('git', ['clone', '--depth', '1', repoUrl, whisperRoot], root);
} else {
  run('git', ['pull', '--ff-only'], whisperRoot);
}

run('cmake', ['-B', 'build', '-S', '.', '-DCMAKE_BUILD_TYPE=Release'], whisperRoot);
run('cmake', ['--build', 'build', '--config', 'Release', '-j'], whisperRoot);

const modelPath = path.join(modelsDir, 'ggml-base.bin');
if (!fs.existsSync(modelPath)) {
  const downloader = path.join(whisperRoot, 'models', process.platform === 'win32' ? 'download-ggml-model.cmd' : 'download-ggml-model.sh');
  if (process.platform === 'win32') {
    run('cmd', ['/c', downloader, 'base', modelsDir], whisperRoot);
  } else {
    run('bash', [downloader, 'base', modelsDir], whisperRoot);
  }
}

console.log('\nWhisper setup complete.');
console.log(`Model: ${modelPath}`);

function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

