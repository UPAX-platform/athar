import type { AnalyticsClient, AnalyticsEvent, ClientOptions, EventContext, Identity, Properties } from './types';

const encoder = new TextEncoder();
export const bytes = (value: string): number => encoder.encode(value).length;
export const randomId = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
  value => value.toString(16).padStart(2, '0')).join('');

function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new TypeError(`Expected an integer between ${min} and ${max}`);
  }
  return result;
}

/** Internal lifecycle controls are deliberately absent from the public entry point. */
export function createInternalClient(options: ClientOptions) {
  if (typeof options.site !== 'string' || !options.site.trim() || bytes(options.site) > 1024) {
    throw new TypeError('site must be a non-empty public site token of at most 1024 bytes');
  }
  const host = new URL(options.host);
  if (!['https:', 'http:'].includes(host.protocol) || host.username || host.password || host.search || host.hash) {
    throw new TypeError('host must be an HTTP(S) base URL without credentials, query, or fragment');
  }
  const base = host.href.replace(/\/+$/, '');
  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetcher) throw new TypeError('A fetch implementation is required');
  const batchSize = integer(options.batchSize, 10, 1, 25);
  const maxQueue = integer(options.maxQueueSize, 1000, batchSize, 100000);
  const interval = integer(options.flushInterval, 3000, 0, 3600000);
  const timeout = integer(options.timeout, 5000, 1, 300000);
  const retries = integer(options.maxRetries, 2, 0, 10);
  const retryDelay = integer(options.retryDelay, 250, 0, 60000);
  let queue: AnalyticsEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let remaining = 0;
  let stopped = false;
  let generation = 0;
  const controllers = new Set<AbortController>();
  const identities = new Set<Promise<void>>();

  function report(error: unknown): void {
    try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Observer isolation. */ }
  }
  function schedule(): void {
    if (!interval || timer || stopped || !queue.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(report);
    }, interval);
    // Analytics must not keep a Node.js process alive. Call shutdown before exit.
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  function cancelTimer(): void { clearTimeout(timer); timer = undefined; }

  async function send(path: string, body: string, version: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (version !== generation) throw new Error('Delivery cancelled');
      const controller = new AbortController();
      controllers.add(controller);
      let retryable = true;
      let retryAfter = 0;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          fetcher!(base + path, {
            method: 'POST', body, headers: { 'Content-Type': 'text/plain' },
            credentials: 'omit', keepalive: true, signal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => { controller.abort(); reject(new Error('Collector request timed out')); }, timeout);
            controller.signal.addEventListener('abort', () => reject(new Error('Delivery cancelled')), { once: true });
          }),
        ]);
        if (response.ok) return;
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const header = response.headers.get('Retry-After');
        if (header) {
          retryAfter = /^\d+(\.\d+)?$/.test(header)
            ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
        }
        throw new Error(`Collector returned HTTP ${response.status}`);
      } catch (error) {
        if (version !== generation || !retryable || attempt >= retries) throw error;
      } finally {
        clearTimeout(deadline);
        controllers.delete(controller);
      }
      // Bound server-controlled delays so shutdown has a finite upper bound.
      const backoff = new AbortController();
      controllers.add(backoff);
      await new Promise<void>(resolve => {
        const delay = Math.min(60000, Math.max(retryAfter || 0, retryDelay * 2 ** attempt * (0.5 + Math.random())));
        const wakeup = setTimeout(resolve, delay);
        backoff.signal.addEventListener('abort', () => { clearTimeout(wakeup); resolve(); }, { once: true });
      });
      controllers.delete(backoff);
    }
  }

  function batch(): AnalyticsEvent[] {
    const result: AnalyticsEvent[] = [];
    for (const event of queue.slice(0, batchSize)) {
      if (bytes(JSON.stringify({ site: options.site, events: [...result, event] })) > 30000) break;
      result.push(event);
    }
    return result;
  }

  function flush(): Promise<void> {
    if (active) { remaining = queue.length; return active; }
    cancelTimer();
    // Only drain events present at entry; a busy producer cannot prevent shutdown.
    const version = generation;
    remaining = queue.length;
    let succeeded = false;
    active = (async () => {
      while (remaining > 0 && queue.length && version === generation) {
        const events = batch().slice(0, remaining);
        await send('/v1/e', JSON.stringify({ site: options.site, events }), version);
        if (version !== generation) return;
        queue.splice(0, events.length);
        remaining -= events.length;
      }
      succeeded = true;
    })().finally(() => { active = undefined; if (succeeded || version !== generation) schedule(); });
    return active;
  }

  function track(name: string, props: Properties = {}, context: EventContext = {}): boolean {
    if (stopped) return false;
    try {
      let event: AnalyticsEvent | null = {
        id: randomId(), ts: context.timestamp ?? Date.now(), name,
        url: context.url, ref: context.referrer, sid: context.sessionId,
        vid: context.visitorId, utm: context.utm, props,
      };
      event = options.beforeSend ? options.beforeSend(event) : event;
      if (event === null) return false;
      // Snapshot caller-owned data and reject non-JSON values rather than silently losing them.
      const serialized = JSON.stringify(event, (_key, value: unknown) => {
        if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' ||
          (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('Event must contain JSON data');
        return value;
      });
      event = JSON.parse(serialized) as AnalyticsEvent;
      if (typeof event.name !== 'string' || !event.name.trim() || bytes(event.name.trim()) > 128 ||
        typeof event.id !== 'string' || !event.id || !Number.isSafeInteger(event.ts) ||
        !event.props || Array.isArray(event.props) || typeof event.props !== 'object' ||
        bytes(JSON.stringify(event.props)) > 2048 ||
        [event.url, event.ref].some(value => value !== undefined && (typeof value !== 'string' || bytes(value) > 2048)) ||
        [event.sid, event.vid].some(value => value !== undefined && typeof value !== 'string') ||
        (event.utm !== undefined && (!event.utm || Array.isArray(event.utm) || typeof event.utm !== 'object' || Object.values(event.utm).some(value => typeof value !== 'string'))) ||
        bytes(serialized) > 28000) throw new TypeError('Invalid event or collector payload limit exceeded');
      event.name = event.name.trim();
      if (queue.length >= maxQueue) throw new Error('Analytics queue is full');
      queue.push(event);
      if (queue.length >= batchSize) void flush().catch(report);
      else schedule();
      return true;
    } catch (error) { report(error); return false; }
  }

  function identify(identity: Identity, context: EventContext): Promise<void> {
    if (stopped) return Promise.reject(new Error('Client is shut down'));
    const vid = context.visitorId || (context.sessionId ? `s:${context.sessionId}` : '');
    const email = identity.email?.trim();
    const externalId = identity.external_id?.trim();
    if (!vid || (!email?.includes('@') && !externalId)) return Promise.reject(new TypeError('A visitor/session ID and valid email or external_id are required'));
    const body = JSON.stringify({ site: options.site, vid, email, external_id: externalId, ts: context.timestamp ?? Date.now() });
    if (bytes(body) > 30000) return Promise.reject(new TypeError('Identity payload is too large'));
    const pending = send('/v1/id', body, generation);
    identities.add(pending);
    void pending.then(() => identities.delete(pending), () => identities.delete(pending));
    return pending;
  }

  const client: AnalyticsClient = {
    track, page: (context, props) => track('page_view', props, context), identify, flush,
    async shutdown() {
      stopped = true;
      cancelTimer();
      await Promise.all([flush(), ...identities]);
      // A flush that was already active may have captured fewer events.
      await flush();
    },
  };
  return {
    client,
    report,
    discard() {
      generation++;
      queue = [];
      cancelTimer();
      for (const controller of controllers) controller.abort();
    },
    beacon(sendBeacon: (url: string, body: string) => boolean) {
      if (active) return;
      cancelTimer();
      while (queue.length) {
        const events = batch();
        let accepted = false;
        try { accepted = sendBeacon(base + '/v1/e', JSON.stringify({ site: options.site, events })); } catch { /* Fall back to fetch. */ }
        if (!accepted) { void flush().catch(report); return; }
        queue.splice(0, events.length);
      }
    },
  };
}

export function createClient(options: ClientOptions): AnalyticsClient {
  return createInternalClient(options).client;
}
