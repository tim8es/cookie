<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import type { Snippet } from "svelte";
  import RowContent from "./RowContent.svelte";

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
  <RowContent {title} {description} detail={trailing} {leading} />
  <span class="rhythm-choice-check" aria-hidden="true">{selected ? "✓" : ""}</span>
</Button>
