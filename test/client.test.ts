import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index';
import { createClient as createCoreClient } from '../src/client';
import type { ClientOptions } from '../src/types';
import { createBrowserClient } from '../src/browser';

const config = (extra: Partial<ClientOptions> = {}): ClientOptions => ({
  site: 'public-site-token', host: 'https://collector.example', flushInterval: 0, retryDelay: 0, ...extra,
});
const ok = () => new Response(null, { status: 204 });

describe('client', () => {
  it('allows browser client construction and lifecycle calls during SSR without collection', async () => {
    const fetcher = vi.fn();
    const client = createBrowserClient(config({ fetch: fetcher }));
    client.start();
    expect(client.track('ssr')).toBe(false);
    await client.shutdown();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the public HTTP contract against a real HTTP server without browser globals', async () => {
    const received: { path?: string; contentType?: string; body: any }[] = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ path: req.url, contentType: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(204).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      const client = createClient(config({ host: `http://127.0.0.1:${address.port}` }));
      client.track('purchase', { amount: 15 }, { sessionId: 's-one', visitorId: 'v-one', url: 'https://shop.example/item', timestamp: 1700000000000 });
      client.track('purchase', { amount: 30 }, { sessionId: 's-two' });
      await client.identify({ external_id: 'account-1' }, { visitorId: 'v-one' });
      await client.shutdown();
      expect(received.map(item => item.path)).toEqual(['/athar/public-site-token/id', '/athar/public-site-token/ev']);
      expect(received[0]?.body).toMatchObject({ vid: 'v-one', external_id: 'account-1' });
      expect(received[0]?.body).not.toHaveProperty('site');
      expect(received[1]?.body.events[0]).toMatchObject({ name: 'purchase', sid: 's-one', vid: 'v-one', ts: 1700000000000, props: { amount: 15 } });
      expect(received[1]?.body.events[1].vid).toBeUndefined();
      expect(received.every(item => item.contentType === 'text/plain')).toBe(true);
      expect(client.track('after-shutdown')).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('retries transient failures with identical event IDs and serializes concurrent flushes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(ok());
    const client = createClient(config({ fetch: fetcher }));
    client.track('signup');
    const first = client.flush();
    expect(client.flush()).toBe(first);
    await first;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1].body).toBe(fetcher.mock.calls[1]?.[1].body);
  });

  it('does not retry 4xx responses and retains failed data for explicit retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValue(ok());
    const client = createClient(config({ fetch: fetcher }));
    client.track('signup');
    await expect(client.flush()).rejects.toThrow('403');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.flush();
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).events).toHaveLength(1);
  });

  it('bounds retries and preserves the queue after network failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const client = createClient(config({ fetch: fetcher, maxRetries: 1 }));
    client.track('click');
    await expect(client.flush()).rejects.toThrow('offline');
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValue(ok());
    await client.shutdown();
    expect(JSON.parse(fetcher.mock.calls[2]?.[1].body).events[0].name).toBe('click');
  });

  it('enforces UTF-8 limits, JSON properties, timestamps and filters before sending', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    const client = createClient(config({ fetch: fetcher, beforeSend: event => event.name === 'secret' ? null : event }));
    expect(client.track('secret')).toBe(false);
    expect(client.track('é'.repeat(65))).toBe(false);
    expect(client.track('large', { value: 'é'.repeat(1024) })).toBe(false);
    expect(client.track('bad', { value: NaN })).toBe(false);
    expect(client.track('bad', {}, { timestamp: 0.5 })).toBe(false);
    const circular: any = {}; circular.self = circular;
    expect(client.track('bad', circular)).toBe(false);
    const props = { plan: 'small' };
    expect(client.track(' signup ', props)).toBe(true);
    props.plan = 'large';
    await client.flush();
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).events[0]).toMatchObject({ name: 'signup', props: { plan: 'small' } });
  });

  it('splits batches by UTF-8 body size below 32 KiB', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    const client = createClient(config({ fetch: fetcher, batchSize: 25 }));
    for (let i = 0; i < 24; i++) client.track('view', { value: 'x'.repeat(1900) }, { url: `https://example.com/${'x'.repeat(1900)}` });
    await client.flush();
    const bodies = fetcher.mock.calls.map(call => call[1].body as string);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every(body => new TextEncoder().encode(body).length <= 30000)).toBe(true);
    expect(bodies.flatMap(body => JSON.parse(body).events)).toHaveLength(24);
  });

  it('bounds the queue even during an in-flight send and isolates error handlers', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const client = createClient(config({ fetch: fetcher, batchSize: 1, maxQueueSize: 1, onError() { throw new Error('observer'); } }));
    expect(client.track('first')).toBe(true);
    expect(client.track('second')).toBe(false);
    finish(ok());
    await client.shutdown();
  });

  it('flush includes events queued while another flush is already in flight', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValue(ok());
    const client = createClient(config({ fetch: fetcher }));
    client.track('one');
    const first = client.flush();
    client.track('two');
    const second = client.flush();
    finish(ok());
    await second;
    expect(first).toBe(second);
    expect(fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events).map(event => event.name)).toEqual(['one', 'two']);
  });

  it('enforces timeouts even if a custom transport ignores abort', async () => {
    const client = createClient(config({ fetch: vi.fn(() => new Promise<Response>(() => {})), timeout: 5, maxRetries: 0 }));
    client.track('slow');
    await expect(client.flush()).rejects.toThrow();
  });

  it('has no implicit identity and does not leak handles into event payloads', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    const client = createClient(config({ fetch: fetcher }));
    await expect(client.identify({ email: 'someone@example.com' }, {})).rejects.toThrow();
    await client.identify({ email: 'someone@example.com' }, { sessionId: 's-id' });
    client.page();
    await client.flush();
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).vid).toBe('s:s-id');
    expect(fetcher.mock.calls[1]?.[1].body).not.toContain('someone@example.com');
  });
});

