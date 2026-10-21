import { DestroyRef, InjectionToken, PLATFORM_ID, inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { stopAndFlush } from './adapter';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from '@upax/athar/browser';

export const ATHAR = new InjectionToken<BrowserClient>('Athar analytics client');

/** Add to application providers. Uses Router when registered; creates no server-side listeners. */
export function provideAthar(options: BrowserOptions): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: ATHAR, useFactory: () => createBrowserClient({ ...options, historyTracking: false, initialPageview: false }) },
    provideAppInitializer(() => {
      const client = inject(ATHAR);
      if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
      const router = inject(Router, { optional: true });
      const destroy = inject(DestroyRef);
      if (!router) {
        client.start();
        if (options.autoPageviews !== false) client.pageIfChanged();
        destroy.onDestroy(() => stopAndFlush(client));
        return;
      }
      let disposed = false;
      // Router updates the document title after emitting NavigationEnd.
      const navigate = () => queueMicrotask(() => {
        if (disposed) return;
        client.start();
        if (options.autoPageviews !== false) client.pageIfChanged();
      });
      const subscription = router.events.subscribe(event => { if (event instanceof NavigationEnd) navigate(); });
      if (router.navigated) navigate();
      destroy.onDestroy(() => { disposed = true; subscription.unsubscribe(); stopAndFlush(client); });
    }),
  ]);
}

export function injectAthar(): BrowserClient { return inject(ATHAR); }
export type { BrowserClient, BrowserOptions } from '@upax/athar/browser';
