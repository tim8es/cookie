<script lang="ts">
  import type { Snippet } from "svelte";
  import ActionButton from "./ActionButton.svelte";
  import RecordRow from "./RecordRow.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Notice from "./Notice.svelte";
  import type { ChoiceItem, DisplayRecord } from "./contracts.js";

  let {
    heading,
    intro,
    banner,
    layout = "cover",
    primaryLabel,
    services,
    staff,
    showStaff = true,
    staffFirst = false,
    unavailable = false,
    header,
    onStart,
    onService,
  }: {
    heading: string;
    intro?: string;
    banner?: string;
    layout?: "cover" | "split" | "compact";
    primaryLabel: string;
    services: readonly ChoiceItem[];
    staff: readonly DisplayRecord[];
    showStaff?: boolean;
    staffFirst?: boolean;
    unavailable?: boolean;
    header: Snippet;
    onStart: () => void;
    onService: (id: string) => void;
  } = $props();
</script>

<div class="rhythm-public-page" data-component="SalonPage">
  {@render header()}
  <section class="rhythm-hero" data-layout={layout}>
    {#if banner && layout !== "compact"}<img src={banner} alt="" />{/if}
    <div class="rhythm-hero-copy">
      <h2>{heading}</h2>
      {#if intro}<p>{intro}</p>{/if}
      <ActionButton tone="primary" disabled={unavailable} onclick={onStart}>{primaryLabel}</ActionButton>
    </div>
  </section>
  {#if unavailable}<Notice tone="error" title="Новые записи временно недоступны" />{/if}
  <div class="rhythm-salon-catalog" data-staff-first={staffFirst}>
    <section class="rhythm-stack" aria-label="Услуги">
      <h3 class="rhythm-subhead">Услуги</h3>
      {#each services as item (item.id)}
        <RecordRow record={{ title: item.title, subtitle: item.description, detail: item.detail }}>
          {#snippet action()}
            <ActionButton disabled={unavailable || item.disabled} label={"Выбрать услугу: " + item.title} onclick={() => onService(item.id)}>Выбрать</ActionButton>
          {/snippet}
        </RecordRow>
      {:else}<EmptyState title="Нет опубликованных услуг" />{/each}
    </section>
    {#if showStaff}
      <section class="rhythm-stack" aria-label="Мастера">
        <h3 class="rhythm-subhead">Мастера</h3>
        {#each staff as member}<RecordRow record={member} />{:else}<EmptyState title="Нет опубликованных мастеров" />{/each}
      </section>
    {/if}
  </div>
</div>
