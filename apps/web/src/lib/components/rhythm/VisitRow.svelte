<script lang="ts">
  import ActionButton from "./ActionButton.svelte";
  import RowContent from "./RowContent.svelte";
  import type { VisitDisplay } from "./contracts.js";

  let {
    visit,
    onOpen,
  }: {
    visit: VisitDisplay;
    onOpen?: () => void;
  } = $props();
</script>

<div class="rhythm-record" data-component="VisitRow">
  <RowContent title={visit.title} description={visit.subtitle} status={visit.status} detail={visit.amountLabel}>
    {#snippet leading()}<span class="rhythm-trailing">{visit.time}</span>{/snippet}
  </RowContent>
  {#if onOpen}
    <ActionButton
      label={"Открыть запись: " + visit.title + ", " + visit.time}
      onclick={onOpen}
    >Открыть</ActionButton>
  {/if}
</div>
