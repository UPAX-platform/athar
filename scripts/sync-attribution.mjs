import { readFile, writeFile } from 'node:fs/promises';

const source = process.env.ATHAR_ATTRIBUTION_SOURCE?.trim();
if (!source) throw new Error('Set ATHAR_ATTRIBUTION_SOURCE to a catalogue file path or HTTP(S) URL');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Only --check is supported; configure ATHAR_ATTRIBUTION_SOURCE');

let text;
if (/^https?:\/\//i.test(source)) {
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Catalogue request failed: HTTP ${response.status}`);
  text = await response.text();
} else {
  text = await readFile(source, 'utf8');
}
const catalogue = JSON.parse(text);
if (catalogue.version !== 1) throw new Error('Unsupported attribution catalogue version');
if (!Array.isArray(catalogue.params) || !catalogue.params.length) throw new Error('Invalid attribution catalogue parameters');
// Generate only public contract fields, even if the source includes other metadata.
const params = catalogue.params.map(entry => {
  if (!entry || typeof entry.param !== 'string' || !entry.param.trim()
    || !['identifier', 'descriptor'].includes(entry.class)
    || typeof entry.canonical !== 'string' || !entry.canonical.trim()
    || (entry.aliases !== undefined && (!Array.isArray(entry.aliases)
      || entry.aliases.some(alias => typeof alias !== 'string' || !alias.trim())))) {
    throw new Error('Invalid attribution catalogue entry');
  }
  return { param: entry.param, ...(entry.aliases === undefined ? {} : { aliases: entry.aliases }),
    class: entry.class, canonical: entry.canonical };
});
const output = '// Generated from the public attribution catalogue; run node scripts/sync-attribution.mjs.\n'
  + 'export const attributionParams = ' + JSON.stringify(params, null, 2) + ' as const;\n';
const target = new URL('../src/attribution-params.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Attribution catalogue has drifted; run sync-attribution.mjs');
} else await writeFile(target, output);
