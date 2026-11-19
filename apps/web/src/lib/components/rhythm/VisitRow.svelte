<script lang="ts">
  import ActionButton from "./ActionButton.svelte";
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
  <span class="rhythm-trailing">{visit.time}</span>
  <div class="rhythm-copy">
    <strong>{visit.title}</strong>
    {#if visit.subtitle}<small class="rhythm-muted">{visit.subtitle}</small>{/if}
    <small>{visit.status}</small>
  </div>
  {#if visit.amountLabel}<span class="rhythm-trailing">{visit.amountLabel}</span>{/if}
  {#if onOpen}
    <ActionButton
      label={"Открыть запись: " + visit.title + ", " + visit.time}
      onclick={onOpen}
    >Открыть</ActionButton>
  {/if}
</div>
