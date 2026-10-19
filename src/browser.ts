import { createInternalClient, randomId } from './client';
import type { AnalyticsClient, ClientOptions, Consent, EventContext, Identity, Properties } from './types';

export interface BrowserOptions extends ClientOptions {
  consent?: Consent;
  autoPageviews?: boolean;
  /** Disable History API instrumentation when a framework owns navigation events. */
  historyTracking?: boolean;
  /** Router adapters wait for completed navigation before the first pageview. */
  initialPageview?: boolean;
  autoEvents?: boolean;
  respectDoNotTrack?: boolean;
  domains?: string[];
  /** URL query strings and fragments are omitted by default. UTM tags are separate. */
  includeQuery?: boolean;
  includeHash?: boolean;
  sessionTimeout?: number;
}

export interface BrowserClient extends Omit<AnalyticsClient, 'identify'> {
  /** Records a pageview only when the sanitized URL changes. Used by router adapters. */
  pageIfChanged(context?: EventContext, props?: Properties): boolean;
  identify(identity: Identity): Promise<void>;
  setConsent(state: Consent): void;
  getConsent(): Consent;
  /** Installs listeners once. Safe to restart after stop (including React Strict Mode). */
  start(): void;
  stop(): void;
  reset(): void;
  setEnabled(enabled: boolean): void;
}

type Subscriber = () => void;
const histories = new WeakMap<Window, { subscribers: Set<Subscriber>; cleanup: () => void }>();
function subscribeHistory(w: Window, subscriber: Subscriber): () => void {
  let state = histories.get(w);
  if (!state) {
    const subscribers = new Set<Subscriber>();
    const notify = () => { for (const listener of subscribers) listener(); };
    const originalPush = w.history.pushState;
    const originalReplace = w.history.replaceState;
    const push: History['pushState'] = function (this: History, ...args) { originalPush.apply(this, args); notify(); };
    const replace: History['replaceState'] = function (this: History, ...args) { originalReplace.apply(this, args); notify(); };
    w.history.pushState = push;
    w.history.replaceState = replace;
    w.addEventListener('popstate', notify);
    w.addEventListener('hashchange', notify);
    state = { subscribers, cleanup() {
      if (w.history.pushState === push) w.history.pushState = originalPush;
      if (w.history.replaceState === replace) w.history.replaceState = originalReplace;
      w.removeEventListener('popstate', notify);
      w.removeEventListener('hashchange', notify);
    } };
    histories.set(w, state);
  }
  state.subscribers.add(subscriber);
  return () => {
    state!.subscribers.delete(subscriber);
    if (!state!.subscribers.size) { state!.cleanup(); histories.delete(w); }
  };
}

