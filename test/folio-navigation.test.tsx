// @vitest-environment jsdom
// Navigation from document A to B, with the framework rendering the metas. The real-browser checks for
// Next, SvelteKit and Astro are in scripts/check-navigation.mjs.
//
// Vue and Angular: the real framework and its real router, under jsdom.
// React and Svelte: the real framework rendering the metas, but SIMULATED navigation. Neither adapter
// observes a router, so these tests supply the order a client-side router uses: URL first, render after.
import '@angular/compiler';
import { ApplicationRef, Component, inject, type OnInit } from '@angular/core';
import { bootstrapApplication, Meta } from '@angular/platform-browser';
import { Router, RouterOutlet, provideRouter } from '@angular/router';
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync, mount, tick, unmount } from 'svelte';
import { createApp, defineComponent, h, nextTick, onMounted, Teleport } from 'vue';
import { createRouter, createWebHistory, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideAthar as provideAngularAthar, ATHAR } from '../src/angular';
import { createBrowserClient, type BrowserClient, type BrowserOptions } from '../src/browser';
import { folioContext } from '../src/folio';
import { AtharProvider } from '../src/react';
import { createAtharPlugin, useAthar } from '../src/vue';
import SvelteFolioDocument from './fixtures/SvelteFolioDocument.svelte';
import type { AnalyticsEvent } from '../src/types';

const docA = 'd_aaaaaaaaaaaaaaaaaaaaaaaa';
const docB = 'd_bbbbbbbbbbbbbbbbbbbbbbbb';

const pathOf = (doc: string) => doc === docA ? '/a' : '/b';

let site = 0;
function collector() {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const options = { site: `nav-${++site}`, host: 'https://collector.example', fetch: fetcher, flushInterval: 0, beforeSend: folioContext() } satisfies BrowserOptions;
  const views = () => fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events as AnalyticsEvent[])
    .filter(event => event.name === 'page_view').map(event => [new URL(event.url!).pathname, event.props.doc]);
  return { options, fetcher, views };
}

beforeEach(() => { document.title = 'Site'; });
afterEach(() => {
  document.head.querySelectorAll('meta[name^="folio:"]').forEach(meta => meta.remove());
  document.body.innerHTML = ''; history.replaceState({}, '', '/a');
});

