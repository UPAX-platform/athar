// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { createAtharPlugin, useAthar, type VueRouter } from '../src/vue';
import type { BrowserClient } from '../src/browser';

afterEach(() => { document.body.innerHTML = ''; history.replaceState({}, '', '/'); });

it('provides an independent client per app and removes tracking on unmount', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const clients: BrowserClient[] = [];
  const component = defineComponent({ setup() { clients.push(useAthar()); return () => h('div'); } });
  const plugin = createAtharPlugin({ site: 'vue-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 });
  const original = history.pushState;
  const apps = [createApp(component), createApp(component)];
  for (const app of apps) { const element = document.createElement('div'); document.body.append(element); app.use(plugin).mount(element); }
  expect(clients[0]).not.toBe(clients[1]);
  await Promise.all(clients.map(client => client.flush()));
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const app of apps) app.unmount();
  expect(history.pushState).toBe(original);
  await Promise.all(clients.map(client => client.shutdown()));
});

it('waits for Vue Router readiness, ignores failures, deduplicates navigation and restores lifecycle', async () => {
  let ready!: () => void;
  let navigate!: Parameters<VueRouter['afterEach']>[0];
  const remove = vi.fn();
  const router: VueRouter = { isReady: () => new Promise(resolve => { ready = resolve; }), afterEach(callback) { navigate = callback; return remove; } };
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  let client!: BrowserClient;
  const component = defineComponent({ setup() { client = useAthar(); return () => h('div'); } });
  const root = document.createElement('div'); document.body.append(root);
  const original = history.pushState;
  const app = createApp(component).use(createAtharPlugin({ router, site: 'vue-router', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 }));
  app.mount(root);
  expect(fetcher).not.toHaveBeenCalled(); expect(history.pushState).toBe(original);
  ready(); await nextTick(); await nextTick();
  navigate({ fullPath: '/' }, { fullPath: '/' });
  history.pushState({}, '', '/finished'); document.title = 'Finished';
  navigate({ fullPath: '/finished' }, { fullPath: '/' }, new Error('cancelled'));
  await client.flush();
  expect(fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events)).toHaveLength(1);
  navigate({ fullPath: '/finished' }, { fullPath: '/' });
  await nextTick();
  await client.flush();
  const events = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ url: 'http://localhost:3000/finished', props: { title: 'Finished' }, ref: 'http://localhost:3000/' });
  app.unmount(); expect(remove).toHaveBeenCalledTimes(1); await client.shutdown();
});

it('does not start a Vue client if readiness resolves after unmount', async () => {
  let ready!: () => void;
  const router: VueRouter = { isReady: () => new Promise(resolve => { ready = resolve; }), afterEach: () => () => {} };
  const fetcher = vi.fn();
  const original = history.pushState;
  const app = createApp({ render: () => h('div') }).use(createAtharPlugin({ router, site: 'vue-late', host: 'https://collector.example', fetch: fetcher }));
  const root = document.createElement('div'); app.mount(root); app.unmount(); ready();
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled(); expect(history.pushState).toBe(original);
});
