<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";

  let {
    tone = "secondary",
    type = "button",
    disabled = false,
    busy = false,
    busyLabel = "Подождите…",
    label,
    onclick,
    children,
  }: {
    tone?: "primary" | "secondary" | "danger";
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    busy?: boolean;
    busyLabel?: string;
    label?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

<Button
  variant={tone === "primary" ? "default" : tone === "danger" ? "destructive" : "outline"}
  class={"rhythm-action rhythm-action--" + tone}
  {type}
  disabled={disabled || busy}
  aria-label={label}
  aria-busy={busy}
  {onclick}
>
  {#if busy}{busyLabel}{:else}{@render children()}{/if}
</Button>
