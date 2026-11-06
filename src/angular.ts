import { DestroyRef, EnvironmentInjector, InjectionToken, PLATFORM_ID, afterNextRender, inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { stopAndFlush } from './adapter';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from '@upax-ai/athar/browser';

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
      const injector = inject(EnvironmentInjector);
      // Router updates the document title after emitting NavigationEnd, and the routed component
      // first initializes in the next render, so anything it puts in the head comes after both.
      const navigate = () => afterNextRender(() => {
        if (disposed) return;
        client.start();
        if (options.autoPageviews !== false) client.pageIfChanged();
      }, { injector });
      const subscription = router.events.subscribe(event => { if (event instanceof NavigationEnd) navigate(); });
      if (router.navigated) navigate();
      destroy.onDestroy(() => { disposed = true; subscription.unsubscribe(); stopAndFlush(client); });
    }),
  ]);
}

export function injectAthar(): BrowserClient { return inject(ATHAR); }
export type { BrowserClient, BrowserOptions } from '@upax-ai/athar/browser';
