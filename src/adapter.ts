import { createBrowserClient, type BrowserClient, type BrowserOptions } from '@upax/athar/browser';

/** Shared lifecycle for adapters which observe completed framework navigation. */
export function createRouterAdapter(options: BrowserOptions) {
  const client = createBrowserClient({ ...options, historyTracking: false, initialPageview: false });
  let disposed = false;
  return {
    client,
    navigate() {
      if (disposed) return;
      client.start();
      if (options.autoPageviews !== false) client.pageIfChanged();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopAndFlush(client);
    },
  };
}

export function stopAndFlush(client: BrowserClient): void {
  client.stop();
  void client.flush().catch(() => { /* Delivery observers already receive automatic errors. */ });
}
