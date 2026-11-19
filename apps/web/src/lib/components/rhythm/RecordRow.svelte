<script lang="ts">
  import type { Snippet } from "svelte";
  import type { DisplayRecord } from "./contracts.js";
  import Avatar from "./Avatar.svelte";
  import RowContent from "./RowContent.svelte";

  let { record, action }: { record: DisplayRecord; action?: Snippet } = $props();
</script>

<div class="rhythm-record" data-component="RecordRow">
  <RowContent title={record.title} description={record.subtitle} detail={record.detail}>
    {#snippet leading()}
      {#if record.initials}<Avatar initials={record.initials} imageSrc={record.imageSrc} />{/if}
    {/snippet}
  </RowContent>
  {#if action}{@render action()}{/if}
</div>
