import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

/**
 * Transpiles a small set of TypeScript modules (no type-checking, no bundler) into a temp dir
 * and returns an importer for them. Relative imports between the given files are rewritten to `.mjs`.
 *
 * Node 20 has no type stripping, so scripts/tests use this to exercise pure TS modules from
 * `electron/asr` and `src/transcription` without building the app.
 *
 * @param {string[]} sourcePaths absolute paths; imports between them must be relative (`./x`, `../y/z`).
 * @param {string} [label] tmp dir prefix
 */
export function loadTsModules(sourcePaths, label = 'openwhispr-ts') {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const byName = new Map();
  for (const sourcePath of sourcePaths) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    let compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2020,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: sourcePath,
    }).outputText;
    // Flatten: every module lands in outDir under its basename; rewrite relative specifiers accordingly.
    compiled = compiled.replace(/(from\s+|import\s*\()\s*(['"])(\.{1,2}\/[^'"]+)\2/g, (_match, prefix, quote, spec) => {
      const base = path.basename(spec).replace(/\.(ts|js)$/, '');
      return `${prefix}${quote}./${base}.mjs${quote}`;
    });
    const outName = path.basename(sourcePath).replace(/\.ts$/, '.mjs');
    const outPath = path.join(outDir, outName);
    fs.writeFileSync(outPath, compiled);
    byName.set(path.basename(sourcePath).replace(/\.ts$/, ''), outPath);
  }
  return {
    outDir,
    /** @param {string} name basename without extension */
    import: (name) => {
      const outPath = byName.get(name);
      if (!outPath) throw new Error(`Module not transpiled: ${name}`);
      return import(outPath);
    },
    cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }),
  };
}
