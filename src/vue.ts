import { inject, nextTick, type InjectionKey, type Plugin } from 'vue';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from '@upax/athar/browser';
import { createRouterAdapter, stopAndFlush } from './adapter';

const atharKey: InjectionKey<BrowserClient> = Symbol('athar');

/** Structurally compatible with Vue Router; no router dependency for plain Vue. */
export interface VueRouter {
  isReady(): Promise<void>;
  afterEach(callback: (to: { fullPath: string }, from: { fullPath: string }, failure?: unknown) => void): () => void;
}
export interface VueOptions extends BrowserOptions { router?: VueRouter }

/** Creates a fresh client per application; install once with app.use(). Requires Vue 3.5+. */
export function createAtharPlugin(options: VueOptions): Plugin {
  return {
    install(app) {
      if (options.router) {
        const adapter = createRouterAdapter(options);
        app.provide(atharKey, adapter.client);
        let ready = false;
        const remove = options.router.afterEach((_to, _from, failure) => {
          if (ready && !failure) void nextTick(() => adapter.navigate());
        });
        void options.router.isReady().then(() => { ready = true; return nextTick(() => adapter.navigate()); }, error => {
          try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Observer isolation. */ }
        });
        app.onUnmount(() => { remove(); adapter.dispose(); });
      } else {
        const client = createBrowserClient(options);
        app.provide(atharKey, client);
        client.start();
        app.onUnmount(() => stopAndFlush(client));
      }
    },
  };
}

export function useAthar(): BrowserClient {
  const client = inject(atharKey);
  if (!client) throw new Error('Install createAtharPlugin before calling useAthar');
  return client;
}

export type { BrowserClient, BrowserOptions } from '@upax/athar/browser';
