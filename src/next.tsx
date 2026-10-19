"use client";

import { Suspense, useEffect, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation.js';
import { AtharProvider, useAthar } from '@upax/athar/react';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from './browser';

export interface NextClient extends BrowserClient { readonly autoPageviewsEnabled: boolean }

export function createNextClient(options: BrowserOptions): NextClient {
  return Object.assign(createBrowserClient({ ...options, historyTracking: false, initialPageview: false }), {
    autoPageviewsEnabled: options.autoPageviews !== false,
  });
}

function Pageviews({ client, enabled }: { client: BrowserClient; enabled: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams()?.toString();
  useEffect(() => { if (enabled && pathname !== null) client.pageIfChanged(); }, [client, enabled, pathname, search]);
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
export type { BrowserClient, BrowserOptions } from './browser';
