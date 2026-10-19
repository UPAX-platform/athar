import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../test/fixtures/kit/', import.meta.url));
for (const entry of ['@sveltejs/kit/svelte-kit.js', 'vite/bin/vite.js']) {
  const script = fileURLToPath(new URL(`../node_modules/${entry}`, import.meta.url));
  execFileSync(process.execPath, [script, entry.startsWith('@sveltejs') ? 'sync' : 'build'], { cwd, stdio: 'inherit' });
}
