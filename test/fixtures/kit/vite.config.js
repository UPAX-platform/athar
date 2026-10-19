import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';

export default {
  plugins: [sveltekit()],
  resolve: { alias: { '@upax/athar/sveltekit': fileURLToPath(new URL('../../../dist/sveltekit.js', import.meta.url)) } },
};
