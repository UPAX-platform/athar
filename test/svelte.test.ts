// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import App from './fixtures/SvelteApp.svelte';
import KitApp from './fixtures/SvelteKitApp.svelte';
import type { BrowserClient } from '../src/browser';

const navigation = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock('$app/navigation', async () => {
  const { onMount, onDestroy } = await import('svelte');
  return { afterNavigate(callback: () => void) {
    navigation.callbacks.add(callback);
    onMount(() => { callback(); });
    onDestroy(() => navigation.callbacks.delete(callback));
  } };
});
afterEach(() => { history.replaceState({}, '', '/'); document.body.innerHTML = ''; });

it('shares Svelte context with children, starts on mount and cleans up on unmount', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  let client!: BrowserClient;
  const original = history.pushState;
  const target = document.createElement('div'); document.body.append(target);
  const app = mount(App, { target, props: { options: { site: 'svelte-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 }, ready: (value: BrowserClient) => { client = value; } } });
  flushSync(); target.querySelector('button')!.click();
  await client.flush();
  const events = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(events.map(event => event.name)).toEqual(['page_view', 'child-click']);
  await unmount(app); expect(history.pushState).toBe(original);
  await client.shutdown();
});

it('uses completed SvelteKit navigation without History instrumentation and deduplicates the initial mount', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  let client!: BrowserClient;
  const original = history.pushState;
  const target = document.createElement('div'); document.body.append(target);
  const app = mount(KitApp, { target, props: { options: { site: 'kit-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 }, ready: (value: BrowserClient) => { client = value; } } });
  flushSync(); expect(history.pushState).toBe(original);
  for (const callback of navigation.callbacks) callback();
  history.pushState({}, '', '/finished'); document.title = 'Finished';
  for (const callback of navigation.callbacks) callback();
  target.querySelector('button')!.click(); await client.flush();
  const events = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(events.filter(event => event.name === 'page_view')).toHaveLength(2);
  expect(events[1]).toMatchObject({ props: { title: 'Finished' }, ref: 'http://localhost:3000/' });
  expect(events[2].name).toBe('child-click');
  await unmount(app); expect(navigation.callbacks.size).toBe(0);
  await client.shutdown();
});
