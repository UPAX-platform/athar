import { readFile, writeFile } from 'node:fs/promises';
const source = process.argv.slice(2).find(arg => arg !== '--check') ?? 'attribution-params.json';
const catalogue = JSON.parse(await readFile(source, 'utf8'));
if (catalogue.version !== 1) throw new Error('Unsupported attribution catalogue version');
const output = '// Generated from platform attribution-params.json; run node scripts/sync-attribution.mjs.\n'
  + 'export const attributionParams = ' + JSON.stringify(catalogue.params, null, 2) + ' as const;\n';
const target = new URL('../src/attribution-params.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Attribution catalogue has drifted; run sync-attribution.mjs');
} else await writeFile(target, output);
