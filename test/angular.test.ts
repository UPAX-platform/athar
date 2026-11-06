// @vitest-environment jsdom
import '@angular/compiler';
import { PLATFORM_ID, runInInjectionContext } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { ATHAR, injectAthar, provideAthar } from '../src/angular';

afterEach(() => { history.replaceState({}, '', '/'); });

async function setup(platform = 'browser', withRouter = true) {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const events = new Subject<NavigationStart | NavigationEnd>();
  const app = await createApplication({ providers: [
    { provide: PLATFORM_ID, useValue: platform },
    { provide: Router, useValue: withRouter ? { events, navigated: false } : null },
    provideAthar({ site: 'angular-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 }),
  ] });
  return { fetcher, events, app, injector: app.injector, client: app.injector.get(ATHAR) };
}

it('injects the client, tracks successful Angular navigations and unsubscribes on injector destruction', async () => {
  const original = history.pushState;
  const { client, fetcher, events, injector, app } = await setup();
  expect(runInInjectionContext(injector, injectAthar)).toBe(client);
  expect(history.pushState).toBe(original);
  events.next(new NavigationStart(1, '/'));
  await client.flush(); expect(fetcher).not.toHaveBeenCalled();
  events.next(new NavigationEnd(1, '/', '/'));
  events.next(new NavigationEnd(1, '/', '/'));
  app.tick();
  history.pushState({}, '', '/finished');
  events.next(new NavigationEnd(2, '/finished', '/finished'));
  document.title = 'Finished';
  app.tick();
  await client.flush();
  const received = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(received).toHaveLength(2); expect(received[1].props.title).toBe('Finished');
  app.destroy(); expect(events.observed).toBe(false);
  await client.shutdown();
});

it('starts in applications without Angular Router and remains inactive for server rendering', async () => {
  const plain = await setup('browser', false);
  await plain.client.flush(); expect(plain.fetcher).toHaveBeenCalledTimes(1);
  plain.app.destroy(); await plain.client.shutdown();
  const server = await setup('server');
  server.events.next(new NavigationEnd(1, '/', '/'));
  await server.client.flush(); expect(server.fetcher).not.toHaveBeenCalled();
  server.app.destroy(); await server.client.shutdown();
});
