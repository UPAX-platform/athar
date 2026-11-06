// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient, type BrowserOptions } from '../src/browser';
import { folioContext, sendReaction } from '../src/folio';
import type { AnalyticsEvent } from '../src/types';

const docA = 'd_aaaaaaaaaaaaaaaaaaaaaaaa';
const docB = 'd_bbbbbbbbbbbbbbbbbbbbbbbb';

function setMetas(doc?: string, locale?: string, path?: string) {
  document.head.querySelectorAll('meta[name^="folio:"]').forEach(meta => meta.remove());
  for (const [name, content] of [['folio:doc', doc], ['folio:locale', locale], ['folio:path', path]] as const) {
    if (content === undefined) continue;
    const meta = document.createElement('meta');
    meta.name = name; meta.content = content;
    document.head.append(meta);
  }
}
const event = (props: AnalyticsEvent['props'] = {}): AnalyticsEvent => ({ id: 'e', ts: 1, name: 'n', props });

let site = 0;
function setup(options: Partial<BrowserOptions> = {}) {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const client = createBrowserClient({ site: `folio-${++site}`, host: 'https://collector.example', fetch: fetcher,
    flushInterval: 0, autoPageviews: false, beforeSend: folioContext(), ...options });
  const sent = (): AnalyticsEvent[] => fetcher.mock.calls.filter(call => String(call[0]).endsWith('/ev'))
    .flatMap(call => JSON.parse(call[1].body).events);
  return { client, fetcher, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setMetas(); document.body.innerHTML = ''; localStorage.clear(); sessionStorage.clear();
  document.title = ''; history.replaceState({}, '', '/');
});

describe('folioContext', () => {
  it('tags every event and keeps the SDK title on page_view', async () => {
    setMetas(docA, 'en-US');
    document.title = 'Document A';
    const { client, sent } = setup();
    client.page(); client.track('signup', { plan: 'pro' });
    await client.flush();
    expect(sent()[0]).toMatchObject({ name: 'page_view', props: { doc: docA, locale: 'en-US', title: 'Document A' } });
    expect(sent()[1]).toMatchObject({ name: 'signup', props: { doc: docA, locale: 'en-US', plan: 'pro' } });
    await client.shutdown();
  });

  it('reads the metas at send time, never caching them', () => {
    const tag = folioContext();
    setMetas(docA, 'en-US');
    expect(tag(event()).props).toEqual({ doc: docA, locale: 'en-US' });
    setMetas(docB, 'ar-EG');
    expect(tag(event()).props).toEqual({ doc: docB, locale: 'ar-EG' });
    setMetas();
    expect(tag(event()).props).toEqual({});
  });

  it('lets a prop the caller set win, each prop on its own', () => {
    setMetas(docA, 'en-US');
    expect(folioContext()(event({ doc: docB })).props).toEqual({ doc: docB, locale: 'en-US' });
    expect(folioContext()(event({ locale: 'ar-EG' })).props).toEqual({ doc: docA, locale: 'ar-EG' });
  });

  it('passes the event through unchanged without metas or without document', () => {
    const tag = folioContext();
    const untouched = event({ a: 1 });
    expect(tag(untouched)).toBe(untouched);
    setMetas('', '  ');
    expect(tag(untouched)).toBe(untouched);
    setMetas(docA, 'en-US');
    vi.stubGlobal('document', undefined);
    expect(tag(untouched)).toBe(untouched);
  });

  it('adds only the meta that exists and does not mutate the input', () => {
    setMetas(docA);
    const input = event({ a: 1 });
    expect(folioContext()(input).props).toEqual({ doc: docA, a: 1 });
    expect(input.props).toEqual({ a: 1 });
  });

  it('composes with a customer beforeSend: null still drops, in either order', async () => {
    setMetas(docA, 'en-US');
    const tag = folioContext();
    const mine = (value: AnalyticsEvent) => value.name === 'secret' ? null : { ...value, props: { ...value.props, mine: true } };
    for (const beforeSend of [
      (value: AnalyticsEvent) => tag(mine(value)),
      (value: AnalyticsEvent) => mine(tag(value)),
    ]) {
      const { client, sent } = setup({ beforeSend });
      expect(client.track('secret')).toBe(false);
      expect(client.track('kept')).toBe(true);
      await client.flush();
      expect(sent().map(item => item.name)).toEqual(['kept']);
      expect(sent()[0]!.props).toEqual({ doc: docA, locale: 'en-US', mine: true });
      await client.shutdown();
    }
  });

  it('tags data-athar-event clicks with no per-element props, and data-athar-event-doc wins', async () => {
    setMetas(docA, 'en-US');
    document.body.innerHTML = `<button id="plain" data-athar-event="cta_click"></button>
      <button id="custom" data-athar-event="cta_click" data-athar-event-doc="${docB}"></button>`;
    const { client, sent } = setup();
    client.start();
    document.getElementById('plain')!.click();
    document.getElementById('custom')!.click();
    await client.flush();
    expect(sent()[0]).toMatchObject({ name: 'cta_click', props: { doc: docA, locale: 'en-US' } });
    expect(sent()[1]).toMatchObject({ name: 'cta_click', props: { doc: docB, locale: 'en-US' } });
    await client.shutdown();
  });

  it('keeps the largest contract payload under the 2 KiB props limit, on top of a long title', async () => {
    // The contract's longest values: a suffixed id, a 35-character locale and a 64-character value.
    const doc = `d_${'a'.repeat(24)}-999999`;
    setMetas(doc, 'x'.repeat(35));
    document.title = 'T'.repeat(1024);
    const { client, sent } = setup();
    client.page();
    client.track('folio_reaction', { value: 'v'.repeat(64) });
    await client.flush();
    for (const item of sent()) {
      expect(item.props.doc).toBe(doc);
      expect(new TextEncoder().encode(JSON.stringify(item.props)).length).toBeLessThan(2048);
    }
    expect(sent()).toHaveLength(2);
    await client.shutdown();
  });
});

