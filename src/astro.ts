import { createRouterAdapter } from './adapter';
import type { BrowserClient, BrowserOptions } from './browser';

export interface AstroAnalytics {
  client: BrowserClient;
  /** Remove the page-load listener and flush pending events (also useful for HMR). */
  dispose(): void;
}

/** Call once from a shared layout's processed client script. No Astro runtime dependency. */
export function installAthar(options: BrowserOptions): AstroAnalytics {
  const adapter = createRouterAdapter(options);
  if (typeof document === 'undefined') return { client: adapter.client, dispose: adapter.dispose };
  const navigate = () => adapter.navigate();
  document.addEventListener('astro:page-load', navigate);
  // Processed scripts run once, possibly after the initial page-load event.
  navigate();
  return {
    client: adapter.client,
    dispose() { document.removeEventListener('astro:page-load', navigate); adapter.dispose(); },
  };
}

export type { BrowserClient, BrowserOptions } from './browser';
