// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AtharProvider, useAthar } from '../src/react';
import { createBrowserClient } from '../src/browser';

it('supports React Strict Mode without duplicate initial pageviews and cleans up on unmount', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const client = createBrowserClient({ host: 'https://collector.example', site: 'react-site', fetch: fetcher, flushInterval: 0 });
  function Button() { const analytics = useAthar(); return <button onClick={() => analytics.track('clicked')}>Track</button>; }
  const container = document.createElement('div'); document.body.append(container);
  const original = history.pushState;
  const root = createRoot(container);
  await act(async () => { root.render(<StrictMode><AtharProvider client={client}><Button /></AtharProvider></StrictMode>); });
  await act(async () => { container.querySelector('button')!.click(); });
  await client.flush();
  const events = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(events.filter(event => event.name === 'page_view')).toHaveLength(1);
  expect(events.filter(event => event.name === 'clicked')).toHaveLength(1);
  await act(async () => { root.unmount(); });
  expect(history.pushState).toBe(original);
  await client.shutdown(); container.remove();
});