describe('folio:path', () => {
  const at = (path: string) => history.replaceState({}, '', path);
  const tagged = (props: AnalyticsEvent['props'] = {}, url?: string) => folioContext()({ ...event(props), url }).props;
  const arabic = '/ar/\u0627\u0644\u0641\u0648\u0627\u062a\u064a\u0631';

  it('tags on a match, and adds nothing on a mismatch or leaves things as they were when absent', () => {
    at('/a');
    setMetas(docA, 'en-US', '/a');
    expect(tagged()).toEqual({ doc: docA, locale: 'en-US' });
    setMetas(docA, 'en-US', '/b');
    expect(tagged()).toEqual({});
    setMetas(docA, 'en-US');
    expect(tagged()).toEqual({ doc: docA, locale: 'en-US' });
    setMetas(docA, 'en-US', '  ');
    expect(tagged()).toEqual({ doc: docA, locale: 'en-US' });
  });

  it.each([
    ['root', '/', '/'],
    ['/index.html at the root', '/index.html', '/'],
    ['root and /index.html, the other way', '/', '/index.html'],
    ['a trailing slash on the meta', '/a/b/', '/a/b'],
    ['a trailing slash on the URL', '/a/b', '/a/b/'],
    ['a trailing /index.html on the meta', '/a/b/index.html', '/a/b'],
    ['a trailing /index.html on the URL', '/a/b', '/a/b/index.html'],
    ['/index.html against a trailing slash', '/a/b/index.html', '/a/b/'],
    ['an Arabic path, raw on the meta', arabic, encodeURI(arabic)],
    ['an Arabic path, encoded on the meta', encodeURI(arabic), arabic],
    ['an Arabic path with a trailing slash', `${arabic}/`, encodeURI(arabic)],
    ['lowercase and uppercase hex', '/a%d8%a7', '/a%D8%A7'],
  ])('matches %s', (_label, meta, url) => {
    at(url);
    setMetas(docA, 'en-US', meta);
    expect(tagged()).toEqual({ doc: docA, locale: 'en-US' });
  });

  it.each([
    ['case', '/Billing', '/billing'],
    ['a different page', '/a/b', '/a/c'],
    ['a parent path', '/a', '/a/b'],
    ['an encoded slash against a real one', '/a%2Fb', '/a/b'],
    ['an index page by another name', '/a/index.htm', '/a'],
    ['a meta with an origin', 'https://example.com/a', '/a'],
  ])('does not match %s', (_label, meta, url) => {
    at(url);
    setMetas(docA, 'en-US', meta);
    expect(tagged()).toEqual({});
  });

  it('compares raw strings on a malformed escape, without throwing', () => {
    at('/bad%ZZ');
    setMetas(docA, 'en-US', '/bad%ZZ');
    expect(tagged()).toEqual({ doc: docA, locale: 'en-US' });
    setMetas(docA, 'en-US', '/bad%ZZ/');
    expect(tagged()).toEqual({});
    at('/good');
    setMetas(docA, 'en-US', '/bad%E0%A4%A');
    expect(tagged()).toEqual({});
  });

  it("judges an event by its own URL, ignoring query and fragment, and by the page's when that is unusable", () => {
    at('/page');
    setMetas(docA, 'en-US', '/own');
    expect(tagged({}, 'https://example.com/own?x=1#y')).toEqual({ doc: docA, locale: 'en-US' });
    expect(tagged({}, 'https://example.com/other')).toEqual({});
    expect(tagged({}, 'https://[')).toEqual({});
    at('/own');
    expect(tagged({}, 'https://[')).toEqual({ doc: docA, locale: 'en-US' });
  });

  it('judges an explicit page({ url }) by that URL, end to end', async () => {
    at('/somewhere-else');
    setMetas(docA, 'en-US', '/own');
    const { client, sent } = setup();
    client.page({ url: 'https://example.com/own' });
    client.page({ url: 'https://example.com/other' });
    await client.flush();
    expect(sent().map(item => item.props.doc)).toEqual([docA, undefined]);
    await client.shutdown();
  });

  it('keeps a prop the caller set on a mismatch, and still sends the event', async () => {
    at('/a');
    setMetas(docA, 'en-US', '/b');
    const { client, sent } = setup();
    expect(client.track('kept', { doc: docB })).toBe(true);
    expect(client.track('bare')).toBe(true);
    await client.flush();
    expect(sent()[0]!.props).toEqual({ doc: docB });
    expect(sent()[1]!.props).toEqual({});
    await client.shutdown();
  });

  it('sendReaction resolves false, unsent, on a mismatch and sends on a match', async () => {
    at('/a');
    setMetas(docA, 'en-US', '/b');
    const stale = setup({ beforeSend: undefined });
    await expect(sendReaction(stale.client, 'up')).resolves.toBe(false);
    expect(stale.fetcher).not.toHaveBeenCalled();
    await stale.client.shutdown();
    setMetas(docA, 'en-US', '/a/');
    const fresh = setup({ beforeSend: undefined });
    await expect(sendReaction(fresh.client, 'up')).resolves.toBe(true);
    expect(fresh.sent()[0]!.props).toEqual({ value: 'up', doc: docA, locale: 'en-US' });
    await fresh.client.shutdown();
  });
});

