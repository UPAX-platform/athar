<script lang="ts">
  import { provideAthar } from '../../src/svelte';
  import SvelteChild from './SvelteChild.svelte';
  import type { BrowserOptions, BrowserClient } from '../../src/browser';
  let { options, ready }: { options: BrowserOptions; ready: (client: BrowserClient) => void } = $props();
  const client = provideAthar(options);
  ready(client);
</script>

<SvelteChild />