describe('Vue with vue-router (real framework and router, jsdom)', () => {
  async function run(page: (doc: string) => ReturnType<typeof defineComponent>) {
    history.replaceState({}, '', '/a');
    const { options, views } = collector();
    const router = createRouter({ history: createWebHistory(), routes: [
      { path: '/a', component: page(docA) }, { path: '/b', component: page(docB) },
    ] });
    let client!: BrowserClient;
    const root = defineComponent({ setup() { client = useAthar(); return () => h(RouterView); } });
    const host = document.createElement('div'); document.body.append(host);
    const app = createApp(root).use(router).use(createAtharPlugin({ ...options, router }));
    app.mount(host);
    await router.isReady(); await nextTick(); await nextTick();
    await router.push('/b'); await nextTick(); await nextTick();
    await client.flush();
    app.unmount();
    await client.shutdown();
    return views();
  }
  const metas = (doc: string) => [h('meta', { name: 'folio:doc', content: doc }), h('meta', { name: 'folio:locale', content: 'en-US' }), h('meta', { name: 'folio:path', content: pathOf(doc) })];

  it('credits B when the page teleports its metas into the head', async () => {
    const page = (doc: string) => defineComponent({ setup: () => () => h(Teleport, { to: 'head' }, metas(doc)) });
    expect(await run(page)).toEqual([['/a', docA], ['/b', docB]]);
  });

  it('credits B when the page sets its meta in onMounted', async () => {
    const page = (doc: string) => defineComponent({ setup() {
      onMounted(() => {
        for (const [name, content] of [['folio:doc', doc], ['folio:path', pathOf(doc)]] as const) {
          const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`) ?? document.head.appendChild(Object.assign(document.createElement('meta'), { name }));
          meta.content = content;
        }
      });
      return () => h('p');
    } });
    expect(await run(page)).toEqual([['/a', docA], ['/b', docB]]);
  });
});

describe('Angular with @angular/router (real framework and router, jsdom)', () => {
  const Root = Component({ selector: 'athar-root', imports: [RouterOutlet], template: '<router-outlet />' })(class {} as never) as unknown as new () => unknown;
  let pages = 0;
  async function boot(page: (doc: string) => new () => unknown) {
    const { options, views } = collector();
    document.body.innerHTML = '<athar-root></athar-root>';
    const app = await bootstrapApplication(Root as never, { providers: [
      provideRouter([{ path: 'a', component: page(docA) as never }, { path: 'b', component: page(docB) as never }]),
      provideAngularAthar(options),
    ] });
    // No manual tick: a view has to be reached by Angular's own scheduling.
    const settle = async () => { await app.injector.get(ApplicationRef).whenStable(); await new Promise(resolve => setTimeout(resolve, 50)); };
    await settle();
    const finish = async () => {
      const client = app.injector.get(ATHAR);
      await client.flush();
      app.destroy();
      await client.shutdown();
    };
    return { app, settle, finish, views };
  }
  async function run(page: (doc: string) => new () => unknown) {
    history.replaceState({}, '', '/a');
    const { app, settle, finish, views } = await boot(page);
    await app.injector.get(Router).navigateByUrl('/b');
    await settle();
    await finish();
    return views();
  }
  const component = (body: object) => Component({ selector: `athar-page-${++pages}`, template: '<p>page</p>' })(body as never) as unknown as new () => unknown;

  it('credits B when the page sets its meta in the constructor', async () => {
    const page = (doc: string) => component(class {
      constructor() {
        const meta = inject(Meta);
        meta.updateTag({ name: 'folio:doc', content: doc });
        meta.updateTag({ name: 'folio:path', content: pathOf(doc) });
      }
    });
    expect(await run(page)).toEqual([['/a', docA], ['/b', docB]]);
  });

  it('credits B when the page sets its meta in ngOnInit', async () => {
    const page = (doc: string) => component(class implements OnInit {
      private meta = inject(Meta);
      ngOnInit() {
        this.meta.updateTag({ name: 'folio:doc', content: doc });
        this.meta.updateTag({ name: 'folio:path', content: pathOf(doc) });
      }
    });
    expect(await run(page)).toEqual([['/a', docA], ['/b', docB]]);
  });
});

describe('Angular query-only navigation (real framework and router, jsdom)', () => {
  it('still fires when the same routed component stays and nothing needs rendering', async () => {
    history.replaceState({}, '', '/b?tab=one');
    const { options, fetcher } = collector();
    let created = 0;
    const Root = Component({ selector: 'athar-query-root', imports: [RouterOutlet], template: '<router-outlet />' })(class {} as never) as unknown as new () => unknown;
    const Page = Component({ selector: 'athar-query-page', template: '<p>page</p>' })(class {
      constructor() {
        created++;
        const meta = inject(Meta);
        meta.updateTag({ name: 'folio:doc', content: docB });
        meta.updateTag({ name: 'folio:path', content: '/b' });
      }
    } as never);
    document.body.innerHTML = '<athar-query-root></athar-query-root>';
    const app = await bootstrapApplication(Root as never, { providers: [
      provideRouter([{ path: 'b', component: Page as never }]),
      provideAngularAthar({ ...options, includeQuery: true }),
    ] });
    // No manual tick: the view has to be reached by Angular's own scheduling.
    const settle = async () => { await app.injector.get(ApplicationRef).whenStable(); await new Promise(resolve => setTimeout(resolve, 50)); };
    await settle();
    await app.injector.get(Router).navigateByUrl('/b?tab=two');
    await settle();
    const client = app.injector.get(ATHAR);
    await client.flush();
    const views = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events as AnalyticsEvent[])
      .filter(event => event.name === 'page_view').map(event => [new URL(event.url!).search, event.props.doc]);
    expect(created).toBe(1);
    expect(views).toEqual([['?tab=one', docB], ['?tab=two', docB]]);
    app.destroy();
    await client.shutdown();
  });
});

describe('React: AtharProvider has no navigation of its own (real React, simulated router)', () => {
  function Page({ doc, client, after, withPath }: { doc: string; client: BrowserClient; after: boolean; withPath: boolean }) {
    useEffect(() => { if (after) client.page(); }, [client, doc, after]);
    return <>
      <meta name="folio:doc" content={doc} /><meta name="folio:locale" content="en-US" />
      {withPath && <meta name="folio:path" content={pathOf(doc)} />}
    </>;
  }
  async function run(browser: Partial<BrowserOptions>, after: boolean, withPath: boolean) {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    history.replaceState({}, '', '/a');
    const { options, views } = collector();
    const client = createBrowserClient({ ...options, ...browser });
    let go!: (doc: string) => void;
    function App() {
      const [doc, setDoc] = useState(docA);
      go = setDoc;
      return <AtharProvider client={client}><Page doc={doc} client={client} after={after} withPath={withPath} /></AtharProvider>;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => { root.render(<App />); });
    await act(async () => { history.pushState({}, '', '/b'); go(docB); });
    await client.flush();
    await act(async () => { root.unmount(); });
    await client.shutdown();
    return views();
  }

  it('under default history tracking with folio:path, sends B with no doc, never document A', async () => {
    expect(await run({}, false, true)).toEqual([['/a', docA], ['/b', undefined]]);
  });

  it('under default history tracking without folio:path, still credits B to A', async () => {
    expect(await run({}, false, false)).toEqual([['/a', docA], ['/b', docA]]);
  });

  it.each([[true], [false]])('credits B with the supported route: historyTracking false and page() in an effect (folio:path %s)', async withPath => {
    expect(await run({ historyTracking: false, initialPageview: false }, true, withPath)).toEqual([['/a', docA], ['/b', docB]]);
  });
});

describe('Svelte: provideAthar has no navigation of its own (real Svelte, simulated router)', () => {
  async function run(browser: Partial<BrowserOptions>, after: boolean, withPath: boolean) {
    history.replaceState({}, '', '/a');
    const { options, views } = collector();
    let client!: BrowserClient; let go!: (doc: string) => void;
    const target = document.createElement('div'); document.body.append(target);
    const app = mount(SvelteFolioDocument, { target, props: { options: { ...options, ...browser }, withPath, ready: (value: BrowserClient, navigate: (doc: string) => void) => { client = value; go = navigate; } } });
    flushSync();
    history.pushState({}, '', '/b');
    go(docB);
    await tick();
    if (after) client.page();
    await client.flush();
    await unmount(app);
    await client.shutdown();
    return views();
  }

  it('under default history tracking with folio:path, sends B with no doc, never document A', async () => {
    expect(await run({}, false, true)).toEqual([['/a', docA], ['/b', undefined]]);
  });

  it('under default history tracking without folio:path, still credits B to A', async () => {
    expect(await run({}, false, false)).toEqual([['/a', docA], ['/b', docA]]);
  });

  it.each([[true], [false]])('credits B with the supported route: historyTracking false and page() after tick() (folio:path %s)', async withPath => {
    expect(await run({ historyTracking: false }, true, withPath)).toEqual([['/a', docA], ['/b', docB]]);
  });
});
