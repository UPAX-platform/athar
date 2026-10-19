// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installAthar } from '../src/astro';

afterEach(() => { history.replaceState({}, '', '/'); });

it('tracks Astro page-load events after title updates without instrumenting history or duplicating initial views', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const original = history.pushState;
  const analytics = installAthar({ site: 'astro-site', host: 'https://collector.example', fetch: fetcher, flushInterval: 0 });
  document.dispatchEvent(new Event('astro:page-load'));
  history.pushState({}, '', '/about');
  document.title = 'About';
  document.dispatchEvent(new Event('astro:page-load'));
  document.dispatchEvent(new Event('astro:page-load'));
  await analytics.client.flush();
  const events = fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
  expect(events).toHaveLength(2); expect(events[1].props.title).toBe('About');
  expect(history.pushState).toBe(original);
  analytics.dispose();
  history.pushState({}, '', '/after-dispose'); document.dispatchEvent(new Event('astro:page-load'));
  await analytics.client.flush(); expect(fetcher).toHaveBeenCalledTimes(1);
  await analytics.client.shutdown();
});

it('respects manual pageviews and consent changes with Astro routing', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const manual = installAthar({ site: 'astro-manual', host: 'https://collector.example', fetch: fetcher, autoPageviews: false, flushInterval: 0 });
  document.dispatchEvent(new Event('astro:page-load'));
  await manual.client.flush(); expect(fetcher).not.toHaveBeenCalled();
  manual.dispose(); await manual.client.shutdown();
  const analytics = installAthar({ site: 'astro-consent', host: 'https://collector.example', fetch: fetcher, consent: 'denied', flushInterval: 0 });
  analytics.client.setConsent('granted'); await analytics.client.flush();
  expect(fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).events)).toHaveLength(1);
  analytics.dispose(); await analytics.client.shutdown();
});
