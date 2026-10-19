// @vitest-environment jsdom
import '@angular/compiler';
import { APP_INITIALIZER, Injector, PLATFORM_ID, createEnvironmentInjector, runInInjectionContext, type EnvironmentInjector } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { ATHAR, injectAthar, provideAthar } from '../src/angular';

afterEach(() => { history.replaceState({}, '', '/'); });

function setup(platform = 'browser', withRouter = true) {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const events = new Subject<NavigationStart | NavigationEnd>();
  const injector = createEnvironmentInjector([
    { provide: PLATFORM_ID, useValue: platform },
    ...(withRouter ? [{ provide: Router, useValue: { events, navigated: false } }] : []),
    provideAthar({ site: 'angular-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 }),
  ], Injector.NULL as EnvironmentInjector);
  for (const initialize of injector.get(APP_INITIALIZER)) runInInjectionContext(injector, initialize);
  return { fetcher, events, injector, client: injector.get(ATHAR) };
}

it('injects the client, tracks successful Angular navigations and unsubscribes on injector destruction', async () => {
  const original = history.pushState;
  const { client, fetcher, events, injector } = setup();
  expect(runInInjectionContext(injector, injectAthar)).toBe(client);
  expect(history.pushState).toBe(original);
  events.next(new NavigationStart(1, '/'));
  await client.flush(); expect(fetcher).not.toHaveBeenCalled();
  events.next(new NavigationEnd(1, '/', '/'));
  events.next(new NavigationEnd(1, '/', '/'));
  await Promise.resolve();
  history.pushState({}, '', '/finished');
  events.next(new NavigationEnd(2, '/finished', '/finished'));
  document.title = 'Finished';
  await Promise.resolve();
  await client.flush();
  const received = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(received).toHaveLength(2); expect(received[1].props.title).toBe('Finished');
  injector.destroy(); expect(events.observed).toBe(false);
  await client.shutdown();
});

it('starts in applications without Angular Router and remains inactive for server rendering', async () => {
  const plain = setup('browser', false);
  await plain.client.flush(); expect(plain.fetcher).toHaveBeenCalledTimes(1);
  plain.injector.destroy(); await plain.client.shutdown();
  const server = setup('server');
  server.events.next(new NavigationEnd(1, '/', '/'));
  await server.client.flush(); expect(server.fetcher).not.toHaveBeenCalled();
  server.injector.destroy(); await server.client.shutdown();
});
