import { spawnSync } from 'node:child_process';

const model = 'gemma3:4b';

console.log(`Pulling ${model} with Ollama...`);
const result = spawnSync('ollama', ['pull', model], { stdio: 'inherit' });

if (result.error) {
  console.error(`Failed to run Ollama: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

