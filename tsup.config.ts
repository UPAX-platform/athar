import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/browser.ts', 'src/react.tsx', 'src/vue.ts', 'src/angular.ts',
    'src/svelte.ts', 'src/sveltekit.ts', 'src/next.tsx', 'src/astro.ts'],
  format: ['esm', 'cjs'],
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  clean: true,
  splitting: false,
  external: ['react', 'react/jsx-runtime', '@upax/athar/react', 'vue', '@angular/core', '@angular/common',
    '@angular/router', 'svelte', '$app/navigation', 'next/navigation.js'],
  // Preserve the React Server Components boundary after bundling.
  esbuildPlugins: [{
    name: 'react-client-boundary',
    setup(build) {
      build.onEnd(result => {
        for (const file of result.outputFiles ?? []) {
          if (/\/(react|next)\.(js|cjs)$/.test(file.path)) {
            file.contents = new TextEncoder().encode(`"use client";\n${file.text}`);
          }
        }
      });
    },
  }],
});
