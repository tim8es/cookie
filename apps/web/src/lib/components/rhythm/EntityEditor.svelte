<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";

  let {
    title,
    description,
    submitLabel = "Сохранить",
    busy = false,
    disabled = false,
    onSubmit,
    onCancel,
    children,
  }: {
    title: string;
    description?: string;
    submitLabel?: string;
    busy?: boolean;
    disabled?: boolean;
    onSubmit: () => void;
    onCancel?: () => void;
    children: Snippet;
  } = $props();
</script>

<form
  class="rhythm-panel rhythm-stack"
  data-component="EntityEditor"
  aria-label={title}
  aria-busy={busy}
  onsubmit={(event) => {
    event.preventDefault();
    if (!busy && !disabled) onSubmit();
  }}
>
  <header>
    <h3 class="text-base font-semibold">{title}</h3>
    {#if description}<p class="rhythm-muted">{description}</p>{/if}
  </header>
  {@render children()}
  <div class="rhythm-actions">
    {#if onCancel}
      <Button variant="outline" class="rhythm-action" disabled={busy} onclick={onCancel}>
        Отмена
      </Button>
    {/if}
    <Button
      type="submit"
      class="rhythm-action rhythm-action--primary"
      disabled={busy || disabled}
    >{busy ? "Сохранение…" : submitLabel}</Button>
  </div>
</form>
