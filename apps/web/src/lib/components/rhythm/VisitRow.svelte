<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
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
    <Button
      variant="outline"
      class="rhythm-action"
      aria-label={"Открыть запись: " + visit.title + ", " + visit.time}
      onclick={onOpen}
    >Открыть</Button>
  {/if}
</div>
