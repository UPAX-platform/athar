import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'Core SDK must remain dependency-free');
for (const name of Object.keys(manifest.peerDependencies)) assert.equal(manifest.peerDependenciesMeta[name]?.optional, true);
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
function checkContent(path) {
  const content = readFileSync(path, 'utf8');
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/.test(content)) {
    throw new Error(`Possible credential in ${path}`);
  }
  if (/(?:\/Users\/|\/home\/|file:\/\/|[.]local\b|[.]internal\b)/.test(content)) {
    throw new Error(`Machine or internal reference in ${path}`);
  }
}
for (const file of sourceFiles) checkContent(file);
for (const dependency of Object.values(JSON.parse(readFileSync('package-lock.json', 'utf8')).packages)) {
  if (dependency.resolved) assert.equal(new URL(dependency.resolved).host, 'registry.npmjs.org', 'Lockfile may use only the public npm registry');
}
for (const file of pack.files) {
  assert.match(file.path, /^(dist\/[^/]+\.(?:js|cjs|d\.ts|d\.cts)|package\.json|README\.md|LICENSE|CHANGELOG\.md)$/,
    `Unexpected publish artifact: ${file.path}`);
  checkContent(file.path);
}
// Native Node imports need Angular's JIT compiler; application builds use Angular's AOT pipeline.
await import('@angular/compiler');
for (const suffix of ['', '/browser', '/react', '/vue', '/angular', '/svelte', '/next', '/astro']) {
  const specifier = manifest.name + suffix;
  assert.ok(Object.keys(await import(specifier)).length, `Empty ESM export: ${specifier}`);
  assert.ok(Object.keys(require(specifier)).length, `Empty CommonJS export: ${specifier}`);
}
for (const extension of ['js', 'cjs']) {
  for (const entry of ['react', 'next']) assert.match(readFileSync(`dist/${entry}.${extension}`, 'utf8'), /^"use client";/);
  assert.match(readFileSync(`dist/sveltekit.${extension}`, 'utf8'), /\$app\/navigation/);
  assert.doesNotMatch(readFileSync(`dist/index.${extension}`, 'utf8'), /from ["']react|require\(["']react/);
}
console.log(`Package checks passed: ${pack.files.length} public files, ESM/CommonJS imports, React boundary, artifact allowlist.`);