describe('sendReaction', () => {
  it('tracks folio_reaction with value, doc and locale without folioContext, then flushes', async () => {
    setMetas(docA, 'en-US');
    const { client, sent } = setup({ beforeSend: undefined });
    await expect(sendReaction(client, 'down')).resolves.toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ name: 'folio_reaction', props: { value: 'down', doc: docA, locale: 'en-US' } });
    await client.shutdown();
  });

  it('sends one tagged event alongside folioContext', async () => {
    setMetas(docA, 'en-US');
    const { client, sent } = setup();
    await expect(sendReaction(client, 'up')).resolves.toBe(true);
    expect(sent()[0]!.props).toEqual({ value: 'up', doc: docA, locale: 'en-US' });
    await client.shutdown();
  });

  it('resolves false and sends nothing under denied consent', async () => {
    setMetas(docA, 'en-US');
    const { client, fetcher } = setup({ consent: 'denied' });
    await expect(sendReaction(client, 'up')).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it.each([['Do Not Track', 'doNotTrack', '1'], ['Global Privacy Control', 'globalPrivacyControl', true]])(
    'resolves false and sends nothing under %s', async (_label, property, value) => {
      setMetas(docA, 'en-US');
      Object.defineProperty(navigator, property, { configurable: true, get: () => value });
      const { client, fetcher } = setup();
      await expect(sendReaction(client, 'up')).resolves.toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      delete (navigator as unknown as Record<string, unknown>)[property];
      await client.shutdown();
    });

  it('resolves true on a failed flush, without throwing, because the event stays queued', async () => {
    setMetas(docA, 'en-US');
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const { client } = setup({ fetch: fetcher, maxRetries: 0 });
    await expect(sendReaction(client, 'up')).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalled();
    client.setEnabled(false);
    await client.shutdown();
  });

  it('resolves false when a beforeSend drops it or the page has no document to credit', async () => {
    setMetas(docA, 'en-US');
    const dropping = setup({ beforeSend: () => null });
    await expect(sendReaction(dropping.client, 'up')).resolves.toBe(false);
    await dropping.client.shutdown();
    setMetas();
    const bare = setup();
    await expect(sendReaction(bare.client, 'up')).resolves.toBe(false);
    expect(bare.fetcher).not.toHaveBeenCalled();
    await bare.client.shutdown();
  });
});

describe('the single-page hazard', () => {
  it('plain history tracking mis-tags: it fires inside pushState, before the new metas render', async () => {
    setMetas(docA, 'en-US');
    const { client, sent } = setup({ autoPageviews: true });
    client.start();
    history.pushState({}, '', '/b');
    setMetas(docB, 'en-US'); // A framework renders after pushState returns.
    await client.flush();
    const views = sent().filter(item => item.name === 'page_view');
    expect(views.map(view => [view.url, view.props.doc])).toEqual([
      ['http://localhost:3000/', docA],
      ['http://localhost:3000/b', docA], // The wrong document, which is the hazard.
    ]);
    await client.shutdown();
  });

  it('with folio:path, plain history tracking sends the view with no doc, never the previous document', async () => {
    history.replaceState({}, '', '/a');
    setMetas(docA, 'en-US', '/a');
    const { client, sent } = setup({ autoPageviews: true });
    client.start();
    history.pushState({}, '', '/b');
    setMetas(docB, 'en-US', '/b');
    await client.flush();
    expect(sent().map(item => [new URL(item.url!).pathname, item.props.doc])).toEqual([['/a', docA], ['/b', undefined]]);
    await client.shutdown();
  });

  it('the supported route with no adapter credits the new document: historyTracking false and page() after rendering', async () => {
    setMetas(docA, 'en-US');
    const { client, sent } = setup({ autoPageviews: true, historyTracking: false });
    client.start();
    history.pushState({}, '', '/b');
    setMetas(docB, 'en-US');
    client.page();
    await client.flush();
    const views = sent().filter(item => item.name === 'page_view');
    expect(views.map(view => [view.url, view.props.doc])).toEqual([
      ['http://localhost:3000/', docA],
      ['http://localhost:3000/b', docB],
    ]);
    await client.shutdown();
  });
});
