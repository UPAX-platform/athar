# Athar JavaScript SDK

Typed analytics for browsers, Node.js, and React. Zero runtime dependencies, ESM
and CommonJS exports, and optional React bindings. Node.js 22+ and modern browsers
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
The five standard UTM values are collected separately. Paths, page titles, UTM
values, and custom properties can still contain personal data: use `beforeSend`
to redact them. `includeQuery` and `includeHash` opt into full URL components.

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
