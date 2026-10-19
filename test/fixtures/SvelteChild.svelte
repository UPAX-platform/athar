<script lang="ts">
  import { useAthar } from '../../src/svelte';
  const client = useAthar();
</script>

<button onclick={() => client.track('child-click')}>Track</button>
