import { createClient as createCoreClient } from './client';
import { createBrowserClient, type BrowserOptions, type BrowserClient } from './browser';
import type { AnalyticsClient } from './types';

/** A started browser client in browsers; the core client, which needs request context, elsewhere. */
export type AtharClient = AnalyticsClient | BrowserClient;

/** Automatically collect browser context; server callers supply request context. */
export function createClient(options: BrowserOptions): AtharClient {
  if (typeof window === 'undefined') return createCoreClient(options);
  const client = createBrowserClient(options);
  client.start();
  return client;
}

/** Narrows a `createClient` result to the browser client with consent and lifecycle controls. */
export function isBrowserClient(client: AtharClient): client is BrowserClient {
  return typeof (client as Partial<BrowserClient>).setConsent === 'function';
}

/** The core client in any runtime. Every event, identity, and attribution call supplies its own context. */
export { createClient as createServerClient } from './client';
export { CollectorError } from './client';
export { createBrowserClient } from './browser';
export type { BrowserOptions, BrowserClient, ConsentChoice, FormContext, WebConsent } from './browser';
export type { AnalyticsClient, AnalyticsEvent, AttributionContext, ClientOptions, Consent, ConsentScopes, EventContext, Identity, Json, Properties } from './types';
