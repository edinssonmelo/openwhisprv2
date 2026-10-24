import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const venv = path.join(root, '.venv-asr');
const python = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');
const pythonUserBase = spawnSync(
  'python3',
  ['-c', 'import site; print(site.getuserbase())'],
  { encoding: 'utf8' },
).stdout?.trim();
const uvCandidates = [
  'uv',
  pythonUserBase ? path.join(pythonUserBase, 'bin', 'uv') : '',
  path.join(process.env.HOME ?? '', 'Library', 'Python', '3.9', 'bin', 'uv'),
  path.join(process.env.HOME ?? '', '.local', 'bin', 'uv'),
].filter(Boolean);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function works(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: 'ignore' }).status === 0;
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('Nemotron MLX currently requires an Apple Silicon Mac.');
  process.exit(1);
}

let uv = uvCandidates.find((candidate) => works(candidate, ['--version']));
if (!uv) {
  run('python3', ['-m', 'pip', 'install', '--user', 'uv']);
  uv = uvCandidates.find((candidate) => works(candidate, ['--version']));
}

if (!uv) {
  console.error('Could not install uv, which is needed to provision Python 3.12.');
  process.exit(1);
}

const existingPythonIsCompatible = fs.existsSync(python)
  && works(python, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)']);
if (!existingPythonIsCompatible) {
  fs.rmSync(venv, { recursive: true, force: true });
  run(uv, ['venv', '--python', '3.12', venv]);
}

run(uv, [
  'pip',
  'install',
  '--python',
  python,
  'git+https://github.com/Blaizzy/mlx-audio.git',
]);

run(python, [path.join(root, 'scripts', 'asr_nemotron_worker.py'), '--check']);

console.log('\nNemotron runtime installed.');
console.log('The 8-bit model is downloaded and ready.');
