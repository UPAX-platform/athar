<script lang="ts">
  import { useAthar } from '@upax/athar/sveltekit';
  const analytics = useAthar();
</script>

<svelte:head><title>SDK integration fixture</title></svelte:head>
<button onclick={() => analytics.track('fixture-click')}>Track</button>