/** Creates no listeners or pageviews until start() is called. Safe to import during SSR. */
export function createBrowserClient(options: BrowserOptions): BrowserClient {
  const internal = createInternalClient(options);
  const core = internal.client;
  const w = typeof window === 'undefined' ? undefined : window;
  const key = `_athar:${options.site}:`;
  const sessionTimeout = options.sessionTimeout ?? 30 * 60 * 1000;
  if (!Number.isFinite(sessionTimeout) || sessionTimeout <= 0) throw new TypeError('sessionTimeout must be positive');
  let consent: Consent = options.consent ?? 'unknown';
  let loaded = false;
  let enabled = true;
  let terminated = false;
  let running = false;
  let visitor: string | undefined;
  let session = `s-${randomId()}`;
  let lastActivity = Date.now();
  let lastPage: string | undefined;
  let previousPage: string | undefined;
  let cleanup: (() => void) | undefined;

  function storage(kind: 'localStorage' | 'sessionStorage', action: 'getItem' | 'setItem' | 'removeItem', name: string, value = ''): string | null {
    try {
      const store = w?.[kind];
      if (!store) return null;
      if (action === 'getItem') return store.getItem(key + name);
      if (action === 'setItem') store.setItem(key + name, value);
      else store.removeItem(key + name);
    } catch { /* Sandboxed and private contexts may deny storage. */ }
    return null;
  }
  function loadConsent(): void {
    if (loaded || !w) return;
    loaded = true;
    if (options.consent === undefined) {
      const saved = storage('localStorage', 'getItem', 'consent');
      if (saved === 'granted' || saved === 'denied') consent = saved;
    }
  }
  function allowed(): boolean {
    loadConsent();
    if (!w || !enabled || terminated || consent === 'denied') return false;
    const nav = w.navigator as Navigator & { globalPrivacyControl?: boolean };
    if (options.respectDoNotTrack !== false && (nav.doNotTrack === '1' || nav.globalPrivacyControl === true)) return false;
    return !options.domains?.length || options.domains.includes(w.location.hostname);
  }
  function sanitize(raw: string): string {
    if (!raw) return '';
    const url = new URL(raw, w?.location.href);
    url.username = ''; url.password = '';
    if (!options.includeQuery) url.search = '';
    if (!options.includeHash) url.hash = '';
    return url.href;
  }
  function context(override: EventContext = {}): EventContext {
    const now = Date.now();
    if (consent === 'granted') {
      visitor ||= storage('localStorage', 'getItem', 'visitor') || `v-${randomId()}`;
      storage('localStorage', 'setItem', 'visitor', visitor);
      const saved = storage('sessionStorage', 'getItem', 'session');
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { id: string; at: number };
          if (typeof parsed.id === 'string' && parsed.id && Number.isFinite(parsed.at) && now - parsed.at < sessionTimeout) {
            session = parsed.id; lastActivity = parsed.at;
          }
        } catch { /* Ignore corrupt session data. */ }
      }
    }
    if (now - lastActivity >= sessionTimeout) session = `s-${randomId()}`;
    lastActivity = now;
    if (consent === 'granted') storage('sessionStorage', 'setItem', 'session', JSON.stringify({ id: session, at: now }));
    const utm: Record<string, string> = {};
    const params = new URLSearchParams(w?.location.search);
    for (const field of ['source', 'medium', 'campaign', 'term', 'content']) {
      const value = params.get(`utm_${field}`);
      if (value) utm[field] = value;
    }
    return {
      ...override,
      url: sanitize(override.url ?? w?.location.href ?? ''),
      referrer: sanitize(override.referrer ?? previousPage ?? w?.document.referrer ?? ''),
      utm: override.utm ?? utm,
      sessionId: session,
      visitorId: consent === 'granted' ? visitor : undefined,
    };
  }
  function track(name: string, props?: Properties, override?: EventContext): boolean {
    if (!allowed()) return false;
    try { return core.track(name, props, context(override)); } catch (error) { internal.report(error); return false; }
  }
  function pageIfChanged(override: EventContext = {}, props?: Properties): boolean {
    if (!w || !allowed()) return false;
    try {
      const current = sanitize(override.url ?? w.location.href);
      if (current === lastPage) return false;
      const referrer = override.referrer ?? lastPage ?? w.document.referrer;
      if (!track('page_view', props ?? { title: w.document.title }, { ...override, referrer })) return false;
      previousPage = sanitize(referrer);
      lastPage = current;
      return true;
    } catch (error) { internal.report(error); return false; }
  }
  function autoPage(): void { pageIfChanged(); }
  function lifecycleFlush(): void {
    if (!allowed()) return;
    if (w?.navigator.sendBeacon) internal.beacon(w.navigator.sendBeacon.bind(w.navigator));
    else void core.flush().catch(internal.report);
  }
  function clearIdentity(): void {
    visitor = undefined;
    session = `s-${randomId()}`;
    lastActivity = Date.now();
    storage('localStorage', 'removeItem', 'visitor');
    storage('sessionStorage', 'removeItem', 'session');
  }
  const client: BrowserClient = {
    track,
    pageIfChanged,
    page: (override, props) => track('page_view', props ?? { title: w?.document.title ?? '' }, override),
    async identify(identity) {
      if (!allowed() || consent !== 'granted') return;
      await core.identify(identity, context());
    },
    flush: () => core.flush(),
    async shutdown() { client.stop(); terminated = true; await core.shutdown(); },
    setConsent(state) {
      if (!['unknown', 'granted', 'denied'].includes(state)) throw new TypeError('Invalid consent state');
      const old = consent;
      consent = state; loaded = true;
      if (state === 'unknown') storage('localStorage', 'removeItem', 'consent');
      else storage('localStorage', 'setItem', 'consent', state);
      if (state !== 'granted') { internal.discard(); clearIdentity(); }
      if (old !== state) { lastPage = undefined; previousPage = undefined; }
      if (running && options.autoPageviews !== false && state !== 'denied') autoPage();
    },
    getConsent() { loadConsent(); return consent; },
    setEnabled(value) {
      enabled = value;
      if (!value) internal.discard();
    },
    reset() {
      internal.discard(); clearIdentity(); lastPage = undefined; previousPage = undefined;
    },
    start() {
      if (!w || running || terminated) return;
      running = true;
      loadConsent();
      const removeHistory = options.autoPageviews === false || options.historyTracking === false ? () => {} : subscribeHistory(w, autoPage);
      const visibility = () => { if (w.document.visibilityState === 'hidden') lifecycleFlush(); };
      const online = () => { if (allowed()) void core.flush().catch(internal.report); };
      const click = (event: MouseEvent) => {
        if (options.autoEvents === false || !(event.target instanceof w.Element)) return;
        const element = event.target.closest('[data-athar-event]');
        const name = element?.getAttribute('data-athar-event');
        if (!element || !name) return;
        const props: Properties = Object.create(null) as Properties;
        for (const attribute of element.attributes) {
          if (attribute.name.startsWith('data-athar-event-')) props[attribute.name.slice(17)] = attribute.value;
        }
        track(name, props);
      };
      const crossTabConsent = (event: StorageEvent) => {
        if (event.key !== key + 'consent' && event.key !== null) return;
        loaded = false; // Read the new preference without writing a storage-event loop.
        const saved = storage('localStorage', 'getItem', 'consent');
        consent = saved === 'granted' || saved === 'denied' ? saved : 'unknown';
        loaded = true;
        if (consent !== 'granted') { internal.discard(); clearIdentity(); }
      };
      w.addEventListener('pagehide', lifecycleFlush);
      w.addEventListener('online', online);
      w.addEventListener('storage', crossTabConsent);
      w.document.addEventListener('visibilitychange', visibility);
      w.document.addEventListener('click', click);
      cleanup = () => {
        removeHistory();
        w.removeEventListener('pagehide', lifecycleFlush);
        w.removeEventListener('online', online);
        w.removeEventListener('storage', crossTabConsent);
        w.document.removeEventListener('visibilitychange', visibility);
        w.document.removeEventListener('click', click);
      };
      if (options.autoPageviews !== false && options.initialPageview !== false) autoPage();
    },
    stop() { cleanup?.(); cleanup = undefined; running = false; },
  };
  return client;
}

export type { AnalyticsEvent, Consent, EventContext, Identity, Properties } from './types';
