// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AtharNextProvider, createNextClient } from '../src/next';
import { useAthar } from '../src/react';

const route = vi.hoisted(() => ({ pathname: '/' as string | null, search: '' }));
vi.mock('next/navigation.js', () => ({ usePathname: () => route.pathname, useSearchParams: () => new URLSearchParams(route.search) }));
beforeEach(() => { document.title = 'Home'; });
afterEach(() => { history.replaceState({}, '', '/'); route.pathname = '/'; route.search = ''; vi.useRealTimers(); });

it('shares the React context, waits for route commits and deduplicates Strict Mode and query-only changes', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const client = createNextClient({ site: 'next-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 });
  function Button() { const analytics = useAthar(); expect(analytics).toBe(client); return <button onClick={() => analytics.track('click')}>Track</button>; }
  const container = document.createElement('div'); document.body.append(container);
  const original = history.pushState;
  const root = createRoot(container);
  const render = () => root.render(<StrictMode><AtharNextProvider client={client}><Button /></AtharNextProvider></StrictMode>);
  await act(async () => { render(); });
  await client.flush();
  expect(history.pushState).toBe(original);
  history.pushState({}, '', '/finished'); document.title = 'Finished'; route.pathname = '/finished';
  await act(async () => { render(); });
  route.search = 'private=one'; history.replaceState({}, '', '/finished?private=one');
  await act(async () => { render(); container.querySelector('button')!.click(); });
  await client.flush();
  const events = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(events.filter(event => event.name === 'page_view')).toHaveLength(2);
  expect(events[1]).toMatchObject({ url: 'http://localhost:3000/finished', props: { title: 'Finished' } });
  expect(events.filter(event => event.name === 'click')).toHaveLength(1);
  await act(async () => { root.unmount(); });
  await client.shutdown(); container.remove();
});

it('honors disabled pageviews and does not record a view before the router is ready', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const disabled = createNextClient({ site: 'next-disabled', host: 'https://collector.example', fetch: fetcher, autoPageviews: false, flushInterval: 0 });
  const client = createNextClient({ site: 'next-wait', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 });
  const container = document.createElement('div'); const root = createRoot(container);
  await act(async () => { root.render(<AtharNextProvider client={disabled} />); });
  await disabled.flush(); expect(fetcher).not.toHaveBeenCalled();
  route.pathname = null;
  await act(async () => { root.render(<AtharNextProvider client={client} />); });
  await client.flush(); expect(fetcher).not.toHaveBeenCalled();
  route.pathname = '/';
  await act(async () => { root.render(<AtharNextProvider client={client} />); });
  await client.flush(); expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { root.unmount(); });
  await disabled.shutdown(); await client.shutdown();
});

it('holds the pageview while streamed metadata is pending, and sends it with the tags once they land', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const client = createNextClient({ site: 'next-pending', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 });
  const root = createRoot(document.createElement('div'));
  document.title = '';
  await act(async () => { root.render(<AtharNextProvider client={client} />); });
  await client.flush(); expect(fetcher).not.toHaveBeenCalled();
  document.title = 'Arrived';
  await new Promise(resolve => setTimeout(resolve));
  await client.flush();
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).events[0].props.title).toBe('Arrived');
  await act(async () => { root.unmount(); }); await client.shutdown();
});

it('sends the pageview anyway when no title ever arrives, and not at all after leaving the route', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const client = createNextClient({ site: 'next-untitled', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 });
  const root = createRoot(document.createElement('div'));
  document.title = '';
  await act(async () => { root.render(<AtharNextProvider client={client} />); });
  vi.advanceTimersByTime(2999);
  await client.flush(); expect(fetcher).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  await client.flush(); expect(fetcher).toHaveBeenCalledTimes(1);

  fetcher.mockClear();
  history.pushState({}, '', '/left'); route.pathname = '/left';
  await act(async () => { root.render(<AtharNextProvider client={client} />); });
  await act(async () => { root.unmount(); });
  vi.advanceTimersByTime(3000);
  await client.flush(); expect(fetcher).not.toHaveBeenCalled();
  await client.shutdown();
});
