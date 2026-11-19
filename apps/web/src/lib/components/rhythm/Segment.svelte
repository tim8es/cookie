<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import type { SegmentOption } from "./contracts.js";

  let {
    label,
    options,
    selected,
    onSelect,
  }: {
    label: string;
    options: readonly SegmentOption[];
    selected: string;
    onSelect: (id: string) => void;
  } = $props();
</script>

<div class="rhythm-segment" role="group" aria-label={label} data-component="Segment">
  {#each options as option (option.id)}
    <Button
      variant="ghost"
      disabled={option.disabled}
      aria-pressed={selected === option.id}
      onclick={() => onSelect(option.id)}
    >
      {option.label}
    </Button>
  {/each}
</div>
