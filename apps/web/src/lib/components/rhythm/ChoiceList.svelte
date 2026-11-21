<script lang="ts">
  import type { ChoiceItem } from "./contracts.js";
  import ChoiceRow from "./ChoiceRow.svelte";
  import Avatar from "./Avatar.svelte";
  import EmptyState from "./EmptyState.svelte";

  let {
    title,
    items,
    selected,
    onSelect,
    emptyLabel = "Нет доступных вариантов",
    variant = "catalog",
  }: {
    title: string;
    items: readonly ChoiceItem[];
    selected?: string;
    onSelect: (id: string) => void;
    emptyLabel?: string;
    variant?: "catalog" | "option";
  } = $props();
</script>

<section class="rhythm-stack" aria-label={title} data-component="ChoiceList">
  <h3 class="rhythm-subhead">{title}</h3>
  {#each items as item (item.id)}
    <ChoiceRow
      title={item.title}
      description={item.description}
      trailing={item.detail}
      selected={selected === item.id}
      disabled={item.disabled}
      {variant}
      onSelect={() => onSelect(item.id)}
    >
      {#snippet leading()}
        {#if item.initials}<Avatar initials={item.initials} imageSrc={item.imageSrc} />{/if}
      {/snippet}
    </ChoiceRow>
  {:else}
    <EmptyState title={emptyLabel} />
  {/each}
</section>