it('filters manual attribution and hook changes before serialization, preserving valid descriptors', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok());
  const client = createClient(config({ fetch: fetcher, beforeSend: event => ({ ...event,
    url: 'https://example.com/?gclid=private-click&keep=yes',
    attribution: { ...event.attribution, fbclid: 'private-click' },
  }) }));
  expect(client.track('arrival', {}, { attribution: {
    campaign_id: ' 123 ', placement: 'feed', keyword: 'é'.repeat(257),
    ad_id: 'x'.repeat(129), unknown: 'private',
  } })).toBe(true);
  await client.shutdown();
  const event = JSON.parse(fetcher.mock.calls[0]![1].body).events[0];
  expect(event.attribution).toEqual({ campaign_id: '123', placement: 'feed' });
  expect(event.url).toBe('https://example.com/?keep=yes');
});

it('retries click handoffs with a stable request ID, and flush waits for acknowledgement', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(ok());
  const hook = vi.fn(event => event);
  const client = createClient(config({ fetch: fetcher, beforeSend: hook }));
  expect(client.captureAttribution({ gclid: 'secret-token', campaign_id: '123' },
    { consent: 'granted', sessionId: 's1', visitorId: 'v1' })).toBe(true);
  await client.flush();
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(fetcher.mock.calls[0]![0]).toBe('https://collector.example/athar/public-site-token/attr');
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  expect(hook).not.toHaveBeenCalled();
  await client.shutdown();
});

it('keeps a reverse-proxy path prefix and encodes the site token as one path segment', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok());
  const client = createClient(config({ fetch: fetcher, site: 'ast_a/b', host: 'https://example.com/x/' }));
  client.track('purchase');
  await client.flush();
  expect(fetcher.mock.calls[0]![0]).toBe('https://example.com/x/athar/ast_a%2Fb/ev');
  await client.shutdown();
});

it('supports every catalogue identifier and alias without collapsing different kinds', async () => {
  const { attributionParams } = await import('../src/attribution-params');
  const fetcher = vi.fn().mockResolvedValue(ok());
  const client = createClient(config({ fetch: fetcher }));
  for (const p of attributionParams) {
    if (p.class !== 'identifier') continue;
    for (const key of [p.param, ...('aliases' in p ? p.aliases : [])]) {
      expect(client.captureAttribution({ [key]: 'token' }, { consent: 'granted', sessionId: key, visitorId: 'v1' })).toBe(true);
    }
  }
  expect(client.captureAttribution({ gclid: 'token' }, { consent: 'granted', sessionId: 's1', visitorId: 'v\0id' })).toBe(false);
  expect(client.captureAttribution({ gclid: 'same', fbclid: 'same' }, { consent: 'granted', sessionId: 's1', visitorId: 'v1' })).toBe(false);
  await client.flush();
  expect(fetcher.mock.calls).toHaveLength(14);
  await client.shutdown();
});

it('lets a revocation bypass a failed capture and prevents token-bearing retries', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  const client = createClient(config({ fetch: fetcher, maxRetries: 0 }));
  client.captureAttribution({ gclid: 'secret-token' }, { consent: 'granted', sessionId: 's1', visitorId: 'v1' });
  await expect(client.flush()).rejects.toThrow('Attribution delivery failed');
  fetcher.mockResolvedValue(ok());
  expect(client.revokeAttribution('v1')).toBe(true);
  await client.flush();
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({ consent: 'denied', vid: 'v1' });
  expect(fetcher.mock.calls[1]![1].body).not.toContain('secret-token');
  await client.shutdown();
});

