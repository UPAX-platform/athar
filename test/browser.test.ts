// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from '../src/browser';

const clients: BrowserClient[] = [];
let fetcher = vi.fn();
const create = (extra: Partial<BrowserOptions> = {}) => {
  const client = createBrowserClient({ site: 'public-site', host: 'https://collector.example', fetch: fetcher,
    flushInterval: 0, ...extra });
  clients.push(client);
  return client;
};
const events = () => fetcher.mock.calls.filter(call => String(call[0]).endsWith('/v1/e'))
  .flatMap(call => JSON.parse(call[1].body).events);

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  document.cookie = '_athar_v=;path=/;max-age=0';
  window.history.replaceState({}, '', '/');
  document.body.innerHTML = '';
  Object.defineProperty(window.navigator, 'doNotTrack', { configurable: true, get: () => null });
  Object.defineProperty(window.navigator, 'globalPrivacyControl', { configurable: true, get: () => false });
  fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.shutdown();
  vi.unstubAllGlobals();
});

describe('browser tracking', () => {
  it('requires start, deduplicates SPA routes, removes listeners and restarts without duplicate initial views', async () => {
    const original = history.pushState;
    const client = create();
    expect(events()).toHaveLength(0);
    client.start(); client.start();
    history.pushState({}, '', '/pricing?secret=value');
    history.replaceState({}, '', '/pricing?secret=different');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await client.flush();
    expect(events().map(event => event.url)).toEqual(['http://localhost:3000/', 'http://localhost:3000/pricing']);
    expect(events()[1].ref).toBe('http://localhost:3000/');
    client.track('click'); await client.flush();
    expect(events()[2].ref).toBe('http://localhost:3000/');
    client.stop();
    expect(history.pushState).toBe(original);
    client.start(); await client.flush();
    expect(events()).toHaveLength(3);
  });

  it('shares History instrumentation between clients and restores it after the last stop', () => {
    const original = history.pushState;
    const a = create(); const b = create({ site: 'other-site' });
    a.start(); b.start();
    const wrapper = history.pushState;
    a.stop(); expect(history.pushState).toBe(wrapper);
    b.stop(); expect(history.pushState).toBe(original);
  });

  it('runs anonymously with only a tab session and no identity calls until granted; denial stops all collection', async () => {
    const client = create();
    client.track('anonymous');
    expect(await client.identify({ external_id: 'user-1' })).toBe(false);
    await client.flush();
    expect(events()[0].vid).toBeUndefined();
    expect(localStorage.length).toBe(0); expect(document.cookie).toBe('');
    expect(Object.keys(sessionStorage)).toEqual(['_athar:public-site:session']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.setConsent('granted');
    client.track('known');
    expect(await client.identify({ external_id: 'user-1' })).toBe(true);
    await client.flush();
    expect(events()[1].sid).toBe(events()[0].sid);
    expect(events()[1].vid).toMatch(/^v-/);
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/v1/id'))).toBe(true);
    client.track('queued-before-denial');
    client.setConsent('denied');
    expect(client.track('denied')).toBe(false);
    await client.identify({ email: 'someone@example.com' });
    await client.flush();
    expect(events()).toHaveLength(2);
    expect(localStorage.getItem('_athar_v')).toBeNull();
    expect(document.cookie).not.toContain('_athar_v');
    expect(sessionStorage.length).toBe(0);
  });

  it('loads persisted denial and handles consent withdrawn in another tab', async () => {
    localStorage.setItem('_athar:public-site:consent', 'denied');
    const client = create(); client.start();
    expect(client.getConsent()).toBe('denied');
    expect(client.track('no')).toBe(false);
    client.setConsent('granted'); client.track('pending');
    localStorage.setItem('_athar:public-site:consent', 'denied');
    window.dispatchEvent(new StorageEvent('storage', { key: '_athar:public-site:consent', newValue: 'denied' }));
    await client.flush();
    expect(events()).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ consent: 'denied' });
    expect(client.getConsent()).toBe('denied');
  });

  it('aborts in-flight deliveries when consent is revoked', async () => {
    fetcher.mockImplementation((url, init) => String(url).endsWith('/v1/attribution') ? Promise.resolve(new Response(null, { status: 204 })) : new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const client = create({ consent: 'granted' });
    client.track('pending');
    const pending = client.flush();
    client.setConsent('denied');
    await expect(pending).rejects.toThrow();
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('cancels a retry backoff promptly when consent is revoked', async () => {
    fetcher.mockImplementation(url => Promise.resolve(new Response(null, { status: String(url).endsWith('/v1/attribution') ? 204 : 503 })));
    const client = create({ consent: 'granted', retryDelay: 60000 });
    client.track('retrying');
    const pending = client.flush();
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await new Promise(resolve => setTimeout(resolve, 0));
    client.setConsent('denied');
    await rejected;
    expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/v1/e'))).toHaveLength(1);
  });

  it('honors DNT without creating persistent identifiers', () => {
    const client = create({ consent: 'granted' });
    vi.spyOn(window.navigator, 'doNotTrack', 'get').mockReturnValue('1');
    expect(client.track('dnt')).toBe(false);
    expect(localStorage.length).toBe(0); expect(document.cookie).toBe('');
  });

  it('honors global privacy control without creating persistent identifiers', () => {
    vi.spyOn(window.navigator as Navigator & { readonly globalPrivacyControl: boolean }, 'globalPrivacyControl', 'get').mockReturnValue(true);
    const client = create({ consent: 'granted' });
    expect(client.track('gpc')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('applies the domain allowlist and enabled flag', () => {
    expect(create({ domains: ['shop.example'] }).track('other-host')).toBe(false);
    const client = create(); client.setEnabled(false);
    expect(client.track('disabled')).toBe(false);
    client.setEnabled(true); expect(client.track('enabled')).toBe(true);
  });

  it('captures UTM separately and only explicitly annotated click properties', async () => {
    history.replaceState({}, '', '/?utm_source=newsletter&token=private#secret');
    const client = create(); client.start();
    document.body.innerHTML = '<button data-athar-event="signup" data-athar-event-plan="pro"><span>Join</span></button>';
    (document.querySelector('span') as HTMLElement).click();
    await client.flush();
    expect(events()[0]).toMatchObject({ url: 'http://localhost:3000/', utm: { source: 'newsletter' } });
    expect(events()[1]).toMatchObject({ name: 'signup', props: { plan: 'pro' } });
    expect(JSON.stringify(events())).not.toContain('private');
  });

  it('uses beacon on pagehide and falls back to fetch when rejected', async () => {
    const beacon = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    Object.defineProperty(window.navigator, 'sendBeacon', { configurable: true, value: beacon });
    const client = create({ autoPageviews: false }); client.start();
    client.track('unload'); window.dispatchEvent(new Event('pagehide'));
    await client.flush();
    expect(beacon).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
    client.track('fallback'); window.dispatchEvent(new Event('pagehide'));
    await client.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    delete (window.navigator as unknown as Record<string, unknown>).sendBeacon;
  });

  it('rotates sessions after inactivity and identities on reset', async () => {
    const client = create({ consent: 'granted', sessionTimeout: 100 });
    client.track('one'); await client.flush();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 101);
    client.track('two'); await client.flush();
    expect(events()[0].sid).not.toBe(events()[1].sid);
    expect(events()[0].vid).toBe(events()[1].vid);
    client.reset(); client.track('three'); await client.flush();
    expect(events()[1].vid).not.toBe(events()[2].vid);
  });

  it('remains usable when persistence is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const client = create({ consent: 'granted' });
    expect(client.track('private-context')).toBe(true);
    await client.flush(); expect(events()[0].vid).toMatch(/^v-/);
  });
});

it('captures every supported descriptor while keeping identifiers and unrelated query data out', async () => {
  const { attributionParams } = await import('../src/attribution-params');
  const params = new URLSearchParams();
  const expected: Record<string, string> = {};
  for (const p of attributionParams) {
    params.set(p.param, p.class === 'descriptor' ? `value-${p.param}` : 'private-click');
    if (p.class === 'descriptor') expected[p.param] = `value-${p.param}`;
    if ('aliases' in p) for (const alias of p.aliases) params.set(alias, 'private-click');
  }
  params.set('secret', 'private-query');
  history.replaceState({}, '', `/?${params}`);
  const client = create(); client.start();
  await client.flush();
  expect(events()[0].attribution).toEqual(expected);
  expect(JSON.stringify(events())).not.toContain('private-');
  history.pushState({}, '', '/next');
  await client.flush();
  expect(events()[1].attribution).toBeUndefined();
});

it('reads attribution and UTM from router URL overrides and filters click IDs even with includeQuery', async () => {
  const client = create({ includeQuery: true });
  client.page({ url: '/landing?campaign_id=123&utm_source=ad&gclid=private-click&sccid=private-click',
    referrer: 'https://other.example/?fbclid=private-click&keep=yes' });
  await client.flush();
  expect(events()[0]).toMatchObject({ attribution: { campaign_id: '123' }, utm: { source: 'ad' } });
  expect(events()[0].ref).toBe('https://other.example/?keep=yes');
  expect(JSON.stringify(events())).not.toContain('private-click');
});

it('hands off click IDs only after consent, once per session, outside analytics and browser storage', async () => {
  history.replaceState({}, '', '/?gclid=private-click&campaign_id=123&placement=feed');
  const hook = vi.fn(event => event);
  const client = create({ beforeSend: hook });
  client.start(); await client.flush();
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/v1/attribution'))).toBe(false);
  client.setConsent('granted'); await client.flush();
  client.track('another'); await client.flush();
  const handoffs = fetcher.mock.calls.filter(call => String(call[0]).endsWith('/v1/attribution'));
  expect(handoffs).toHaveLength(1);
  expect(JSON.parse(handoffs[0]![1].body)).toMatchObject({ consent: 'granted',
    params: { gclid: 'private-click', campaign_id: '123', placement: 'feed' } });
  expect(JSON.stringify(events())).not.toContain('private-click');
  expect(JSON.stringify(hook.mock.calls)).not.toContain('private-click');
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('private-click');
  client.setConsent('denied'); await client.flush();
  const revoke = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
  expect(revoke).toMatchObject({ consent: 'denied', vid: JSON.parse(handoffs[0]![1].body).vid });
  expect(revoke.params).toBeUndefined();
});

it('does not capture conflicting identifiers, including duplicate query keys', async () => {
  const client = create({ consent: 'granted' });
  history.replaceState({}, '', '/?gclid=one&fbclid=two');
  client.start(); await client.flush();
  history.replaceState({}, '', '/?gclid=one&gclid=two');
  client.track('again'); await client.flush();
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/v1/attribution'))).toBe(false);
});

it('aborts pending click capture and sends a token-free withdrawal on reset', async () => {
  history.replaceState({}, '', '/?gclid=private-click');
  let captureSignal: AbortSignal | undefined;
  fetcher.mockImplementation((url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/v1/attribution') && body.consent === 'granted') {
      captureSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const client = create({ consent: 'granted', autoPageviews: false });
  client.start();
  const pending = client.flush();
  const rejected = expect(pending).rejects.toThrow('Attribution delivery failed');
  client.reset();
  await rejected;
  await client.flush();
  expect(captureSignal?.aborted).toBe(true);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).consent).toBe('denied');
});

 it('automatically collects context through the main entry point and preserves overrides', async () => {
  history.replaceState({}, '', '/landing?utm_source=newsletter&utm_campaign=launch&campaign_name=launch&gclid=click-one');
  const client = createClient({ site: 'public-site', host: 'https://collector.example', fetch: fetcher,
    flushInterval: 0, consent: 'granted' });
  clients.push(client as BrowserClient);
  client.track('signup');
  await client.identify({ external_id: 'account-1' });
  await client.flush();
  const first = events()[0];
  expect(first).toMatchObject({ name: 'page_view', url: 'http://localhost:3000/landing',
    utm: { source: 'newsletter', campaign: 'launch' }, attribution: { campaign_name: 'launch' } });
  expect(first.vid).toMatch(/^v-/);
  expect(first.sid).toMatch(/^s-/);
  expect(events()[1]).toMatchObject({ vid: first.vid, sid: first.sid });
  expect(JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/v1/id'))![1].body).vid).toBe(first.vid);
  expect(JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/v1/attribution'))![1].body))
    .toMatchObject({ vid: first.vid, sid: first.sid, params: { gclid: 'click-one' } });
  client.track('override', {}, { visitorId: 'custom-v', sessionId: 'custom-s',
    url: '/other?utm_source=url', referrer: 'https://ref.example/path', timestamp: 1700000000000,
    utm: { source: 'manual' }, attribution: { campaign_name: 'manual' } });
  await client.identify({ external_id: 'account-2' }, { visitorId: 'custom-v' });
  await client.flush();
  expect(events()[2]).toMatchObject({ vid: 'custom-v', sid: 'custom-s', ts: 1700000000000,
    url: 'http://localhost:3000/other', ref: 'https://ref.example/path',
    utm: { source: 'manual' }, attribution: { campaign_name: 'manual' } });
  (client as BrowserClient).setConsent('denied');
  await client.flush();
  expect(fetcher.mock.calls.filter(call => call[0].endsWith('/v1/attribution'))
    .map(call => JSON.parse(call[1].body))).toContainEqual(expect.objectContaining({ vid: 'custom-v', consent: 'denied' }));
});

it('keeps caller identity overrides consent gated', async () => {
  const client = create();
  client.track('anonymous', {}, { visitorId: 'custom-v', sessionId: 'custom-s' });
  await client.identify({ external_id: 'account' }, { visitorId: 'custom-v' });
  await client.flush();
  expect(events()[0]).toMatchObject({ sid: 'custom-s' });
  expect(events()[0].vid).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const storedVid = 'v-' + 'a'.repeat(32);
const storedSid = 's-' + 'b'.repeat(32);

it('synchronizes reset with stopped and manual clients without restoring old IDs', async () => {
  const a = create({ consent: 'granted' });
  const b = create({ consent: 'granted' });
  a.track('a'); b.track('b'); await a.flush(); await b.flush();
  const old = events()[0];
  expect(events()[1]).toMatchObject({ vid: old.vid, sid: old.sid });
  b.track('discard-me'); b.stop(); a.reset();
  a.track('new-a'); b.track('new-b'); await a.flush(); await b.flush();
  expect(events().map(event => event.name)).not.toContain('discard-me');
  expect(events()[2].vid).not.toBe(old.vid);
  expect(events()[2].sid).not.toBe(old.sid);
  expect(events()[3]).toMatchObject({ vid: events()[2].vid, sid: events()[2].sid });
});

it('invalidates another tab session on a reset revision without deleting its new visitor', async () => {
  const client = create({ consent: 'granted', autoPageviews: false }); client.start();
  client.track('old'); await client.flush();
  const old = events()[0];
  client.track('stale-queued');
  client.stop();
  localStorage.setItem('_athar:public-site:revision', 'remote-reset');
  localStorage.setItem('_athar_v', storedVid);
  window.dispatchEvent(new StorageEvent('storage', { key: '_athar:public-site:revision' }));
  client.track('new'); await client.flush();
  expect(events()[1].vid).toBe(storedVid);
  expect(events()[1].sid).not.toBe(old.sid);
});

it.each(['bad-id', 'future', 'expired', 'malformed'])('rejects invalid stored identity/session data: %s', async kind => {
  localStorage.setItem('_athar_v', 'invalid');
  localStorage.setItem('_athar:public-site:session', kind === 'malformed' ? 'null' : JSON.stringify({
    id: kind === 'bad-id' ? 'invalid' : storedSid,
    at: Date.now() + (kind === 'future' ? 60000 : kind === 'expired' ? -1800001 : 0),
  }));
  const client = create({ consent: 'granted' }); client.track('valid'); await client.flush();
  expect(events()[0].vid).toMatch(/^v-[a-f0-9]{32}$/);
  expect(events()[0].sid).toMatch(/^s-[a-f0-9]{32}$/);
  expect(events()[0].sid).not.toBe(storedSid);
});

it('reuses generated IDs across client recreation without persisting call overrides', async () => {
  const a = create({ consent: 'granted' });
  a.track('first'); await a.flush();
  const first = events()[0];
  a.track('override', {}, { visitorId: 'caller-v', sessionId: 'caller-s' }); await a.flush();
  const b = create({ consent: 'granted' });
  b.track('recreated'); await b.flush();
  expect(events()[2]).toMatchObject({ vid: first.vid, sid: first.sid });
});

it('synchronizes reset and withdrawal between clients when storage is blocked', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
  const a = create({ consent: 'granted' });
  const b = create({ consent: 'granted' });
  b.track('before'); await b.flush();
  const before = events()[0];
  a.reset(); b.track('after'); await b.flush();
  expect(events()[1].vid).not.toBe(before.vid);
  expect(events()[1].sid).not.toBe(before.sid);
  a.setConsent('unknown');
  expect(b.getConsent()).toBe('unknown');
  b.track('anonymous'); await b.flush();
  expect(events()[2].vid).toBeUndefined();
});

it('exposes generated context for integrations without queuing events and respects consent', async () => {
  history.replaceState({}, '', '/form?utm_source=newsletter&campaign_id=launch&gclid=private');
  const client = create();
  const anonymous = client.getContext();
  expect(anonymous?.visitorId).toBeUndefined();
  client.setConsent('granted');
  const ctx = client.getContext();
  expect(ctx).toMatchObject({ url: 'http://localhost:3000/form', utm: { source: 'newsletter' }, attribution: { campaign_id: 'launch' } });
  expect(ctx?.visitorId).toMatch(/^v-[a-f0-9]{32}$/);
  expect(client.getContext({ visitorId: 'caller' })?.visitorId).toBe('caller');
  expect(client.getContext()?.visitorId).toBe(ctx?.visitorId);
  await client.flush();
  expect(events()).toHaveLength(0);
  client.setConsent('denied');
  expect(client.getContext()).toBeUndefined();
});

it('does not resurrect a visitor written by a stale tab during reset', async () => {
  const client = create({ consent: 'granted' });
  const before = client.getContext()!;
  const stale = localStorage.getItem('_athar_v')!;
  client.reset();
  localStorage.setItem('_athar_v', stale);
  expect(client.getContext()?.visitorId).not.toBe(before.visitorId);
});

const cookieVid = () => ('; ' + document.cookie).split('; _athar_v=')[1]?.split(';')[0];

it('shares the visitor ID with the platform tracker and form embeds through _athar_v', async () => {
  const client = create({ consent: 'granted' });
  const vid = client.getContext()!.visitorId;
  expect(localStorage.getItem('_athar_v')).toBe(vid);
  expect(cookieVid()).toBe(vid);
  client.reset();
  expect(localStorage.getItem('_athar_v')).toBeNull();
  expect(cookieVid()).toBeUndefined();
  localStorage.clear();
  document.cookie = `_athar_v=${storedVid};path=/`;
  expect(create({ consent: 'granted' }).getContext()!.visitorId).toBe(storedVid);
  expect(localStorage.getItem('_athar_v')).toBe(storedVid);
});

it('does not remove a shared visitor ID when consent is merely unknown', () => {
  localStorage.setItem('_athar_v', storedVid);
  const client = create(); client.start();
  expect(client.getContext()!.visitorId).toBeUndefined();
  expect(localStorage.getItem('_athar_v')).toBe(storedVid);
});

it('builds full form context after navigation without storing click IDs', async () => {
  Object.defineProperty(document, 'referrer', { configurable: true, get: () => 'https://search.example/results?q=private' });
  history.replaceState({}, '', '/?utm_source=google&utm_campaign=launch&campaign_id=c1&gclid=private-click');
  const client = create({ consent: 'granted' }); client.start();
  expect(client.getFormContext()).toMatchObject({ gclid: 'private-click', campaign_id: 'c1' });
  history.pushState({}, '', '/newsletter');
  document.title = 'Newsletter';
  Object.defineProperty(document, 'referrer', { configurable: true, get: () => 'http://localhost:3000/' });
  const form = client.getFormContext();
  expect(form).toEqual({ page_url: 'http://localhost:3000/newsletter', page_title: 'Newsletter',
    referrer: 'https://search.example/results', visitor_id: client.getContext()!.visitorId, consent: 'granted',
    utm_source: 'google', utm_campaign: 'launch', campaign_id: 'c1' });
  expect(JSON.stringify({ ...localStorage, ...sessionStorage, cookie: document.cookie })).not.toContain('private-click');
  await client.flush();
  expect(events().filter(event => event.name === 'page_view')).toHaveLength(2);
  client.setConsent('denied');
  expect(client.getFormContext()).toEqual({ page_url: 'http://localhost:3000/newsletter', page_title: 'Newsletter',
    referrer: 'http://localhost:3000/', consent: 'denied' });
  delete (document as unknown as Record<string, unknown>).referrer;
});

it('replaces the stored campaign on a new click arrival and keeps unconsented campaigns tab-scoped', () => {
  history.replaceState({}, '', '/?utm_source=first&campaign_id=c1');
  const client = create();
  client.getFormContext();
  expect(localStorage.length).toBe(0);
  history.replaceState({}, '', '/?fbclid=click');
  client.getFormContext();
  history.replaceState({}, '', '/later');
  expect(client.getFormContext().utm_source).toBeUndefined();
  expect(client.getFormContext().fbclid).toBeUndefined();
  history.replaceState({}, '', '/?utm_source=second');
  client.getFormContext();
  client.setConsent('granted');
  history.replaceState({}, '', '/later');
  expect(client.getFormContext().utm_source).toBe('second');
  expect(localStorage.getItem('_athar:public-site:campaign')).toContain('second');
});

it('does not duplicate the current pageview when consent is granted, but records it after a denial', async () => {
  const client = create(); client.start();
  client.setConsent('granted');
  await client.flush();
  expect(events().filter(event => event.name === 'page_view')).toHaveLength(1);
  client.setConsent('denied'); client.setConsent('granted');
  await client.flush();
  expect(events().filter(event => event.name === 'page_view')).toHaveLength(2);
});

it('continues sessions across page loads before consent and across tabs after consent', async () => {
  const first = create(); first.track('one');
  const reload = create(); reload.track('two');
  await first.flush(); await reload.flush();
  expect(events()[1].sid).toBe(events()[0].sid);
  first.setConsent('granted');
  const granted = first.getContext()!.sessionId;
  sessionStorage.clear(); // A new tab has empty session storage.
  const tab = create({ consent: 'granted' });
  expect(tab.getContext()!.sessionId).toBe(granted);
});

it('reads context without extending the session', async () => {
  const now = Date.now();
  const client = create({ consent: 'granted', sessionTimeout: 1000 });
  client.track('start'); await client.flush();
  vi.spyOn(Date, 'now').mockReturnValue(now + 900);
  expect(client.getContext()!.sessionId).toBe(events()[0].sid);
  vi.spyOn(Date, 'now').mockReturnValue(now + 1500);
  client.track('later'); await client.flush();
  expect(events()[1].sid).not.toBe(events()[0].sid);
});

it('shares document identity state between separately loaded SDK copies', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.resetModules();
  // @ts-expect-error A query import loads a second instance of the module.
  const copy: typeof import('../src/browser') = await import('../src/browser?copy');
  const a = create({ consent: 'granted' });
  const b = copy.createBrowserClient({ site: 'public-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0, consent: 'granted' });
  clients.push(b);
  const before = b.getContext()!.sessionId;
  a.reset();
  expect(b.getContext()!.sessionId).not.toBe(before);
});

it('shares a known consent decision through _athar_c for form embeds', () => {
  const client = create(); client.start();
  expect(localStorage.getItem('_athar_c')).toBeNull();
  expect(client.getFormContext().consent).toBeUndefined();
  client.setConsent('granted');
  expect(localStorage.getItem('_athar_c')).toBe('granted');
  client.setConsent('denied');
  expect(localStorage.getItem('_athar_c')).toBe('denied');
  client.setConsent('unknown');
  expect(localStorage.getItem('_athar_c')).toBeNull();
  create({ consent: 'granted' }).start();
  expect(localStorage.getItem('_athar_c')).toBe('granted');
});
