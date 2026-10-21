import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

export default defineConfig({
  resolve: {
    conditions: ['browser'],
    alias: {
      '@upax/athar/browser': fileURLToPath(new URL('./src/browser.ts', import.meta.url)),
      '@upax/athar/react': fileURLToPath(new URL('./src/react.tsx', import.meta.url)),
      '@upax/athar/svelte': fileURLToPath(new URL('./src/svelte.ts', import.meta.url)),
      '$app/navigation': fileURLToPath(new URL('./test/fixtures/kit-navigation.ts', import.meta.url)),
    },
  },
  plugins: [{
    name: 'test-svelte-components',
    transform(source, id) {
      if (!id.endsWith('.svelte')) return;
      const { js } = compile(source, { filename: id, generate: 'client' });
      return { code: js.code, map: js.map };
    },
  }],
  test: { restoreMocks: true, exclude: ['test/browser/**', '**/node_modules/**', '**/dist/**'] },
});
