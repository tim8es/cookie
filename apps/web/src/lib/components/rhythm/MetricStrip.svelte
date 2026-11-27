<script lang="ts">
  import type { MetricItem } from "./contracts.js";

  let {
    items,
    storageKey,
    label = "Показатели раздела",
    initiallyExpanded = true,
  }: {
    items: readonly MetricItem[];
    storageKey: string;
    label?: string;
    initiallyExpanded?: boolean;
  } = $props();

  let expanded = $state(initiallyExpanded);
  const targetId = $props.id();

  // A mounted widget may be reused for another role, organization or screen.
  // Always hydrate the preference for the *current* scope, not the last one.
  // Effects run only in the browser, so SSR never reads localStorage.
  $effect(() => {
    const key = storageKey;
    const fallback = initiallyExpanded;
    let next = fallback;
    try {
      const cached = localStorage.getItem(key);
      if (cached === "hidden") next = false;
      if (cached === "shown") next = true;
    } catch {
      // Private browsing or blocked storage: the control still works.
    }
    expanded = next;
  });

  function toggle() {
    expanded = !expanded;
    try {
      localStorage.setItem(storageKey, expanded ? "shown" : "hidden");
    } catch {
      // Preference persistence is best effort, never a blocker.
    }
  }
</script>

<section class="rhythm-metrics" data-component="MetricStrip" data-expanded={expanded} aria-label={label}>
  <div class="rhythm-metrics-toolbar">
    <button type="button" class="rhythm-metrics-toggle" aria-controls={targetId}
      aria-expanded={expanded} onclick={toggle}>
      {expanded ? "Скрыть показатели" : "Показать показатели"}
      <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button>
  </div>
  <div class="rhythm-metrics-grid" id={targetId} hidden={!expanded}>
    {#each items as metric (metric.id)}
      <div class="rhythm-metric">
        <strong>{metric.value}</strong>
        <span>{metric.label}</span>
      </div>
    {/each}
  </div>
</section>
