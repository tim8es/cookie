<script lang="ts">
  import type { TicketLine } from "./contracts.js";

  let {
    title = "Детали записи",
    lines,
    priceLabel,
    priceNote,
  }: {
    title?: string;
    lines: readonly TicketLine[];
    priceLabel?: string;
    priceNote?: string;
  } = $props();
</script>

<section class="rhythm-panel rhythm-stack" data-component="BookingTicket" aria-label={title}>
  <h3 class="text-base font-semibold">{title}</h3>
  <dl class="rhythm-stack">
    {#each lines as line}
      <div class="flex flex-wrap justify-between gap-2">
        <dt class="rhythm-muted">{line.label}</dt>
        <dd class="min-w-0 text-right font-medium break-words">{line.value}</dd>
      </div>
    {/each}
    {#if priceLabel}
      <div class="rhythm-record">
        <dt class="rhythm-copy">Стоимость</dt>
        <dd class="rhythm-trailing">{priceLabel}</dd>
      </div>
    {/if}
  </dl>
  {#if priceNote}<p class="rhythm-muted">{priceNote}</p>{/if}
</section>
