import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const whisperRoot = path.join(root, '.local', 'whisper.cpp');
const modelsDir = path.join(root, '.local', 'models');
const cliPath = process.platform === 'win32'
  ? path.join(whisperRoot, 'build', 'bin', 'Release', 'whisper-cli.exe')
  : path.join(whisperRoot, 'build', 'bin', 'whisper-cli');
const modelCandidates = ['large-v3-turbo', 'small', 'base'].map((name) => ({
  name,
  path: path.join(modelsDir, `ggml-${name}.bin`),
}));
const activeModel = modelCandidates.find((candidate) => fs.existsSync(candidate.path));

const checks = [
  ['ffmpeg', commandExists('ffmpeg'), 'Install ffmpeg and ensure it is on PATH.'],
  ['whisper-cli', fs.existsSync(cliPath), `Run npm run whisper:setup. Expected: ${cliPath}`],
  ['whisper model', Boolean(activeModel), `Run npm run whisper:setup:turbo. Expected one of: ${modelCandidates.map((candidate) => candidate.path).join(', ')}`],
];

let ok = true;
for (const [name, passed, hint] of checks) {
  if (passed) {
    console.log(`✓ ${name}`);
  } else {
    ok = false;
    console.error(`✗ ${name}: ${hint}`);
  }
}

if (ok) {
  const result = spawnSync(cliPath, ['--help'], { encoding: 'utf8' });
  if (result.status === 0 || result.stdout || result.stderr) {
    console.log('✓ whisper setup ready');
    console.log(`  cli: ${cliPath}`);
    console.log(`  model: ${activeModel.name} (${activeModel.path})`);
    modelCandidates
      .filter((candidate) => candidate !== activeModel && fs.existsSync(candidate.path))
      .forEach((candidate) => console.log(`  fallback: ${candidate.name} (${candidate.path})`));
    process.exit(0);
  }
  console.error('✗ whisper-cli did not run correctly.');
}

process.exit(1);

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { stdio: 'ignore' });
  return result.status === 0;
}
