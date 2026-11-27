<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    detail,
    status,
    leading,
  }: {
    title: string;
    description?: string;
    detail?: string;
    status?: string;
    leading?: Snippet;
  } = $props();
</script>

{#if leading}{@render leading()}{/if}
<span class="rhythm-copy">
  <strong>{title}</strong>
  {#if description}<small class="rhythm-muted">{description}</small>{/if}
  {#if status}<small>{status}</small>{/if}
</span>
{#if detail}<span class="rhythm-trailing">{detail}</span>{/if}