it('drops batches the collector rejects so later events are delivered', async () => {
  const onError = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 413 })).mockResolvedValue(ok());
  const client = createClient(config({ fetch: fetcher, batchSize: 1, onError }));
  client.track('rejected'); client.track('next');
  await client.flush();
  expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).events[0].name)).toEqual(['rejected', 'next']);
  expect(onError.mock.calls[0]![0]).toMatchObject({ name: 'CollectorError', status: 413 });
  await client.shutdown();
});

it('schedules a backed-off retry after a failed flush', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(ok());
    const client = createClient(config({ fetch: fetcher, flushInterval: 1000, maxRetries: 0, onError() {} }));
    client.track('retry');
    await expect(client.flush()).rejects.toThrow('503');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await client.shutdown();
  } finally { vi.useRealTimers(); }
});

it('beacons events queued behind an in-flight request', async () => {
  const { createInternalClient } = await import('../src/client');
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const internal = createInternalClient(config({ fetch: fetcher, batchSize: 1 }));
  internal.client.track('in-flight');
  const pending = internal.client.flush();
  internal.client.track('queued');
  const beacon = vi.fn().mockReturnValue(true);
  internal.beacon(beacon);
  expect(JSON.parse(beacon.mock.calls[0]![1]).events.map((event: any) => event.name)).toEqual(['queued']);
  finish(ok());
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('narrows the main entry point client and exposes an explicit server client', async () => {
  const { createServerClient, isBrowserClient } = await import('../src/index');
  const server = createServerClient(config({ fetch: vi.fn() }));
  expect(isBrowserClient(server)).toBe(false);
  expect(isBrowserClient(createBrowserClient(config({ fetch: vi.fn() })))).toBe(true);
});

it('delivers only the latest consent per visitor, retries it, and omits undecided scopes', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(ok());
  const client = createCoreClient(config({ fetch: fetcher }));
  const now = Date.now();
  expect(client.recordConsent({ analytics: 'granted', advertising: 'unknown' }, 'v1', now)).toBe(true);
  expect(client.recordConsent({ analytics: 'granted', advertising: 'denied' }, 'v2', now)).toBe(true);
  await client.flush();
  const bodies = fetcher.mock.calls.map(call => [String(call[0]), JSON.parse(call[1].body)]);
  expect(bodies[0]![0]).toBe('https://collector.example/athar/public-site-token/opt');
  expect(bodies[0]![1]).toEqual({ vid: 'v1', analytics: 'granted', ts: now });
  expect(bodies[1]![1]).toEqual(bodies[0]![1]); // the retry is the same request
  expect(bodies[2]![1]).toMatchObject({ vid: 'v2', analytics: 'granted', advertising: 'denied' });
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', headers: { 'Content-Type': 'text/plain' } });
  await client.shutdown();
});

it('lets a newer consent supersede one not yet delivered, and identify wait for it', async () => {
  let release: () => void = () => {};
  const fetcher = vi.fn().mockImplementation((url: string) => url.endsWith('/opt') && !fetcher.mock.calls.slice(1).length
    ? new Promise(resolve => { release = () => resolve(ok()); }) : Promise.resolve(ok()));
  const client = createCoreClient(config({ fetch: fetcher }));
  const now = Date.now();
  client.recordConsent({ analytics: 'granted', advertising: 'granted' }, 'v1', now - 2);
  client.recordConsent({ analytics: 'granted', advertising: 'denied' }, 'v2', now - 1);
  client.recordConsent({ analytics: 'denied', advertising: 'denied' }, 'v2', now);
  const identified = client.identify({ email: 'ada@example.com' }, { visitorId: 'v2' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/id'))).toBe(false);
  release();
  await identified; await client.flush();
  const paths = fetcher.mock.calls.map(call => new URL(String(call[0])).pathname);
  expect(paths).toEqual(['/athar/public-site-token/opt', '/athar/public-site-token/opt', '/athar/public-site-token/id']);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({ vid: 'v2', analytics: 'denied' });
  await client.shutdown();
});

it('refuses invalid consent and drops one the collector rejects', async () => {
  const errors: Error[] = [];
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
  const client = createCoreClient(config({ fetch: fetcher, onError: error => errors.push(error) }));
  expect(client.recordConsent({ analytics: 'yes' as never, advertising: 'denied' }, 'v1')).toBe(false);
  expect(client.recordConsent({ analytics: 'granted', advertising: 'denied' }, '')).toBe(false);
  expect(client.recordConsent({ analytics: 'granted', advertising: 'denied' }, 'v1', Date.now() - 2 * 86400000)).toBe(false);
  expect(client.recordConsent({ analytics: 'granted', advertising: 'denied' }, 'v1')).toBe(true);
  await client.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
  await client.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await client.shutdown();
});
