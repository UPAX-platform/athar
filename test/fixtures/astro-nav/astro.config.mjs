import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

const dist = name => fileURLToPath(new URL(`../../../dist/${name}.js`, import.meta.url));

export default defineConfig({
  devToolbar: { enabled: false },
  vite: { resolve: { alias: { '@upax-ai/athar/astro': dist('astro'), '@upax-ai/athar/browser': dist('browser'), '@upax-ai/athar/folio': dist('folio') } } },
});
