import { afterNavigate } from '$app/navigation';
import { provideAthar as provideSvelteAthar } from '@upax-ai/athar/svelte';
import type { BrowserClient, BrowserOptions } from '@upax-ai/athar/browser';

/** Call in the root +layout.svelte script. Completed navigations drive pageviews. */
export function provideAthar(options: BrowserOptions): BrowserClient {
  // Svelte owns mounting and context; this adapter owns the pageview lifecycle.
  const client = provideSvelteAthar({ ...options, historyTracking: false, initialPageview: false });
  afterNavigate(() => {
    // afterNavigate is a browser-only lifecycle hook and includes the initial mount.
    if (options.autoPageviews !== false) client.pageIfChanged();
  });
  // Do not keep a module-global client: SSR component trees must remain isolated.
  return client;
}

export { useAthar } from '@upax-ai/athar/svelte';
export type { BrowserClient, BrowserOptions } from '@upax-ai/athar/browser';
