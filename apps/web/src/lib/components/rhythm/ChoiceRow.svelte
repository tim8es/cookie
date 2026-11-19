<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    trailing,
    leading,
    selected = false,
    disabled = false,
    variant = "catalog",
    onSelect,
  }: {
    title: string;
    description?: string;
    trailing?: string;
    leading?: Snippet;
    selected?: boolean;
    disabled?: boolean;
    variant?: "catalog" | "option";
    onSelect: () => void;
  } = $props();
</script>

<Button
  variant="ghost"
  class="rhythm-choice"
  data-component="ChoiceRow"
  data-choice-variant={variant}
  aria-pressed={selected}
  {disabled}
  onclick={onSelect}
>
  {#if leading}{@render leading()}{/if}
  <span class="rhythm-copy">
    <strong>{title}</strong>
    {#if description}<small class="rhythm-muted">{description}</small>{/if}
  </span>
  {#if trailing}<span class="rhythm-trailing">{trailing}</span>{/if}
  <span class="rhythm-choice-check" aria-hidden="true">{selected ? "✓" : ""}</span>
</Button>
