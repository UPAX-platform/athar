<script lang="ts">
  import { provideAthar } from '../../src/svelte';
  import type { BrowserOptions, BrowserClient } from '../../src/browser';
  let { options, withPath, ready }: { options: BrowserOptions; withPath: boolean; ready: (client: BrowserClient, go: (doc: string) => void) => void } = $props();
  const client = provideAthar(options);
  // Stands in for a client-side router: the URL changes first and the page renders afterwards.
  let doc = $state('d_aaaaaaaaaaaaaaaaaaaaaaaa');
  ready(client, next => { doc = next; });
</script>

<svelte:head>
  <meta name="folio:doc" content={doc} />
  <meta name="folio:locale" content="en-US" />
  {#if withPath}<meta name="folio:path" content={doc.startsWith('d_a') ? '/a' : '/b'} />{/if}
</svelte:head>
