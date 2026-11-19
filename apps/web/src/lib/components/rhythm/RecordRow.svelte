<script lang="ts">
  import type { Snippet } from "svelte";
  import type { DisplayRecord } from "./contracts.js";
  import Avatar from "./Avatar.svelte";

  let { record, action }: { record: DisplayRecord; action?: Snippet } = $props();
</script>

<div class="rhythm-record" data-component="RecordRow">
  {#if record.initials}
    <Avatar initials={record.initials} imageSrc={record.imageSrc} />
  {/if}
  <div class="rhythm-copy">
    <strong>{record.title}</strong>
    {#if record.subtitle}<small class="rhythm-muted">{record.subtitle}</small>{/if}
  </div>
  {#if record.detail}<span class="rhythm-trailing">{record.detail}</span>{/if}
  {#if action}{@render action()}{/if}
</div>
