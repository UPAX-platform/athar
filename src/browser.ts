import { attributionFromURL, clickAttribution, clickId, hasClickId, queryAttribution, stripClickIds } from './attribution';
import { bytes, createInternalClient, randomId } from './client';
import type { AnalyticsClient, AttributionContext, ClientOptions, Consent, ConsentScopes, EventContext, Identity, Properties } from './types';

/** A consent decision: one state for every scope, or per scope (an omitted scope keeps its state). */
export type ConsentChoice = Consent | Partial<ConsentScopes>;

export interface BrowserOptions extends ClientOptions {
  /** The consent already known for this page view, for example from a consent management platform. */
  consent?: ConsentChoice;
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

/** Flat `context` envelope accepted by public form endpoints. */
export interface FormContext {
  page_url: string;
  page_title: string;
  /** The session's external referrer when known, otherwise the document referrer. */
  referrer: string;
  /** Present only with granted consent. */
  visitor_id?: string;
  /** The visitor's latest decision per scope, as sent to the collector; absent until they decide. A form endpoint stores a click ID only when `advertising` is `granted`. */
  web_consent?: WebConsent;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  /** Campaign descriptors from the latest arrival, and a consented click ID from this URL, keyed by URL parameter name. */
  [param: string]: string | WebConsent | undefined;
}

/** A visitor's tracking decision per scope; an undecided scope is omitted. `at` is Unix milliseconds. */
export interface WebConsent {
  analytics?: 'granted' | 'denied';
  advertising?: 'granted' | 'denied';
  at: number;
}

export interface BrowserClient extends Omit<AnalyticsClient, 'identify' | 'captureAttribution' | 'revokeAttribution' | 'recordConsent'> {
  /** Records a pageview only when the sanitized URL changes. Used by router adapters. */
  pageIfChanged(context?: EventContext, props?: Properties): boolean;
  /** Current automatic context for integrations. Does not queue an event or extend the session. */
  getContext(override?: EventContext): EventContext | undefined;
  /** Context for a public form submission, including the latest campaign after navigation. Does not queue an event. */
  getFormContext(): FormContext;
  /** Resolves true on collector acknowledgement and false when consent or privacy settings prevent it. Rejects on delivery failure. */
  identify(identity: Identity, context?: EventContext): Promise<boolean>;
  captureAttribution(params?: Record<string, string>, context?: AttributionContext): boolean;
  revokeAttribution(visitorId?: string): boolean;
  /**
   * Applies the visitor's decision. `analytics` governs collection and identifiers, `advertising`
   * click-ID capture; a single state sets both. The decision is sent to the collector for the
   * visitor, before any identify(), and kept with the person they are identified as.
   */
  setConsent(state: ConsentChoice): void;
  /** The analytics state. */
  getConsent(): Consent;
  getConsentScopes(): ConsentScopes;
  /** Installs listeners once. Safe to restart after stop (including React Strict Mode). */
  start(): void;
  stop(): void;
  reset(): void;
  setEnabled(enabled: boolean): void;
}

declare global {
  interface Window {
    /** The first started browser client, for page scripts outside the application bundle such as form embeds. */
    athar?: BrowserClient;
  }
}

type Subscriber = () => void;
type Store = 'localStorage' | 'sessionStorage';
interface SiteState { revision: string; listeners: Set<() => void> }
interface WindowState {
  sites: WeakMap<Window, Map<string, SiteState>>;
  /** Visitor IDs withdrawn in this document; a stale writer cannot restore them. */
  revoked: WeakMap<Window, Set<string>>;
  histories: WeakMap<Window, { subscribers: Set<Subscriber>; cleanup: () => void }>;
}
// Separate entry bundles, or ESM and CommonJS copies, must share one document state.
const state = ((globalThis as Record<symbol, unknown>)[Symbol.for('@upax-ai/athar/state')] ??= {
  sites: new WeakMap(), revoked: new WeakMap(), histories: new WeakMap(),
}) as WindowState;

/** The platform tracker and form embeds read the visitor ID from this key. */
const visitorKey = '_athar_v';
const consentStates: readonly Consent[] = ['unknown', 'granted', 'denied'];
function consentScopes(choice: ConsentChoice, current: ConsentScopes): ConsentScopes {
  const scopes = typeof choice === 'string' ? { analytics: choice, advertising: choice }
    : { analytics: choice?.analytics ?? current.analytics, advertising: choice?.advertising ?? current.advertising };
  if (!consentStates.includes(scopes.analytics) || !consentStates.includes(scopes.advertising) ||
    (typeof choice !== 'string' && !choice?.analytics && !choice?.advertising)) throw new TypeError('Invalid consent state');
  return scopes;
}
const visitorCookieDays = 390;
/** Latest-touch campaign lifetime. */
const campaignLifetime = 90 * 24 * 60 * 60 * 1000;
const utmFields = ['source', 'medium', 'campaign', 'term', 'content'] as const;
const generatedId = (value: unknown, prefix: 'v' | 's'): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}-[a-f0-9]{32}$`).test(value);

function subscribeHistory(w: Window, subscriber: Subscriber): () => void {
  let history = state.histories.get(w);
  if (!history) {
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
    history = { subscribers, cleanup() {
      if (w.history.pushState === push) w.history.pushState = originalPush;
      if (w.history.replaceState === replace) w.history.replaceState = originalReplace;
      w.removeEventListener('popstate', notify);
      w.removeEventListener('hashchange', notify);
    } };
    state.histories.set(w, history);
  }
  history.subscribers.add(subscriber);
  return () => {
    history!.subscribers.delete(subscriber);
    if (!history!.subscribers.size) { history!.cleanup(); state.histories.delete(w); }
  };
}

/** Creates no listeners or pageviews until start() is called. Safe to import during SSR. */
export function createBrowserClient(options: BrowserOptions): BrowserClient {
  const internal = createInternalClient(options);
  const core = internal.client;
  const w = typeof window === 'undefined' ? undefined : window;
  const key = `_athar:${options.site}:`;
  let sites = w && state.sites.get(w);
  if (w && !sites) { sites = new Map(); state.sites.set(w, sites); }
  let shared = sites?.get(key);
  if (!shared) { shared = { revision: '', listeners: new Set() }; sites?.set(key, shared); }
  let revoked = w && state.revoked.get(w);
  if (w && !revoked) { revoked = new Set(); state.revoked.set(w, revoked); }
  try { if (w) shared.revision = w.localStorage.getItem(key + 'revision') ?? ''; } catch { /* Use in-memory revision. */ }
  let seenRevision = shared.revision;
  const sessionTimeout = options.sessionTimeout ?? 30 * 60 * 1000;
  if (!Number.isFinite(sessionTimeout) || sessionTimeout <= 0) throw new TypeError('sessionTimeout must be positive');
  const initial = options.consent === undefined ? undefined
    : consentScopes(options.consent, { analytics: 'unknown', advertising: 'unknown' });
  /** The analytics scope: collection, identifiers and identify(). */
  let consent: Consent = initial?.analytics ?? 'unknown';
  /** The advertising scope: click-ID capture. */
  let advertising: Consent = initial?.advertising ?? 'unknown';
  let loaded = false;
  let enabled = true;
  let terminated = false;
  let running = false;
  let visitor: string | undefined;
  /** The visitor ID this client last wrote; its absence from storage means another writer removed it. */
  let persistedVisitor: string | undefined;
  const visitors = new Set<string>();
  let session = `s-${randomId()}`;
  let sessionReferrer: string | undefined;
  let lastActivity = Date.now();
  let campaign: { values: Record<string, string>; at: number } | undefined;
  let lastPage: string | undefined;
  let previousPage: string | undefined;
  let capturedScope: string | undefined;
  let cleanup: (() => void) | undefined;

  /** Reads when value is undefined, removes when null. Returns false when the store is unavailable. */
  function raw(kind: Store, name: string, value?: string | null): string | null | false {
    try {
      const store = w?.[kind];
      if (!store) return false;
      if (value === undefined) return store.getItem(name);
      if (value === null) store.removeItem(name);
      else store.setItem(name, value);
      return null;
    } catch { return false; } // Sandboxed and private contexts may deny storage.
  }
  const storage = (kind: Store, name: string, value?: string | null) => raw(kind, key + name, value);
  function readCookie(): string | undefined {
    try {
      const parts = ('; ' + w!.document.cookie).split(`; ${visitorKey}=`);
      return parts.length === 2 ? parts.pop()!.split(';')[0] : undefined;
    } catch { return undefined; }
  }
  function writeCookie(value: string, days: number): void {
    try {
      w!.document.cookie = `${visitorKey}=${value};path=/;max-age=${days * 86400};SameSite=Lax` +
        (w!.location.protocol === 'https:' ? ';Secure' : '');
    } catch { /* Cookies may be disabled. */ }
  }
  function storedVisitor(): string | undefined {
    for (const value of [raw('localStorage', visitorKey), readCookie()]) {
      if (generatedId(value, 'v') && !revoked!.has(value)) return value;
    }
    return undefined;
  }
  function writeVisitor(id: string): boolean {
    const local = raw('localStorage', visitorKey, id) !== false;
    writeCookie(id, visitorCookieDays);
    return local || readCookie() === id;
  }
  function removeVisitor(): void {
    raw('localStorage', visitorKey, null);
    if (readCookie() !== undefined) writeCookie('', 0);
  }
  function syncIdentity(): void {
    const revision = storage('localStorage', 'revision') || shared!.revision;
    if (revision !== seenRevision) {
      internal.discard();
      for (const id of visitors) { core.revokeAttribution(id); revoked!.add(id); }
      capturedScope = undefined; visitor = undefined; persistedVisitor = undefined; visitors.clear();
      session = `s-${randomId()}`; sessionReferrer = ''; lastActivity = Date.now(); campaign = undefined;
      lastPage = undefined; previousPage = undefined;
      seenRevision = revision;
      shared!.revision = revision;
      try {
        const next = JSON.parse(revision).consent;
        if (next === 'granted' || next === 'denied' || next === 'unknown') { consent = next; loaded = true; }
      } catch { /* An absent or corrupt revision carries no consent preference. */ }
    }
  }
  function loadConsent(): void {
    if (loaded || !w) return;
    loaded = true;
    if (options.consent === undefined) {
      const saved = storage('localStorage', 'consent');
      if (saved === 'granted' || saved === 'denied') consent = saved;
      const ads = storage('localStorage', 'advertising');
      if (ads === 'granted' || ads === 'denied') advertising = ads;
    }
  }
  /**
   * Sends the current decision for a visitor to the collector, once per change: the last
   * decision sent is remembered, so a page load that only restates it sends nothing.
   */
  function publishConsent(vid: string | undefined): void {
    if (!vid) return;
    const scopes = { analytics: consent, advertising };
    const mark = JSON.stringify({ vid, ...scopes });
    if (storage('localStorage', 'consent-sent') === mark) return;
    // The collector accepts a decision made in the last day; an older one restated for a new visitor is sent as of now.
    const at = decision()?.at ?? Date.now();
    const ts = at > Date.now() - 23 * 60 * 60 * 1000 ? at : Date.now();
    if (core.recordConsent(scopes, vid, ts)) storage('localStorage', 'consent-sent', mark);
  }
  /**
   * The last decision made in this browser, in memory when storage is unavailable. It is stored as
   * `localStorage['_athar:<site>:decision']` = `{ analytics, advertising, at }` (each scope `granted`,
   * `denied` or `unknown`; `at` in Unix milliseconds), which the platform's form embed reads to send
   * `web_consent` and to keep a click ID only with advertising consent.
   */
  let decided: { analytics: Consent; advertising: Consent; at: number } | undefined;
  /**
   * The visitor's current decision and when they made it: the stored time while the scopes are
   * unchanged, a new one when they change. Undefined while neither scope is decided.
   */
  function decision(): WebConsent | undefined {
    if (consent === 'unknown' && advertising === 'unknown') return undefined;
    const current = (d: typeof decided) => !!d && d.analytics === consent && d.advertising === advertising &&
      Number.isSafeInteger(d.at) && d.at > 0;
    let saved: typeof decided;
    try { saved = JSON.parse(storage('localStorage', 'decision') || 'null') ?? undefined; } catch { /* Corrupt: replaced below. */ }
    if (current(saved)) decided = saved;
    else if (!current(decided)) {
      decided = { analytics: consent, advertising, at: Date.now() };
      storage('localStorage', 'decision', JSON.stringify(decided));
    }
    const result: WebConsent = { at: decided!.at };
    if (consent !== 'unknown') result.analytics = consent;
    if (advertising !== 'unknown') result.advertising = advertising;
    return result;
  }
  function crossTabConsent(event: StorageEvent): void {
    if (event.key === key + 'revision') { syncIdentity(); return; }
    if (event.key !== key + 'consent' && event.key !== null) return;
    loaded = false; // Read the new preference without writing a storage-event loop.
    const saved = storage('localStorage', 'consent');
    consent = saved === 'granted' || saved === 'denied' ? saved : 'unknown';
    const ads = storage('localStorage', 'advertising');
    advertising = ads === 'granted' || ads === 'denied' ? ads : 'unknown';
    loaded = true;
    // The tab that made the decision sent it to the collector.
    if (consent !== 'granted') { internal.discard(); revokeCurrent(); clearIdentity(); }
    else if (advertising !== 'granted') revokeCurrent();
  }
  let observingIdentity = false;
  function observeIdentity(): void {
    if (w && !observingIdentity && !terminated) {
      w.addEventListener('storage', crossTabConsent);
      observingIdentity = true;
    }
  }
  function allowed(): boolean {
    observeIdentity();
    syncIdentity();
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
    return stripClickIds(url.href) ?? '';
  }
  function externalReferrer(): string {
    try {
      const referrer = new URL(w!.document.referrer);
      return referrer.origin === w!.location.origin ? '' : sanitize(referrer.href);
    } catch { return ''; }
  }
  /** Granted state persists across tabs; otherwise state lasts only for this tab. */
  const store = (): Store => consent === 'granted' ? 'localStorage' : 'sessionStorage';
  function loadSession(kind: Store, now: number): { id: string; at: number; ref?: string } | undefined {
    try {
      const parsed = JSON.parse(storage(kind, 'session') || 'null') as { id: string; at: number; revision?: string; ref?: unknown };
      if (generatedId(parsed?.id, 's') && Number.isSafeInteger(parsed.at) &&
        parsed.at > 0 && parsed.at <= now && now - parsed.at < sessionTimeout &&
        (parsed.revision ?? '') === seenRevision) {
        return { id: parsed.id, at: parsed.at, ref: typeof parsed.ref === 'string' ? parsed.ref : undefined };
      }
    } catch { /* Ignore corrupt session data. */ }
    return undefined;
  }
  function loadCampaign(now = Date.now()): { values: Record<string, string>; at: number } | undefined {
    for (const kind of consent === 'granted' ? ['localStorage', 'sessionStorage'] as const : ['sessionStorage'] as const) {
      try {
        const parsed = JSON.parse(storage(kind, 'campaign') || 'null') as { values: Record<string, unknown>; at: number };
        if (!parsed?.values || typeof parsed.values !== 'object' || !Number.isSafeInteger(parsed.at) ||
          parsed.at > now || now - parsed.at >= campaignLifetime ||
          Object.values(parsed.values).some(value => typeof value !== 'string')) continue;
        const found = { values: parsed.values as Record<string, string>, at: parsed.at };
        if (!campaign || found.at >= campaign.at) campaign = found;
        break;
      } catch { /* Ignore corrupt campaign data. */ }
    }
    return campaign && now - campaign.at < campaignLifetime ? campaign : undefined;
  }
  function saveCampaign(): void {
    if (!campaign) return;
    storage(store(), 'campaign', JSON.stringify(campaign));
    if (consent === 'granted') storage('sessionStorage', 'campaign', null);
  }
  /** Any campaign tag or click ID marks a new arrival whose tags replace the stored campaign. */
  function arrivalCampaign(raw: string): Record<string, string> | undefined {
    const params = new URL(raw).searchParams;
    const values: Record<string, string> = {};
    for (const field of utmFields) {
      const value = params.get(`utm_${field}`)?.trim();
      if (value && bytes(value) <= 512) values[`utm_${field}`] = value;
    }
    Object.assign(values, attributionFromURL(raw));
    return Object.keys(values).length || hasClickId(raw) ? values : undefined;
  }
  function context(override: EventContext = {}, touch = true): EventContext {
    const now = Date.now();
    const kind = store();
    if (consent === 'granted') {
      const stored = storedVisitor();
      if (stored) visitor = stored;
      else if (!visitor || visitor === persistedVisitor) visitor = `v-${randomId()}`;
      if (visitor !== persistedVisitor && writeVisitor(visitor)) persistedVisitor = visitor;
    }
    const savedHere = loadSession(kind, now);
    // A tab-scoped session continues across tabs once consent is granted.
    const saved = savedHere ?? (kind === 'localStorage' ? loadSession('sessionStorage', now) : undefined);
    if (saved) { session = saved.id; lastActivity = saved.at; sessionReferrer = saved.ref ?? ''; }
    const fresh = now < lastActivity || now - lastActivity >= sessionTimeout;
    if (fresh) { session = `s-${randomId()}`; sessionReferrer = externalReferrer(); }
    sessionReferrer ??= externalReferrer();
    if (touch || fresh) lastActivity = now;
    if (touch || fresh || !savedHere || savedHere.ref === undefined) {
      storage(kind, 'session', JSON.stringify({ id: session, at: lastActivity, revision: seenRevision, ref: sessionReferrer }));
      if (kind === 'localStorage') storage('sessionStorage', 'session', null);
    }
    const arrivalURL = override.url ? new URL(override.url, w?.location.href).href : w?.location.href ?? '';
    const arrival = arrivalCampaign(arrivalURL);
    if (arrival) { campaign = { values: arrival, at: now }; saveCampaign(); }
    else if (kind === 'localStorage' && storage('sessionStorage', 'campaign') && loadCampaign(now)) saveCampaign();
    const utm: Record<string, string> = {};
    for (const field of utmFields) if (arrival?.[`utm_${field}`]) utm[field] = arrival[`utm_${field}`]!;
    if (consent === 'granted') visitors.add(override.visitorId ?? visitor!);
    return {
      ...override,
      url: sanitize(override.url ?? w?.location.href ?? ''),
      referrer: sanitize(override.referrer ?? previousPage ?? w?.document.referrer ?? ''),
      utm: override.utm ?? utm,
      attribution: override.attribution ?? attributionFromURL(arrivalURL),
      sessionId: override.sessionId ?? session,
      visitorId: consent === 'granted' ? override.visitorId ?? visitor : undefined,
    };
  }
  function track(name: string, props?: Properties, override?: EventContext): boolean {
    if (!allowed()) return false;
    try {
      const ctx = context(override);
      captureCurrent(override?.url, ctx);
      return core.track(name, props, ctx);
    } catch (error) { internal.report(error); return false; }
  }
  function captureCurrent(raw?: string, ctx?: EventContext, supplied?: Record<string, string>): boolean {
    if (!allowed() || consent !== 'granted' || advertising !== 'granted') return false;
    const values = clickAttribution(supplied ?? queryAttribution(new URL(raw ?? w!.location.href, w!.location.href).href));
    if (!values) return false;
    ctx ??= context();
    const scope = `${ctx.sessionId}:${ctx.visitorId}`;
    if (capturedScope === scope) return false;
    const accepted = core.captureAttribution(values, { consent: 'granted',
      sessionId: ctx.sessionId!, visitorId: ctx.visitorId!, timestamp: ctx.timestamp ?? Date.now() });
    if (accepted) capturedScope = scope;
    return accepted;
  }
  function revokeCurrent(visitorId?: string): boolean {
    if (visitorId) return core.revokeAttribution(visitorId);
    const id = visitor ?? storedVisitor();
    if (id) visitors.add(id);
    let accepted = false;
    for (const value of visitors) accepted = core.revokeAttribution(value) || accepted;
    return accepted;
  }
  function pageIfChanged(override: EventContext = {}, props?: Properties): boolean {
    if (!w || !allowed()) return false;
    try {
      const current = sanitize(override.url ?? w.location.href);
      if (current === lastPage) { captureCurrent(override.url); return false; }
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
    capturedScope = undefined;
    for (const id of visitors) revoked!.add(id);
    if (visitor) revoked!.add(visitor);
    visitor = undefined;
    persistedVisitor = undefined;
    visitors.clear();
    session = `s-${randomId()}`;
    sessionReferrer = '';
    lastActivity = Date.now();
    campaign = undefined;
    removeVisitor();
    for (const kind of ['localStorage', 'sessionStorage'] as const) {
      storage(kind, 'session', null);
      storage(kind, 'campaign', null);
    }
    seenRevision = JSON.stringify({ id: randomId(), consent });
    shared!.revision = seenRevision;
    storage('localStorage', 'revision', seenRevision);
    for (const listener of shared!.listeners) listener();
  }
  function formContext(): FormContext {
    const form: FormContext = { page_url: '', page_title: '', referrer: '' };
    if (!w) return form;
    try {
      form.page_url = sanitize(w.location.href);
      form.page_title = w.document.title;
      form.referrer = sanitize(w.document.referrer);
      const known = allowed();
      const web = decision();
      if (web) form.web_consent = web;
      if (!known) return form;
      const ctx = context({}, false);
      if (sessionReferrer) form.referrer = sessionReferrer;
      Object.assign(form, loadCampaign()?.values);
      if (ctx.visitorId) form.visitor_id = ctx.visitorId;
      // A click ID is never stored by the SDK; only the current consented arrival can supply one.
      const click = consent === 'granted' && advertising === 'granted' ? clickId(queryAttribution(w.location.href)) : undefined;
      if (click) form[click.key] = click.value;
    } catch (error) { internal.report(error); }
    return form;
  }
  const client: BrowserClient = {
    track,
    pageIfChanged,
    getContext: override => {
      if (!allowed()) return undefined;
      try { return context(override, false); } catch (error) { internal.report(error); return undefined; }
    },
    getFormContext: formContext,
    captureAttribution: (params, override) => allowed() && consent === 'granted' && advertising === 'granted'
      ? captureCurrent(undefined, context(override), params) : false,
    revokeAttribution: revokeCurrent,
    page: (override, props) => track('page_view', props ?? { title: w?.document.title ?? '' }, override),
    async identify(identity, override) {
      if (!allowed() || consent !== 'granted') return false;
      const ctx = context(override);
      captureCurrent(override?.url, ctx);
      await core.identify(identity, ctx);
      return true;
    },
    flush: () => { syncIdentity(); return core.flush(); },
    async shutdown() { syncIdentity(); client.stop(); terminated = true; w?.removeEventListener('storage', crossTabConsent); shared!.listeners.delete(syncIdentity); await core.shutdown(); },
    setConsent(choice) {
      syncIdentity(); loadConsent();
      const scopes = consentScopes(choice, { analytics: consent, advertising });
      const next = scopes.analytics;
      // A withdrawal is sent for the visitors it ends, before their identifiers are cleared.
      const ending = next === 'granted' ? [] : [...new Set([...visitors, visitor ?? storedVisitor()])];
      consent = next; advertising = scopes.advertising; loaded = true;
      for (const [name, state] of [['consent', next], ['advertising', advertising]] as const) {
        storage('localStorage', name, state === 'unknown' ? null : state);
      }
      if (next === 'unknown' && advertising === 'unknown') { decided = undefined; storage('localStorage', 'decision', null); }
      else decision();
      if (next !== 'granted') {
        for (const vid of ending) publishConsent(vid);
        internal.discard(); revokeCurrent(); clearIdentity();
      } else {
        if (advertising !== 'granted') revokeCurrent();
        if (allowed()) publishConsent(context({}, false).visitorId);
      }
      // The current page was already recorded unless collection was denied.
      if (next === 'denied') { lastPage = undefined; previousPage = undefined; }
      if (running && options.autoPageviews !== false && next !== 'denied') autoPage();
      else if (running && next === 'granted') captureCurrent();
    },
    getConsent() { syncIdentity(); loadConsent(); return consent; },
    getConsentScopes() { syncIdentity(); loadConsent(); return { analytics: consent, advertising }; },
    setEnabled(value) {
      enabled = value;
      if (!value) internal.discard();
    },
    reset() {
      internal.discard(); revokeCurrent(); clearIdentity(); lastPage = undefined; previousPage = undefined;
    },
    start() {
      if (!w || running || terminated) return;
      running = true;
      if (!w.athar) w.athar = client;
      observeIdentity();
      syncIdentity(); loadConsent();
      // Stores a known decision for other scripts on the origin; storing a preference needs no consent.
      decision();
      // The visitor key is shared with other trackers on this origin; only an explicit denial removes it.
      if (consent === 'denied' && (visitor || storedVisitor())) {
        publishConsent(visitor ?? storedVisitor());
        internal.discard(); revokeCurrent(); clearIdentity();
      } else if (consent === 'granted' && allowed()) {
        // A decision supplied at construction reaches the collector once.
        publishConsent(context({}, false).visitorId);
      }
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
      w.addEventListener('pagehide', lifecycleFlush);
      w.addEventListener('online', online);
      w.document.addEventListener('visibilitychange', visibility);
      w.document.addEventListener('click', click);
      cleanup = () => {
        removeHistory();
        w.removeEventListener('pagehide', lifecycleFlush);
        w.removeEventListener('online', online);
        w.document.removeEventListener('visibilitychange', visibility);
        w.document.removeEventListener('click', click);
      };
      if (options.autoPageviews !== false && options.initialPageview !== false) autoPage();
      else if (allowed() && consent === 'granted') captureCurrent();
    },
    stop() {
      cleanup?.(); cleanup = undefined; running = false;
      if (w?.athar === client) delete w.athar;
    },
  };
  if (w) shared.listeners.add(syncIdentity);
  return client;
}

export type { AnalyticsEvent, Consent, EventContext, Identity, Properties } from './types';
