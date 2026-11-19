<script lang="ts">
  import { onMount } from "svelte";
  import type { MenuOption } from "./contracts.js";

  let {
    label,
    items,
    selected,
    onSelect,
  }: {
    label: string;
    items: readonly MenuOption[];
    selected?: string;
    onSelect: (id: string) => void;
  } = $props();

  let element: HTMLDetailsElement | undefined = $state();
  const selectedLabel = $derived(items.find((item) => item.id === selected)?.label ?? label);

  onMount(() => {
    const closeOutside = (event: PointerEvent) => {
      if (element?.open && event.target instanceof Node && !element.contains(event.target)) {
        element.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  });

  function choose(id: string) {
    onSelect(id);
    if (element) element.open = false;
  }
</script>

<details bind:this={element} class="rhythm-popover" data-component="PopoverMenu"
  onkeydown={(event) => {
    if (event.key === "Escape" && element?.open) {
      event.preventDefault();
      element.open = false;
      element.querySelector("summary")?.focus();
    }
  }}>
  <summary aria-label={label + ": " + selectedLabel}>
    <span>{selectedLabel}</span><span aria-hidden="true">⌄</span>
  </summary>
  <div class="rhythm-popover-items" role="group" aria-label={label}>
    {#each items as item (item.id)}
      <button type="button" class="rhythm-popover-item" disabled={item.disabled}
        aria-current={item.id === selected ? "true" : undefined}
        onclick={() => choose(item.id)}>{item.label}</button>
    {/each}
  </div>
</details>
