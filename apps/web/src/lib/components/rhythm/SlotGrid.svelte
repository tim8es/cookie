<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import EmptyState from "./EmptyState.svelte";
  import type { SegmentOption } from "./contracts.js";

  let {
    label,
    options,
    selected,
    onSelect,
  }: {
    label: string;
    options: readonly SegmentOption[];
    selected?: string;
    onSelect: (id: string) => void;
  } = $props();
</script>

<div class="rhythm-stack" role="group" aria-label={label} data-component="SlotGrid">
  <div class="rhythm-slot-grid">
    {#each options as slot (slot.id)}
      <Button variant="outline" class="rhythm-slot" aria-pressed={selected === slot.id} disabled={slot.disabled}
        onclick={() => onSelect(slot.id)}>{slot.label}</Button>
    {/each}
  </div>
  {#if options.length === 0}<EmptyState title="Нет доступного времени" />{/if}
</div>
