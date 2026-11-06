import type { AnalyticsClient, AnalyticsEvent } from './types';

/** A reader's thumb on a document. */
export type FolioReaction = 'up' | 'down';

/** The page's document and locale, read now. Absent in SSR, without the metas, or when a meta is empty. */
function metas(): { doc?: string; locale?: string } {
  const found: { doc?: string; locale?: string } = {};
  if (typeof document === 'undefined') return found;
  for (const name of ['doc', 'locale'] as const) {
    const content = document.querySelector(`meta[name="folio:${name}"]`)?.getAttribute('content')?.trim();
    if (content) found[name] = content;
  }
  return found;
}

/**
 * Returns a `beforeSend` that adds `doc` and `locale` to every event from the page's
 * `<meta name="folio:doc">` and `<meta name="folio:locale">`. The metas are read as each event
 * is sent, so a pageview is credited to the document on the page when it fires: fire it after
 * the new page's metas are rendered. A prop the caller set wins. Without the metas, or without
 * `document`, the event passes through unchanged.
 *
 * To keep your own filter, compose them: `beforeSend: event => tag(yours(event))`. A null from
 * yours passes through, so the event is still dropped.
 */
export function folioContext(): <E extends AnalyticsEvent | null>(event: E) => E {
  return <E extends AnalyticsEvent | null>(event: E): E => {
    if (event === null) return event;
    const tags = metas();
    if (!tags.doc && !tags.locale) return event;
    return { ...(event as AnalyticsEvent), props: { ...tags, ...event.props } } as E;
  };
}

/**
 * Records the reader's reaction to the page's document as `folio_reaction`, then flushes. It reads
 * the metas itself, so it works without `folioContext()`.
 *
 * Resolves true when the SDK accepted the event into its send queue. That is all "accepted" means:
 * it is not a delivery receipt, and it never means "stored". A failed flush still resolves true,
 * because the SDK keeps the event and retries, and the collector answers a silent 204 past
 * admission even for an event it does not keep.
 *
 * Resolves false when nothing was queued: consent is denied, Do Not Track or Global Privacy Control
 * applies, a `beforeSend` dropped it, the queue is full, or the page has no `folio:doc` and
 * `folio:locale` metas to credit. Never rejects. Do not thank the reader on false.
 */
export async function sendReaction(client: Pick<AnalyticsClient, 'track' | 'flush'>, value: FolioReaction): Promise<boolean> {
  const { doc, locale } = metas();
  if (!doc || !locale || !client.track('folio_reaction', { value, doc, locale })) return false;
  try { await client.flush(); } catch { /* The SDK keeps pending events and retries them. */ }
  return true;
}
