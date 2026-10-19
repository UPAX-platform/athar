import { attributionParams } from './attribution-params';

const encoder = new TextEncoder();
/** Keep query-key spelling on the wire; the collector resolves canonical conflicts. */
export function filterAttribution(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const result: Record<string, string> = {};
  for (const param of attributionParams) {
    if (param.class !== 'descriptor') continue;
    const value = (input as Record<string, unknown>)[param.param];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    const limit = param.canonical.startsWith('external_') ? 128 : 512;
    if (trimmed && encoder.encode(trimmed).length <= limit) result[param.param] = trimmed;
  }
  return Object.keys(result).length ? result : undefined;
}

export function attributionFromURL(raw: string): Record<string, string> | undefined {
  try {
    const params = new URL(raw).searchParams;
    return filterAttribution(Object.fromEntries([...params.keys()].map(key => [key, params.get(key)])));
  } catch { return undefined; }
}

/** Remove recognized click-ID query parameters even when full queries are enabled. */
export function stripClickIds(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const url = new URL(raw);
    let changed = false;
    for (const param of attributionParams) {
      if (param.class !== 'identifier') continue;
      const keys: readonly string[] = 'aliases' in param ? [param.param, ...param.aliases] : [param.param];
      for (const key of keys) {
        if (url.searchParams.has(key)) { url.searchParams.delete(key); changed = true; }
      }
    }
    return changed ? url.href : raw;
  } catch { return ''; }
}

/** Resolve exactly one identifier claim; aliases of the same kind/value agree. */
export function clickAttribution(input: Record<string, string>): Record<string, string> | undefined {
  let selected: { key: string; value: string } | undefined;
  for (const param of attributionParams) {
    if (param.class !== 'identifier') continue;
    const keys: readonly string[] = 'aliases' in param ? [param.param, ...param.aliases] : [param.param];
    for (const key of keys) {
      const value = typeof input[key] === 'string' ? input[key].trim() : '';
      if (!value || value.includes('\0') || encoder.encode(value).length > 512) continue;
      if (selected && (selected.key !== param.param || selected.value !== value)) return undefined;
      selected = { key: param.param, value };
    }
  }
  return selected ? { ...filterAttribution(input), [selected.key]: selected.value } : undefined;
}

export function queryAttribution(raw: string): Record<string, string> {
  const params = new URL(raw).searchParams;
  const result: Record<string, string> = {};
  for (const key of params.keys()) {
    const values = new Set(params.getAll(key));
    // Repeated conflicting click IDs are not a single arrival.
    if (values.size > 1 && attributionParams.some(p => p.class === 'identifier' &&
      (p.param === key || ('aliases' in p && (p.aliases as readonly string[]).includes(key))))) return {};
    result[key] = params.get(key)!;
  }
  return result;
}
