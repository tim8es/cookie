<script lang="ts">
  import type { Snippet } from "svelte";
  import ActionButton from "./ActionButton.svelte";
  import type { BookingStep } from "./contracts.js";

  let {
    title,
    description,
    steps,
    current,
    channel = "web",
    header,
    children,
    summary,
    nextLabel,
    nextDisabled = false,
    busy = false,
    onNext,
    onStep,
  }: {
    title: string;
    description?: string;
    steps: readonly BookingStep[];
    current: string;
    channel?: "web" | "embed" | "telegram" | "manual";
    header?: Snippet;
    children: Snippet;
    summary?: Snippet;
    nextLabel?: string;
    nextDisabled?: boolean;
    busy?: boolean;
    onNext?: () => void;
    onStep?: (id: string) => void;
  } = $props();
</script>

<div class="rhythm-public-page rhythm-booking" data-channel={channel} data-component="BookingLayout">
  {#if header}{@render header()}{/if}
  <header class="rhythm-booking-heading">
    <h2>{title}</h2>
    {#if description}<p class="rhythm-muted">{description}</p>{/if}
  </header>
  <nav class="rhythm-steps" aria-label="Этапы записи">
    {#each steps as step, index (step.id)}
      <button type="button" aria-current={current === step.id ? "step" : undefined}
        disabled={!step.reachable || !onStep || busy} onclick={() => onStep?.(step.id)}>
        <span aria-hidden="true">{step.complete ? "✓" : index + 1}</span>
        <span>{step.label}</span>
      </button>
    {/each}
  </nav>
  <div class="rhythm-booking-grid">
    <div class="rhythm-stack rhythm-booking-body">
      {@render children()}
      {#if nextLabel && onNext}
        <div class="rhythm-booking-action">
          <ActionButton tone="primary" disabled={nextDisabled} {busy} onclick={onNext}>{nextLabel}</ActionButton>
        </div>
      {/if}
    </div>
    {#if summary}<aside class="rhythm-booking-summary">{@render summary()}</aside>{/if}
  </div>
</div>
