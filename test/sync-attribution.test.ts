import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const exec = promisify(execFile);
const catalogue = { version: 1, internal_note: 'private-metadata', params: [
  { param: 'click', aliases: ['alias'], class: 'identifier', canonical: 'click_id', internal_policy: 'private-metadata' },
] };
let directory: string;
let server: Server | undefined;
const target = () => join(directory, 'src/attribution-params.ts');
function sync(source?: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.ATHAR_ATTRIBUTION_SOURCE;
  if (source !== undefined) env.ATHAR_ATTRIBUTION_SOURCE = source;
  return exec(process.execPath, [join(directory, 'scripts/sync-attribution.mjs'), ...args], { env });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'athar-catalogue-'));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'src'));
  await copyFile(new URL('../scripts/sync-attribution.mjs', import.meta.url), join(directory, 'scripts/sync-attribution.mjs'));
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  await rm(directory, { recursive: true, force: true });
});
it('requires an explicit environment source', async () => {
  await expect(sync()).rejects.toThrow('Set ATHAR_ATTRIBUTION_SOURCE');
});
it('syncs from an environment file path, excludes nonpublic fields, and detects drift without writing', async () => {
  const source = join(directory, 'catalogue.json');
  await writeFile(source, JSON.stringify(catalogue));
  await sync(source);
  const generated = await readFile(target(), 'utf8');
  expect(generated).toContain('"aliases"');
  expect(generated).not.toContain('private-metadata');
  await sync(source, '--check');
  await writeFile(target(), 'stale');
  await expect(sync(source, '--check')).rejects.toThrow('has drifted');
  expect(await readFile(target(), 'utf8')).toBe('stale');
});
it('fetches the catalogue from an environment URL and rejects HTTP failures without overwriting', async () => {
  let status = 200;
  server = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(catalogue));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  const source = `http://127.0.0.1:${address.port}/catalogue.json`;
  await sync(source);
  await sync(source, '--check');
  const generated = await readFile(target(), 'utf8');
  status = 503;
  await expect(sync(source)).rejects.toThrow('HTTP 503');
  expect(await readFile(target(), 'utf8')).toBe(generated);
});
it('rejects malformed catalogues before overwriting the snapshot', async () => {
  const source = join(directory, 'catalogue.json');
  await writeFile(target(), 'existing');
  for (const invalid of [{ version: 2 }, { version: 1, params: [] }, { version: 1, params: [{ param: 'click' }] }]) {
    await writeFile(source, JSON.stringify(invalid));
    await expect(sync(source)).rejects.toThrow();
    expect(await readFile(target(), 'utf8')).toBe('existing');
  }
});
