<script lang="ts">
  import type { Snippet } from "svelte";
  import ActionButton from "./ActionButton.svelte";

  let {
    title,
    description,
    submitLabel = "Сохранить",
    className = "",
    cancelLabel = "Отмена",
    showSubmit = true,
    busy = false,
    disabled = false,
    onSubmit,
    onCancel,
    children,
  }: {
    title: string;
    description?: string;
    submitLabel?: string;
    className?: string;
    cancelLabel?: string;
    showSubmit?: boolean;
    busy?: boolean;
    disabled?: boolean;
    onSubmit: () => void;
    onCancel?: () => void;
    children: Snippet;
  } = $props();
</script>

<form
  class={"rhythm-panel rhythm-stack " + className}
  data-component="EntityEditor"
  aria-label={title}
  aria-busy={busy}
  onsubmit={(event) => {
    event.preventDefault();
    if (showSubmit && !busy && !disabled) onSubmit();
  }}
>
  <header>
    <h3 class="text-base font-semibold">{title}</h3>
    {#if description}<p class="rhythm-muted">{description}</p>{/if}
  </header>
  {@render children()}
  <div class="rhythm-actions">
    {#if onCancel}
      <ActionButton disabled={busy} onclick={onCancel}>
        {cancelLabel}
      </ActionButton>
    {/if}
    {#if showSubmit}
      <ActionButton type="submit" tone="primary" {busy} {disabled} busyLabel="Сохранение…">{submitLabel}</ActionButton>
    {/if}
  </div>
</form>
