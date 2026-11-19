<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";

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
    <Button variant="outline" class="rhythm-action" onclick={onAction}>{actionLabel}</Button>
  {/if}
</div>
