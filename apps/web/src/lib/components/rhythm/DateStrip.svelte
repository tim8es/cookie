<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import ScrollArea from "./ScrollArea.svelte";
  import type { DayOption } from "./contracts.js";

  let {
    label,
    days,
    selected,
    onSelect,
  }: {
    label: string;
    days: readonly DayOption[];
    selected?: string;
    onSelect: (id: string) => void;
  } = $props();
</script>

<div role="group" aria-label={label} data-component="DateStrip">
  <ScrollArea axis="x" {label} className="rhythm-date-strip">
  {#each days as day (day.id)}
    <Button variant="outline" class="rhythm-day" aria-label={day.label} aria-pressed={day.id === selected}
      disabled={day.disabled} onclick={() => onSelect(day.id)}>
      <small>{day.weekday}</small>
      <strong>{day.day}</strong>
    </Button>
  {/each}
  </ScrollArea>
</div>
