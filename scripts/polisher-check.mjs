import { spawnSync } from 'node:child_process';

const model = 'gemma3:4b';
const ollama = spawnSync('ollama', ['list'], { encoding: 'utf8' });

if (ollama.error || ollama.status !== 0) {
  console.error('✗ Ollama is not available or not running. Install/start Ollama, then run npm run polisher:setup.');
  process.exit(1);
}

if (!ollama.stdout.includes(model)) {
  console.error(`✗ Missing ${model}. Run npm run polisher:setup.`);
  process.exit(1);
}

console.log(`✓ Ollama ready`);
console.log(`✓ ${model}`);

