<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
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

<div class="rhythm-date-strip" role="group" aria-label={label} data-component="DateStrip">
  {#each days as day (day.id)}
    <Button variant="outline" class="rhythm-day" aria-label={day.label} aria-pressed={day.id === selected}
      disabled={day.disabled} onclick={() => onSelect(day.id)}>
      <small>{day.weekday}</small>
      <strong>{day.day}</strong>
    </Button>
  {/each}
</div>
