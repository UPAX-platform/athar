// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('runs anonymously without storage or identity calls until granted; denial stops all collection', async () => {
    const client = create();
    client.track('anonymous');
    await client.identify({ external_id: 'user-1' });
    await client.flush();
    expect(events()[0].vid).toBeUndefined();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.setConsent('granted');
    client.track('known');
    await client.identify({ external_id: 'user-1' });
    await client.flush();
    expect(events()[1].vid).toMatch(/^v-/);
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/v1/id'))).toBe(true);
    client.track('queued-before-denial');
    client.setConsent('denied');
    expect(client.track('denied')).toBe(false);
    await client.identify({ email: 'someone@example.com' });
    await client.flush();
    expect(events()).toHaveLength(2);
    expect(localStorage.getItem('_athar:public-site:visitor')).toBeNull();
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
    expect(localStorage.length).toBe(0);
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

it('captures every platform descriptor while keeping identifiers and unrelated query data out', async () => {
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
