#!/usr/bin/env node
// Reproducible Apple Silicon beta: current source + local model, without personal context or build caches.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build this beta on an Apple Silicon Mac.');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-beta-'));
const resources = path.join(staging, 'app-assets');
const copy = (source, relative) => {
  const target = path.join(resources, relative);
  if (!fs.existsSync(source)) throw new Error(`Required runtime asset missing: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, dereference: true });
};
for (const [dir, binary] of [['macos-asr-helper', 'openwhispr-asr-helper'], ['macos-system-audio-helper', 'openwhispr-system-audio-helper'], ['macos-coreaudio-tap-helper', 'openwhispr-coreaudio-tap-helper']]) {
  copy(path.join(root, 'tools', dir, '.build', 'release', binary), `tools/${dir}/.build/release/${binary}`);
}
copy(path.join(root, 'tools/macos-asr-helper/.build/release/FluidAudio_FluidAudio.bundle'), 'tools/macos-asr-helper/.build/release/FluidAudio_FluidAudio.bundle');
copy(path.join(root, '.local/models/parakeet-tdt-0.6b-v3'), '.local/models/parakeet-tdt-0.6b-v3');
const context = JSON.parse(fs.readFileSync(path.join(root, 'config/transcription-context.json'), 'utf8'));
context.peopleAliases = [];
delete context.domains.businessBanking;
fs.mkdirSync(path.join(resources, 'config'), { recursive: true });
fs.writeFileSync(path.join(resources, 'config/transcription-context.json'), JSON.stringify(context, null, 2));
const config = { ...pkg.build, afterPack: path.join(root, 'scripts/sign-beta.cjs'), publish: null, directories: { output: 'release/current' },
  extraResources: [{ from: resources, to: 'app-assets', filter: ['**/*'] }],
  mac: { ...pkg.build.mac, icon: path.join(root, 'build/Openwhispr.icns'), target: [{ target: 'dmg', arch: ['arm64'] }], identity: null, minimumSystemVersion: '14.2', extendInfo: {
    NSMicrophoneUsageDescription: 'Openwhispr uses your microphone to transcribe meetings locally.',
    NSScreenCaptureUsageDescription: 'Openwhispr captures system audio for local meeting transcription.',
    NSAudioCaptureUsageDescription: 'Openwhispr captures system audio for local meeting transcription.'
  }}
};
const configPath = path.join(staging, 'builder.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
for (const [command, args] of [['npm', ['run', 'build']], [process.execPath, ['scripts/check-packaged-assets.mjs']], [process.execPath, ['node_modules/electron-builder/cli.js', '--mac', '--arm64', '--publish', 'never', '--config', configPath]]]) {
 const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
 if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Beta ${pkg.version} built in release/current; staging: ${staging}`);
