<script lang="ts">
  import type { ResourceGroup } from "./contracts.js";
  import VisitRow from "./VisitRow.svelte";
  import EmptyState from "./EmptyState.svelte";
  let {
    title,
    resources,
    onOpen,
  }: {
    title: string;
    resources: readonly ResourceGroup[];
    onOpen?: (id: string) => void;
  } = $props();
</script>

<section class="rhythm-stack" aria-label={title} data-component="ResourceDay">
  <h3 class="rhythm-subhead">{title}</h3>
  <div class="rhythm-resource-grid">
    {#each resources as resource (resource.id)}
      <section class="rhythm-resource rhythm-stack" aria-label={resource.label}>
        <header><strong>{resource.label}</strong>{#if resource.shiftLabel}<p class="rhythm-muted">{resource.shiftLabel}</p>{/if}</header>
        {#each resource.visits as visit (visit.id)}
          <VisitRow {visit} onOpen={onOpen ? () => onOpen?.(visit.id) : undefined} />
        {:else}
          <EmptyState title="Нет записей" />
        {/each}
      </section>
    {:else}
      <EmptyState title="Нет мастеров в этом срезе" />
    {/each}
  </div>
</section>
