<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import type { SegmentOption } from "./contracts.js";

  let {
    label,
    items,
    current,
    onNavigate,
    layout = "rail",
  }: {
    label: string;
    items: readonly SegmentOption[];
    current: string;
    onNavigate: (id: string) => void;
    layout?: "rail" | "bar";
  } = $props();
</script>

<nav aria-label={label} class="rhythm-navigation" data-layout={layout} data-component="Navigation">
  {#each items as item (item.id)}
    <Button
      variant="ghost"
      class="rhythm-nav-item"
      aria-current={current === item.id ? "page" : undefined}
      disabled={item.disabled}
      onclick={() => onNavigate(item.id)}
    >{item.label}</Button>
  {/each}
</nav>
