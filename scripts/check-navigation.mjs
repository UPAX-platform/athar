// Real-framework navigation checks: builds a fixture against the compiled SDK, serves it, drives it
// in Chromium with the collector stubbed, and asserts which document each page_view credits.
// Run `npm run build` first. Needs Chromium (`npx playwright install chromium`) and local ports.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const bin = entry => fileURLToPath(new URL(`node_modules/${entry}`, root));
const fixture = name => fileURLToPath(new URL(`test/fixtures/${name}/`, root));
const doc = letter => `d_${letter.repeat(24)}`;
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1' };
const only = process.argv[2];

async function serve(args, cwd, port) {
  const server = spawn(process.execPath, args, { cwd, env, stdio: 'ignore' });
  for (let attempt = 0; attempt < 150; attempt++) {
    try { await fetch(`http://localhost:${port}/`); return server; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  server.kill();
  throw new Error(`Server on ${port} did not start`);
}

/** Opens `from`, follows `link`, and returns every page_view with the meta on the page as it was sent. */
async function drive(browser, base, from, link, to) {
  const page = await browser.newPage();
  const views = [];
  await page.route('https://collector.example/**', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.url().endsWith('/ev')) {
      for (const event of JSON.parse(request.postData()).events) if (event.name === 'page_view') views.push(event);
    }
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  });
  const flush = () => page.evaluate(() => window.athar?.flush());
  await page.goto(base + from);
  await page.waitForFunction(() => window.athar);
  // The arrival's metadata can stream in after load; let it land so the navigation starts from a settled page.
  await page.waitForFunction(() => document.querySelector('meta[name="folio:doc"]'), null, { timeout: 8000 });
  // Long enough for the links' prefetches, whose shell can make the navigation commit at once.
  await page.waitForTimeout(1000);
  await flush();
  await page.evaluate(() => { window.softNavigation = true; });
  await page.click(link);
  await page.waitForURL(`**${to}`);
  // Long enough for streamed metadata (1 s) and a slow page (1.5 s) to land before the check.
  await page.waitForTimeout(2500);
  await flush();
  if (!await page.evaluate(() => window.softNavigation)) throw new Error(`${link} reloaded the page instead of navigating client-side`);
  const path = await page.evaluate(() => document.querySelector('meta[name="folio:path"]')?.content);
  if (!path?.replace(/\/$/, '').endsWith(to)) throw new Error(`${to} rendered folio:path ${path}`);
  const rendered = await page.evaluate(() => [...document.querySelectorAll('meta[name="folio:doc"]')].map(meta => meta.content));
  await page.close();
  return { views, rendered };
}

const failures = [];
function verdict(framework, label, result, to, expected, { expectFail = false } = {}) {
  // A known failure can also fail on arrival; it is judged by the navigation alone.
  const arrival = result.views.filter(view => new URL(view.url).pathname === to);
  const first = result.views[0];
  if (!expectFail && first?.props.doc !== doc('a')) {
    console.log(`FAIL ${framework} ${label}: first view credited ${first?.props.doc ?? '(none)'}, title ${JSON.stringify(first?.props.title)}`);
    failures.push(`${framework} ${label} first view`);
  }
  const credited = arrival.map(view => view.props.doc ?? '(none)');
  const titles = arrival.map(view => view.props.title);
  const pass = arrival.length === 1 && credited[0] === expected;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${framework} ${label}: credited ${credited.join(',') || '(no view)'}; title ${JSON.stringify(titles)}; on page ${result.rendered.join(',') || '(no meta)'}`);
  if (pass === expectFail) failures.push(`${framework} ${label}`);
}

const scenarios = {
  async next(browser) {
    execFileSync(process.execPath, [bin('next/dist/bin/next'), 'build'], { cwd: fixture('next-nav'), env, stdio: 'pipe' });
    const server = await serve([bin('next/dist/bin/next'), 'start', '-p', '4411'], fixture('next-nav'), 4411);
    try {
      for (const route of ['constant', 'static', 'dynamic', 'body', 'streamed', 'streamed-prefetch', 'streamed-loading', 'auto-loading']) {
        const result = await drive(browser, 'http://localhost:4411', `/${route}/a`, `#${route}-b`, `/${route}/b`);
        verdict('next', route, result, `/${route}/b`, doc('b'));
      }
      // Known limit, documented in the README: a hand-rendered title hides that metadata is pending.
      const limit = await drive(browser, 'http://localhost:4411', '/layout-title/a', '#layout-title-b', '/layout-title/b');
      verdict('next', 'layout-title (known limit)', limit, '/layout-title/b', doc('b'), { expectFail: true });
    } finally { server.kill(); }
  },
  async sveltekit(browser) {
    const cwd = fixture('kit');
    execFileSync(process.execPath, [bin('@sveltejs/kit/svelte-kit.js'), 'sync'], { cwd, env, stdio: 'pipe' });
    execFileSync(process.execPath, [bin('vite/bin/vite.js'), 'build'], { cwd, env, stdio: 'pipe' });
    const server = await serve([bin('vite/bin/vite.js'), 'preview', '--port', '4412', '--strictPort'], cwd, 4412);
    try {
      verdict('sveltekit', 'afterNavigate', await drive(browser, 'http://localhost:4412', '/doc/a', '#doc-b', '/doc/b'), '/doc/b', doc('b'));
    } finally { server.kill(); }
  },
  async astro(browser) {
    const cwd = fixture('astro-nav');
    execFileSync(process.execPath, [bin('astro/bin/astro.mjs'), 'build'], { cwd, env, stdio: 'pipe' });
    const server = await serve([bin('astro/bin/astro.mjs'), 'preview', '--port', '4413'], cwd, 4413);
    try {
      verdict('astro', 'ClientRouter', await drive(browser, 'http://localhost:4413', '/a', '#doc-b', '/b'), '/b', doc('b'));
    } finally { server.kill(); }
  },
};

const browser = await chromium.launch();
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (!only || only === name) await run(browser);
  }
} finally { await browser.close(); }
if (failures.length) { console.error(`Unexpected navigation results: ${failures.join('; ')}`); process.exit(1); }
console.log('Navigation checks passed.');
