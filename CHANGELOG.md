# Changelog

## Unreleased

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
