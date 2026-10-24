#!/usr/bin/env node
/**
 * Prepares the local ASR stack (macOS Apple Silicon):
 *   1. builds tools/macos-asr-helper (Swift, FluidAudio pinned) unless the binary exists (or --rebuild),
 *   2. strips Gatekeeper quarantine and ad-hoc signs the helper binary,
 *   3. downloads the Parakeet TDT 0.6B v3 Core ML models into .local/models/,
 *   4. prints a JSON status with the binary SHA-256 and the whisper.cpp fallback availability.
 *
 *   node scripts/asr-setup.mjs [--check] [--rebuild] [--skip-models]
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const helperDir = path.join(root, 'tools', 'macos-asr-helper');
const helperPath = path.join(helperDir, '.build', 'release', 'openwhispr-asr-helper');
const modelDir = path.join(root, '.local', 'models', 'parakeet-tdt-0.6b-v3');
const whisperCli = path.join(root, '.local', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const whisperServer = path.join(root, '.local', 'whisper.cpp', 'build', 'bin', 'whisper-server');
const whisperModel = path.join(root, '.local', 'models', 'ggml-large-v3-turbo.bin');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`The Parakeet helper targets macOS on Apple Silicon (found ${process.platform}/${process.arch}).`);
  process.exit(args.has('--check') ? 0 : 1);
}

if (args.has('--check')) {
  printStatus();
  process.exit(0);
}

if (!fs.existsSync(helperPath) || args.has('--rebuild')) {
  console.log('Building ASR helper (swift build -c release)…');
  const build = spawnSync('swift', ['build', '-c', 'release'], { cwd: helperDir, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('swift build failed. Install the Xcode Command Line Tools (xcode-select --install) and retry.');
    process.exit(1);
  }
}

// Gatekeeper: binaries copied from another machine/browser carry com.apple.quarantine; ad-hoc signing keeps
// the hardened-runtime check happy for local runs. Both are no-ops when already clean.
spawnSync('xattr', ['-dr', 'com.apple.quarantine', helperPath], { stdio: 'ignore' });
const sign = spawnSync('codesign', ['--force', '--sign', '-', helperPath], { encoding: 'utf8' });
if (sign.status !== 0) console.warn(`codesign (ad-hoc) warning: ${sign.stderr.trim()}`);

if (!args.has('--skip-models')) {
  console.log(`Ensuring Parakeet models in ${modelDir} …`);
  const download = spawnSync(helperPath, ['--download', '--model-dir', modelDir], { encoding: 'utf8' });
  const lines = (download.stdout ?? '').split('\n').filter(Boolean);
  const last = lines.length ? safeJson(lines[lines.length - 1]) : null;
  if (download.status !== 0) {
    console.error(`Model download failed: ${last?.message ?? download.stderr}`);
    process.exit(1);
  }
  console.log(last?.type === 'downloaded' ? 'Models ready.' : `Helper said: ${lines[lines.length - 1]}`);
}

printStatus();

function printStatus() {
  const helperPresent = fs.existsSync(helperPath);
  let check = null;
  if (helperPresent) {
    const run = spawnSync(helperPath, ['--check', '--model-dir', modelDir], { encoding: 'utf8' });
    check = safeJson((run.stdout ?? '').trim().split('\n').pop() ?? '');
  }
  const status = {
    helper: {
      path: helperPath,
      present: helperPresent,
      sha256: helperPresent ? sha256(helperPath) : null,
      version: check?.helperVersion ?? null,
      engine: check?.engine ?? null,
    },
    models: {
      dir: modelDir,
      present: Boolean(check?.modelsPresent),
    },
    whisperFallback: {
      cli: fs.existsSync(whisperCli),
      server: fs.existsSync(whisperServer),
      model: fs.existsSync(whisperModel),
    },
    ok: helperPresent && Boolean(check?.modelsPresent),
  };
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) {
    console.log('\nNot ready. Run: npm run asr:setup');
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
