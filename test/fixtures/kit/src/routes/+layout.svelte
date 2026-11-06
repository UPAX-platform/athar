<script lang="ts">
  import { provideAthar } from '@upax-ai/athar/sveltekit';
  import { folioContext } from '@upax-ai/athar/folio';
  let { children } = $props();
  provideAthar({ site: 'public-site-token', host: 'https://collector.example', flushInterval: 0, beforeSend: folioContext() });
</script>

{@render children()}
