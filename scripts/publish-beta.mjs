#!/usr/bin/env node
// Upload only the built beta. Verify its checksum on ai-server before replacing the manifest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
const root = process.cwd();
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid version');
const name = `Openwhispr-${version}-arm64.dmg`;
const local = path.join(root, 'release/current', name);
// A failed/unsigned build must never become the advertised current download.
execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(root, 'release/current/mac-arm64/Openwhispr.app')], {stdio:'inherit'});
const sha256 = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(local)) sha256.update(chunk);
const digest = sha256.digest('hex');
const manifest = { version, file: `/releases/${name}`, bytes: fs.statSync(local).size, sha256: digest, signature: 'adhoc', architecture: 'arm64', minimumMacOS: '14.2', notarized: false };
const localManifest = path.join(root, 'release/current/latest.json');
fs.writeFileSync(localManifest, JSON.stringify(manifest, null, 2) + '\n');
function run(command, args, input) {
 const r = spawnSync(command, args, {stdio: input ? ['pipe','inherit','inherit'] : 'inherit', input});
 if (r.status !== 0) throw new Error(`${command} failed (${r.status})`);
}
run('ssh', ['ai-server', 'mkdir -p /srv/apps/openwhispr/releases']);
run('rsync', ['-av', '--partial', local, `ai-server:/srv/apps/openwhispr/releases/${name}.pending`]);
run('rsync', ['-av', localManifest, 'ai-server:/srv/apps/openwhispr/releases/latest.json.pending']);
run('ssh', ['ai-server', `cd /srv/apps/openwhispr/releases && sha256sum --check - && if [ -f '${name}' ]; then cmp -s '${name}' '${name}.pending' || exit 1; fi && mv '${name}.pending' '${name}' && if [ -f latest.json ]; then cp latest.json latest.json.previous; fi && mv latest.json.pending latest.json`], `${digest}  ${name}.pending\n`);
console.log(`Published ${manifest.file} (${manifest.bytes} bytes, SHA-256 verified)`);
