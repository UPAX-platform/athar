# Athar JavaScript SDK

Typed analytics for browsers, Node.js, React, Vue, Angular, Svelte, Next.js, and
Astro. Zero runtime dependencies, ESM and CommonJS exports, and optional framework
bindings. Node.js 22+ and modern browsers
with Fetch, Web Crypto, and ES2022 support are required.

```sh
npm install @upax/athar
```

Supply the public site token and collector base URL from your analytics setup.
The SDK has no default collector address and contains no administrative API.
A site token is public configuration, not a secret or an authentication credential.

## Browser

```ts
import { createBrowserClient } from '@upax/athar/browser';

const analytics = createBrowserClient({
  site: 'YOUR_PUBLIC_SITE_TOKEN',
  host: 'https://analytics.example.com',
});
analytics.start();
analytics.track('signup', { plan: 'pro' });

// Connect these calls to your consent interface.
analytics.setConsent('granted');
await analytics.identify({ external_id: 'account-123' });
// Or: await analytics.identify({ email: 'person@example.com' });
analytics.setConsent('denied');
```

`start()` installs automatic pageviews, History API navigation tracking, annotated
click tracking, page lifecycle flushing, and a flush when the browser comes back
online. Calling it again has no effect.
`stop()` removes listeners and leaves manual tracking available. `shutdown()`
removes listeners, stops accepting events, and drains pending data.

Automatic SPA views deduplicate the sanitized page URL, so replacing history
state or changing only ignored query parameters does not add a view. Pageviews
include the document title as a property. Call `page()` after your router updates
the title if you need precise title timing; set `autoPageviews: false` to own
pageviews entirely. A manual `page()` always records a view.

```html
<button data-athar-event="signup" data-athar-event-plan="pro">Sign up</button>
```

Only annotated click events and their explicit `data-athar-event-*` properties
are captured. Form values, text, downloads, and outbound links are not collected
automatically. You can track those with `track()` and your chosen properties.

## React and Next.js

Create one client per browser app outside render. The provider owns start/stop
and supports React Strict Mode. Use one provider per client. React is an optional
peer dependency, needed only for the `/react` entry point.

```tsx
'use client';

import { createBrowserClient } from '@upax/athar/browser';
import { AtharProvider, useAthar } from '@upax/athar/react';

const analytics = createBrowserClient({
  site: 'YOUR_PUBLIC_SITE_TOKEN',
  host: 'https://analytics.example.com',
});

function SignupButton() {
  const analytics = useAthar();
  return <button onClick={() => analytics.track('signup')}>Sign up</button>;
}

export default function App() {
  return <AtharProvider client={analytics}><SignupButton /></AtharProvider>;
}
```

Imports are safe during server rendering; no DOM is accessed at module import
and no listeners are installed during construction. Browser methods are inactive
on the server. For server events, use the core client below.

## Framework integrations

Each integration has its own import path. Install only the framework your app
uses; framework peers are optional for the core/browser client. Use one integration
per application tree. Router integrations disable History API instrumentation and
record completed navigations with URL deduplication. `autoPageviews: false`
disables integration-owned pageviews. Manual `page()` always records a view;
`pageIfChanged()` records only a changed, sanitized URL.

| Import | Integration | Framework peer |
| --- | --- | --- |
| `@upax/athar/vue` | Plugin, composable, optional Vue Router hooks | Vue 3.5+ |
| `@upax/athar/angular` | Application provider, injection helper, Router events | Angular 19–22 core/common/router |
| `@upax/athar/svelte` | Context and mount/unmount lifecycle | Svelte 4–5 |
| `@upax/athar/sveltekit` | Svelte context and `afterNavigate` | SvelteKit 2–3 and its Svelte peer |
| `@upax/athar/next` | App Router provider and shared React context | Next.js 14–16 and its React peer |
| `@upax/athar/astro` | Client installation and page-load listener | No additional SDK peer |

Tests currently use Vue 3.5, Angular 22, Svelte 5, SvelteKit 3, and Next.js 16.
Each framework's own runtime and TypeScript requirements also apply. Every entry
includes generated `.d.ts`/`.d.cts` declarations: no separate SDK types package,
global declaration, or TypeScript adapter setup file is needed.

### Vue

```ts
import { createApp } from 'vue';
import { createAtharPlugin } from '@upax/athar/vue';
import App from './App.vue';
import router from './router';

createApp(App).use(router).use(createAtharPlugin({
  site: 'YOUR_PUBLIC_SITE_TOKEN', host: 'https://analytics.example.com',
  router, // Optional: omit for plain Vue with generic SPA tracking.
})).mount('#app');
```

In component setup, import `useAthar` from `@upax/athar/vue`, then call
`useAthar().track('signup')`. Each app receives its own client. Router tracking
waits for readiness, ignores failed navigations, and cleans up on app unmount.

