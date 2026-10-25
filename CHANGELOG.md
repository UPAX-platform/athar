# Changelog

## 0.1.0 — 2026-10-25

First public release, published as `@upax-ai/athar`.

- Target the tenant public-plane URL grammar: `host` is the tenant's public origin (`https://<label>.upax.io`, a branded host, or a proxy prefix), and requests go to `/athar/<site>/ev`, `/athar/<site>/id`, and `/athar/<site>/attr` instead of `/v1/e`, `/v1/id`, and `/v1/attribution`. The site token moved from the request body into the path.
- Add `web_consent` to `getFormContext()`: `{ analytics?, advertising?, at }`, the visitor's per-scope decision as sent to `/athar/<site>/opt` and the Unix milliseconds of their last decision, omitted until they decide. Form endpoints admit a click ID only when `web_consent.advertising` is `granted`.
- Remove `consent` from `getFormContext()` and `FormContext`, and stop writing `localStorage._athar_c`. Form embeds read the per-scope decision from `localStorage['_athar:<site>:decision']` (`{ analytics, advertising, at }`), which `start()` now also stores for a decision supplied at construction.
- Send consent to the collector: `setConsent()` posts the visitor's decision per scope (`analytics`, `advertising`) to `POST /athar/<site>/opt` for the visitor it applies to, once per change and before any later `identify()`, so the collector can give it to the person the visitor is identified as. `setConsent()` and the `consent` option accept `{ analytics?, advertising? }`; `advertising` alone governs click-ID capture. Add `getConsentScopes()` and the core `recordConsent()`. An event named `consent*` is an ordinary event.
- Add `getFormContext()`: the flat public-form context, with campaign tags and descriptors kept across navigation (90 days with consent, the tab without), the session's external referrer, and a consented click ID from the current URL. Click IDs are still never stored.
- Store the consented visitor ID in `localStorage._athar_v` and the `_athar_v` cookie, matching the platform tracker and form embeds. Unknown consent no longer removes the shared ID.
- Keep unknown-consent sessions for the tab (`sessionStorage`) instead of per page load; share granted sessions across tabs.
- Granting consent no longer records the current page a second time.
- `getContext()` no longer extends the session.
- Browser `identify()` resolves `true` on acknowledgement and `false` when consent or privacy settings prevent it.
- Drop batches refused with 400/413 (reported as `CollectorError`) instead of blocking the queue; schedule backed-off retries after failed flushes; beacon events queued behind an in-flight request.
- Framework entries import `@upax-ai/athar/browser` instead of bundling their own copy (about 1 KB each), and document state is shared between SDK copies.
- Add `AtharClient`, `isBrowserClient`, and `createServerClient`.

- Expose consent-aware browser `getContext()` for form integrations and bind persisted visitor IDs to reset revisions.

- Validate generated IDs and stored session timestamps; synchronize identity resets across client instances and tabs.

- Automatically start browser collection from `createClient`; preserve explicit browser lifecycle through `createBrowserClient`.
- Honor browser identity/context overrides for events, identification, and attribution while preserving consent controls.

- Configure catalogue sync with `ATHAR_ATTRIBUTION_SOURCE` (file path or HTTP(S) URL), with no default source.

- Add consent-gated click-ID capture, a separate delivery queue, and token-free withdrawal on consent changes/reset.

- Capture all supported campaign descriptors in browser/framework events and support explicit attribution in Node.js context.
- Filter attribution against the published catalogue and remove click-ID query parameters from analytics URLs.
- Capture UTM and campaign descriptors from router URL overrides.

## 0.1.0

- Optional Vue, Angular, Svelte/SvelteKit, Next.js App Router, and Astro integrations.
- Framework navigation hooks, deduplicated pageviews, shared context, and lifecycle cleanup.

- Initial standalone browser, Node.js, and optional React SDK.
- Typed ESM and CommonJS exports with zero runtime dependencies.
- Event batching, payload validation, bounded queue, backoff, and awaitable delivery.
- Consent controls, opt-out, DNT/GPC, site-scoped identities, and URL sanitization.
- Automatic SPA pageviews, annotated clicks, lifecycle flushing, and React provider.
