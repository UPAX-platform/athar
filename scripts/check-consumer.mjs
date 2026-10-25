import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = mkdtempSync(join(tmpdir(), 'athar-consumer-'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
try {
  const [archive] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], { cwd: root, encoding: 'utf8' }));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', join(consumer, archive.filename)], { cwd: consumer, stdio: 'pipe' });
  writeFileSync(join(consumer, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { createClient } from '@upax-ai/athar';
    import { createBrowserClient } from '@upax-ai/athar/browser';
    import { installAthar } from '@upax-ai/athar/astro';
    const require = createRequire(import.meta.url);
    for (const peer of ${JSON.stringify(Object.keys(manifest.peerDependencies))}) assert.throws(() => require.resolve(peer));
    assert.equal(typeof require('@upax-ai/athar').createClient, 'function');
    const payloads = [];
    const client = createClient({ site: 'public-site-token', host: 'https://collector.example', flushInterval: 0,
      fetch: async (_url, init) => { payloads.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    });
    client.track('installed'); await client.shutdown();
    assert.equal(payloads[0].events[0].name, 'installed');
    const browser = createBrowserClient({ site: 'public-site-token', host: 'https://collector.example' });
    browser.start(); assert.equal(browser.pageIfChanged(), false); await browser.shutdown();
    const astro = installAthar({ site: 'public-site-token', host: 'https://collector.example' });
    astro.dispose(); await astro.client.shutdown();
  `);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumer, stdio: 'pipe' });
  console.log('Packed consumer: core/browser/Astro work with no framework installed.');

  // Add only test peers to validate the installed declaration files, not the source tree.
  for (const name of [...Object.keys(manifest.peerDependencies), '@types/react', '@types/node']) {
    const target = join(consumer, 'node_modules', name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(root, 'node_modules', name), target, 'junction');
  }
  const source = `
    import { createClient, type Properties } from '@upax-ai/athar';
    import { createBrowserClient } from '@upax-ai/athar/browser';
    import { AtharProvider } from '@upax-ai/athar/react';
    import { createAtharPlugin } from '@upax-ai/athar/vue';
    import { provideAthar as angular } from '@upax-ai/athar/angular';
    import { provideAthar as svelte } from '@upax-ai/athar/svelte';
    import { provideAthar as sveltekit } from '@upax-ai/athar/sveltekit';
    import { createNextClient, AtharNextProvider } from '@upax-ai/athar/next';
    import { installAthar } from '@upax-ai/athar/astro';
    const options = { site: 'public-site-token', host: 'https://collector.example' };
    const props: Properties = { amount: 1 };
    createClient(options).track('typed', props);
    const browser = createBrowserClient(options);
    browser.pageIfChanged({ url: 'https://shop.example' });
    AtharProvider({ client: browser });
    createAtharPlugin(options); angular(options); svelte(options); sveltekit(options);
    AtharNextProvider({ client: createNextClient(options) }); installAthar(options);
  `;
  for (const extension of ['mts', 'cts']) writeFileSync(join(consumer, `consumer.${extension}`), source);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--noEmit',
    'consumer.mts', 'consumer.cts'], { cwd: consumer, stdio: 'pipe' });
  console.log('Packed consumer: every adapter typechecks under strict NodeNext ESM and CommonJS.');
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
