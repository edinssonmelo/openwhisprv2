import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
const entry = path.resolve('dist/index.html');
const html = fs.readFileSync(entry, 'utf8');
const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
const assets = references.filter(value => !/^(?:https?:|data:|#)/.test(value));
assert.ok(assets.some(value => value.endsWith('.js')), 'Production HTML must load a script');
for (const value of assets) {
 assert.ok(!value.startsWith('/'), `Asset cannot use a server-root path in Electron: ${value}`);
 const file = fileURLToPath(new URL(value, pathToFileURL(entry)));
 assert.ok(fs.existsSync(file), `Packaged asset is missing: ${file}`);
}
console.log(`Packaged file:// asset check passed (${assets.length} assets)`);