### Angular

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideAthar } from '@upax/athar/angular';
import { App } from './app';
import { routes } from './routes';

bootstrapApplication(App, { providers: [
  provideRouter(routes),
  provideAthar({ site: 'YOUR_PUBLIC_SITE_TOKEN', host: 'https://analytics.example.com' }),
] });
```

Import `injectAthar` from `@upax/athar/angular` and call it in a component's
injection context; `inject(ATHAR)` is also available. The provider waits for
`NavigationEnd`, or records the initial view when no Router is registered.
Server initialization installs no listeners. Injector destruction unsubscribes
and flushes. This entry requires matching Angular core, common, and router packages.

### Svelte and SvelteKit

Call the provider during the root component's instance script initialization,
once per component tree. Avoid a shared server module script. With SvelteKit,
place this in `src/routes/+layout.svelte` (Svelte 5 syntax):

```svelte
<script lang="ts">
  // Plain Svelte: import from '@upax/athar/svelte' instead.
  import { provideAthar } from '@upax/athar/sveltekit';
  let { children } = $props();
  provideAthar({ site: 'YOUR_PUBLIC_SITE_TOKEN', host: 'https://analytics.example.com' });
</script>

{@render children()}
```

Children call `useAthar()` from the same entry point. The plain Svelte and
SvelteKit entries share a context key, so children may also use `/svelte`.
Svelte 4 applications use normal `<slot />` layout syntax. Plain Svelte uses
mount/unmount and generic SPA tracking; SvelteKit observes initial and completed
navigations. The `/sveltekit` entry requires SvelteKit's bundler to resolve
`$app/navigation`; use `/svelte` in applications without SvelteKit.

### Next.js App Router

Create a client component and wrap the root layout's children with it:

```tsx
'use client';
import { useState, type ReactNode } from 'react';
import { AtharNextProvider, createNextClient } from '@upax/athar/next';

export function Analytics({ children }: { children: ReactNode }) {
  const [client] = useState(() => createNextClient({
    site: 'YOUR_PUBLIC_SITE_TOKEN', host: 'https://analytics.example.com',
  }));
  return <AtharNextProvider client={client}>{children}</AtharNextProvider>;
}
```

`useAthar()` from `/next` or `/react` accesses the same provider. The navigation
observer has its own Suspense boundary for static rendering. It waits for router
state and deduplicates Strict Mode and sanitized query-only changes. For the Pages
Router, use the regular `/react` provider with generic browser History tracking.

### Astro

Place this processed client script once in a shared layout, including when using
Astro's ClientRouter. Avoid installing it separately in each island:

```astro
<script>
  import { installAthar } from '@upax/athar/astro';
  const analytics = installAthar({
    site: 'YOUR_PUBLIC_SITE_TOKEN', host: 'https://analytics.example.com',
  });
  if (import.meta.hot) import.meta.hot.dispose(() => analytics.dispose());
</script>
```

It records the initial page and listens for `astro:page-load` after transitions.
Use `analytics.client` for events and consent. `dispose()` removes listeners and
flushes pending events; also use `client.shutdown()` when permanently retiring it.

## Node.js and other server runtimes

```ts
import { createClient } from '@upax/athar';

const analytics = createClient({
  site: process.env.ANALYTICS_SITE!,
  host: process.env.ANALYTICS_HOST!,
  onError: error => console.error(error.message),
});

// Context belongs to each event: a shared client never remembers a request's user.
analytics.track('order_completed', { amount: 49 }, {
  sessionId: 'session-123',
  visitorId: 'visitor-123',
  url: 'https://shop.example.com/checkout',
});
await analytics.identify({ external_id: 'account-123' }, { visitorId: 'visitor-123' });

