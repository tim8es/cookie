<script lang="ts">
  import ActionButton from "./ActionButton.svelte";

  let {
    title,
    description,
    actionLabel,
    onAction,
  }: {
    title: string;
    description?: string;
    actionLabel?: string;
    onAction?: () => void;
  } = $props();
</script>

<div class="rhythm-empty" data-component="EmptyState">
  <strong>{title}</strong>
  {#if description}<p class="rhythm-muted">{description}</p>{/if}
  {#if actionLabel && onAction}
    <ActionButton onclick={onAction}>{actionLabel}</ActionButton>
  {/if}
</div>
