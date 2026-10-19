<script lang="ts">
  import { provideAthar } from '@upax/athar/sveltekit';
  let { children } = $props();
  provideAthar({ site: 'public-site-token', host: 'https://collector.example', flushInterval: 0 });
</script>

{@render children()}