// Await flush before a serverless handler returns; await shutdown on graceful exit.
await analytics.flush();
await analytics.shutdown();
```

CommonJS: `const { createClient } = require('@upax/athar')`.
Server code owns consent and supplies identity/session context explicitly. The
SDK does not forward incoming cookies, request headers, user agents, or IPs.
Events and identities sent by a backend are observed as backend requests.
`identify` requires a visitor ID or a session ID; the latter uses `s:<sessionId>`.
Identity handles are sent only to the identification endpoint, not merged into
event properties. Arbitrary profile/session traits are not supported by this
collector contract.

## Privacy and consent

| State | Events | Identity calls | Persistence |
| --- | --- | --- | --- |
| `unknown` (default) | Anonymous | Suppressed | Session identifier stays in memory |
| `granted` | Visitor + session IDs | Allowed | Site-scoped local/session storage |
| `denied` | Suppressed | Suppressed | IDs removed; explicit preference retained |

Unknown consent permits anonymous measurement; if your app requires no requests
before consent, initialize with `consent: 'denied'`, then grant after opt-in.
Persisted preferences apply when `consent` is omitted. Explicit constructor
consent overrides the saved preference. `setConsent('unknown')` removes the saved
preference. There are no cookies. Consent withdrawal clears pending data and
aborts active requests; requests already received cannot be recalled.

Do Not Track and Global Privacy Control suppress collection by default. Query
strings, fragments, URL credentials, and referrer query strings are removed.
The five standard UTM values and allowlisted campaign descriptors are collected separately. Paths, page titles, UTM
values, and custom properties can still contain personal data: use `beforeSend`
to redact them. `includeQuery` and `includeHash` opt into URL components; recognized click-ID query parameters are removed even with `includeQuery`.

`reset()` clears queued events and stored IDs while preserving consent; use it
on logout. `setEnabled(false)` discards queued events and pauses collection.
Saved browser IDs are scoped to the site token. Granted sessions expire after
30 minutes of inactivity; unknown sessions also reset on a full page load.

## Options and API

| Core option | Default | Meaning |
| --- | --- | --- |
| `site`, `host` | Required | Public token and HTTP(S) collector base URL |
| `batchSize` | `10` | Events per request, maximum `25` |
| `maxQueueSize` | `1000` | Maximum buffered + in-flight events |
| `flushInterval` | `3000` | Milliseconds; `0` disables scheduled flushing |
| `timeout` | `5000` | Milliseconds per HTTP attempt |
| `maxRetries` | `2` | Additional attempts per flush/request |
| `retryDelay` | `250` | Initial exponential backoff in milliseconds |
| `fetch` | Global fetch | Optional transport implementation |
| `beforeSend` | — | Synchronous event transform; return `null` to drop |
| `onError` | — | Observer for automatic delivery/validation errors |

Additional browser options: `consent`, `autoPageviews` (true), `autoEvents`
(true), `respectDoNotTrack` (true), `domains` (exact hostname allowlist),
`includeQuery` (false), `includeHash` (false), `sessionTimeout` (1800000 ms).
`historyTracking` and `initialPageview` (both true) allow router adapters to own
navigation timing while preserving consent handling and other browser listeners.

Core methods: `track(name, props?, context?)`, `page(context?, props?)`,
`identify(identity, context)`, `flush()`, `shutdown()`. Context accepts `url`,
`referrer`, `sessionId`, `visitorId`, `timestamp` (Unix milliseconds), and `utm`.
Browser context takes URL, timestamp, UTM, and referrer overrides; IDs are managed
by consent. The browser adds `start`, `stop`, `reset`, `setConsent`, `getConsent`,
and `setEnabled`, and `identify` takes only its identity argument.

`track`/`page` return whether the event was queued, not whether it was stored.
Invalid or oversized events return false and call `onError`. Event names are
limited to 128 UTF-8 bytes, URL/referrer to 2048 each, and properties to 2048
serialized bytes. Events are snapshotted on enqueue; mutations after `track()`
do not change the event. Cycles, non-finite numbers, and non-JSON values are
rejected. Requests are split below 30 KB and at most 25 events.

`flush()` rejects on failed HTTP delivery and retains pending events for a later
explicit flush or tracking call. It retries network failures, 408, 429, and 5xx
responses with stable event IDs, honoring `Retry-After` up to 60 seconds. Other
HTTP errors are not automatically retried. Failed flushes do not schedule another
timer. Concurrent flushes share one delivery. The in-memory queue is bounded and
drops newly submitted events when full. Data is not persisted offline.

On page hide, a browser beacon is preferred; a rejected beacon falls back to
keepalive Fetch. Beacon acceptance only means the browser queued the request.
Browser-wide keepalive limits and termination can still cause loss. An HTTP
acknowledgement does not guarantee durable analytics storage. Ambiguous network
failures may produce duplicates if the collector does not deduplicate event IDs.
This SDK is intended for best-effort analytics, not financial/audit records.

## Public protocol

`POST <host>/v1/e` receives `{ site, events }`. Events contain `id`, `ts`, `name`,
`props`, and optional `url`, `ref`, `sid`, `vid`, `utm`.
`POST <host>/v1/id` receives `{ site, vid, email?, external_id?, ts }`.
Both requests contain JSON with `Content-Type: text/plain` and omit cookies.
Browser origins must be allowed by the collector. Successful responses are 2xx.

## Development and releases

```sh
npm ci
npm run check
npm pack --dry-run
```

CI checks Node.js 22 and 24. The package allowlist includes only compiled output,
the manifest, README, changelog, and license. Builds contain no source maps or
deployment defaults. Tests use fake transports and an ephemeral local HTTP server.
`npm run test:sveltekit` also builds a real SvelteKit client/server fixture against
the compiled SDK, validating its virtual navigation import. CI runs it on Node.js 24.

Before the first release, confirm the package scope/name and MIT license, add
the public source URL as `repository` in `package.json`, and configure your npm
account to own the scope. The included GitHub workflow is available if you host
the repository on GitHub. Configure `npm` as a protected GitHub environment and
set an [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) matching
the owner, repository, `publish.yml` workflow, and environment `npm`. For a new
package, bootstrap the first publication with `npm publish --access public` from
an authenticated maintainer account, then configure trusted publishing.

For subsequent releases, update the version and changelog, commit, push a matching
`vX.Y.Z` tag, then manually run the publish workflow with that tag as `release_ref`.
The workflow verifies the tag/version, tests, builds, and publishes with provenance.
The workflow requires a public GitHub source repository for provenance. Other
hosting services can run `npm ci && npm run check` and publish through npm's
supported authentication flow. No registry token belongs in this repository.

## Existing script integrations

The package uses the same event/identify HTTP shapes as the Athar script.
Remove the old tracker script when adopting the package to avoid duplicate views.
Replace `athar.consent(state)` with `analytics.setConsent(state)`; `track` and
browser `identify` have the same basic signatures. Explicitly configure `host`.
Old unscoped visitor/session IDs and cookies are not imported; migration starts
a new identity. Remove legacy tracker storage/cookies in your application's
migration if needed. Denial now suppresses events and identity calls entirely.

## License

MIT. See [LICENSE](LICENSE).


### Campaign attribution

Browser and framework clients automatically send the 19 supported campaign
parameters in `event.attribution`, separately from the sanitized page URL:
`ad_id`, `adgroupid`, `adid`, `adset_id`, `aid`, `campaign_id`, `campaign_name`,
`campaignid`, `cid`, `creative`, `device`, `gad_campaignid`, `gad_source`,
`keyword`, `matchtype`, `network`, `placement`, `site_source_name`, and `srsltid`.
UTM capture continues unchanged. Router URL overrides are used for both UTM and
attribution capture. No extra browser storage is created for attribution.

Node.js clients can supply the same query-key map through event context:

```ts
client.track('page_view', {}, {
  url: 'https://shop.example/products',
  attribution: { campaign_id: '123', ad_id: '456', placement: 'feed' },
});
```

Unknown keys, click identifiers, blank values, and oversized values are dropped
from `attribution`, including after `beforeSend`. External IDs are limited to
128 UTF-8 bytes; other descriptor values to 512. These are field drops, not
truncations. Custom properties and UTM values still require application redaction.

The collector must support the `attribution` field and the consent-gated
click-ID endpoint described below before using these features.

Maintainers configure the public catalogue source with `ATHAR_ATTRIBUTION_SOURCE`.
It accepts a JSON file path or an HTTP(S) URL and has no default. Set it in your
environment or CI configuration, then run:

```sh
node scripts/sync-attribution.mjs
node scripts/sync-attribution.mjs --check
```

Once the catalogue is published, set the same variable to its published URL.
The script fetches it when syncing; the SDK uses the generated catalogue at runtime
without a network fetch. `--check` detects drift without changing the generated file.
Only public parameter names, aliases, classes, and canonical names are generated.


### Controlled click-ID delivery

After explicit `granted` consent, browser/framework clients capture the first
unambiguous click-ID arrival observed in each session. The click ID and descriptors
from that same URL go to `POST /v1/attribution`, never `/v1/e`. Unknown/denied
consent and DNT/GPC suppress capture. A grant reads the current URL; the SDK does
not save pre-consent landing tokens for later capture.

Pending handoffs stay in memory, with stable request IDs across retries. They are
not passed to `beforeSend`, written to browser storage, or included in analytics
beacons. `flush()` and `shutdown()` wait for acknowledgement. The browser client
also exposes `captureAttribution(params?)` for an explicit current-session capture.

Node.js callers must supply consent and both identity keys:

```ts
client.captureAttribution({ gclid: clickId, campaign_id: '123' }, {
  consent: 'granted', sessionId: sessionId, visitorId: visitorId,
});
await client.flush();

// On withdrawal, cancel pending capture and request server-side cleanup.
client.revokeAttribution(visitorId);
await client.flush();
```

Browser `setConsent('denied' | 'unknown')`, cross-tab withdrawal, and `reset()`
cancel queued/in-flight captures and enqueue a token-free withdrawal for the old
visitor. Withdrawal requests can run while tracking is disabled. Requests already
received cannot be recalled. Withdrawal requests collector-side cleanup; data
already delivered to downstream systems requires their erasure workflow.
Use a new visitor ID when consent is granted again (the browser client does this).

Capture and withdrawal delivery use bounded retries; failures are reported without
request values. Failed handoffs remain in memory for an explicit `flush()` retry,
up to 24 hours. Closing the page can lose unacknowledged work. Ad-network conversion postbacks are not part of this SDK.
