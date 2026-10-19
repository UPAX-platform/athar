import { getContext, onMount, setContext } from 'svelte';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from './browser';
import { stopAndFlush } from './adapter';

const atharKey = Symbol.for('@upax/athar/svelte');

/** Call during root component initialization, once per component tree. */
export function provideAthar(options: BrowserOptions): BrowserClient {
  const client = createBrowserClient(options);
  setContext(atharKey, client);
  onMount(() => { client.start(); return () => stopAndFlush(client); });
  return client;
}

export function useAthar(): BrowserClient {
  const client = getContext<BrowserClient | undefined>(atharKey);
  if (!client) throw new Error('Call provideAthar in an ancestor component before useAthar');
  return client;
}

export type { BrowserClient, BrowserOptions } from './browser';
