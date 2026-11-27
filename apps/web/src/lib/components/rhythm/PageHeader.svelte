<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    organization,
    description,
    secondaryActions,
    primaryAction,
    headingLevel = 1,
  }: {
    title: string;
    organization?: string;
    description?: string;
    secondaryActions?: Snippet;
    primaryAction?: Snippet;
    headingLevel?: 1 | 2;
  } = $props();

  const heading = $derived(headingLevel === 1 ? "h1" : "h2");
</script>

<header class="rhythm-page-header" data-component="PageHeader">
  <div class="page-identity">
    {#if organization}<p class="organization">{organization}</p>{/if}
    <svelte:element this={heading}>{title}</svelte:element>
    {#if description}<p class="description">{description}</p>{/if}
  </div>
  {#if secondaryActions || primaryAction}
    <div class="page-actions">
      {@render secondaryActions?.()}
      {@render primaryAction?.()}
    </div>
  {/if}
</header>

<style>
  .rhythm-page-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 20px;
    min-width: 0;
    margin-bottom: 16px;
  }
  .page-identity {
    flex: 1 1 15rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .page-identity :is(h1, h2) {
    margin: 0;
    color: var(--rhythm-ink, var(--cookie-ink));
    font-size: clamp(25px, 2.25vw, 31px);
    line-height: 1.18;
    letter-spacing: -.035em;
    font-weight: 750;
  }
  p {
    color: var(--rhythm-muted, var(--muted-foreground));
    margin: 0;
  }
  .organization {
    font-size: 12px;
    margin-bottom: 5px;
  }
  .description {
    font-size: 13px;
    line-height: 1.4;
    margin-top: 5px;
    max-width: 52ch;
  }
  .page-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
    margin-inline-start: auto;
  }
  @media (max-width: 480px) {
    .page-actions {
      margin-inline-start: 0;
      justify-content: flex-start;
    }
  }
</style>
