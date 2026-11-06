<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>Document {data.letter}</title>
  <meta name="folio:doc" content={`d_${data.letter.repeat(24)}`} />
  <meta name="folio:locale" content="en-US" />
  <meta name="folio:path" content={`/doc/${data.letter}`} />
</svelte:head>
<a id="doc-b" href="/doc/b" data-sveltekit-preload-data="off">Document b</a>
