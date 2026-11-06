"use client";

import { Suspense, useEffect, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation.js';
import { AtharProvider, useAthar } from '@upax-ai/athar/react';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from '@upax-ai/athar/browser';

export interface NextClient extends BrowserClient { readonly autoPageviewsEnabled: boolean }

export function createNextClient(options: BrowserOptions): NextClient {
  return Object.assign(createBrowserClient({ ...options, historyTracking: false, initialPageview: false }), {
    autoPageviewsEnabled: options.autoPageviews !== false,
  });
}

/** How long a pageview waits for metadata before it is sent without it. */
const metadataWait = 3000;

/**
 * Calls back once the route's metadata is in the document. Next streams metadata behind its own
 * Suspense boundary, so a navigation can commit with the old tags removed and the new ones not yet
 * there: the title is empty until they arrive, and they arrive in one commit. Returns a cancel.
 */
function whenMetadataSettled(callback: () => void): () => void {
  if (document.title) { callback(); return () => {}; }
  const done = () => { cancel(); callback(); };
  const observer = new MutationObserver(() => { if (document.title) done(); });
  const deadline = setTimeout(done, metadataWait);
  const cancel = () => { observer.disconnect(); clearTimeout(deadline); };
  // Streamed tags can land in the body before React moves them to the head.
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  return cancel;
}

function Pageviews({ client, enabled }: { client: BrowserClient; enabled: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams()?.toString();
  useEffect(() => {
    if (enabled && pathname !== null) return whenMetadataSettled(() => client.pageIfChanged());
  }, [client, enabled, pathname, search]);
  return null;
}

/** App Router provider. The Suspense boundary keeps static rendering of children intact. */
export function AtharNextProvider({ client, children }: {
  client: NextClient; children?: ReactNode;
}) {
  return <AtharProvider client={client}>
    <Suspense fallback={null}><Pageviews client={client} enabled={client.autoPageviewsEnabled} /></Suspense>
    {children}
  </AtharProvider>;
}

export { useAthar };
export type { BrowserClient, BrowserOptions } from '@upax-ai/athar/browser';
