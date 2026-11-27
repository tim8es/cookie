<script lang="ts">
  import { onMount } from "svelte";
  import type { MenuOption } from "./contracts.js";

  let {
    label,
    items,
    selected,
    onSelect,
  }: {
    label: string;
    items: readonly MenuOption[];
    selected?: string;
    onSelect: (id: string) => void;
  } = $props();

  const panelId = $props.id();
  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();
  let supported = $state(false);
  let expanded = $state(false);
  const selectedLabel = $derived(items.find((item) => item.id === selected)?.label ?? label);

  function isOpen(): boolean {
    return Boolean(panel?.matches(":popover-open"));
  }

  function close(restore = false) {
    if (isOpen()) panel?.hidePopover();
    expanded = false;
    if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function position() {
    if (!trigger || !panel || !isOpen()) return;
    const anchor = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const margin = 8;
    const gap = 6;
    if (anchor.bottom <= top || anchor.top >= bottom || anchor.right <= left || anchor.left >= right) {
      close();
      return;
    }
    const width = Math.max(0, Math.min(Math.max(anchor.width, 200), right - left - 2 * margin));
    const below = Math.max(0, bottom - margin - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - top - margin - gap);
    panel.style.width = width + "px";
    panel.style.maxHeight = Math.max(below, above) + "px";
    const desiredHeight = panel.scrollHeight;
    const useBelow = below >= desiredHeight || below >= above;
    const available = useBelow ? below : above;
    if (available <= 0) { close(); return; }
    panel.style.maxHeight = available + "px";
    const height = panel.getBoundingClientRect().height;
    panel.style.left = Math.max(left + margin, Math.min(anchor.right - width, right - margin - width)) + "px";
    panel.style.top = (useBelow ? anchor.bottom + gap : anchor.top - gap - height) + "px";
  }

  function focusOption(last = false) {
    const options = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const active = options.find((option) => option.getAttribute("aria-current") === "true");
    (last ? options.at(-1) : active ?? options[0])?.focus({ preventScroll: true });
  }

  function open(last = false) {
    if (!panel?.isConnected || !trigger?.isConnected) return;
    if (!isOpen()) panel.showPopover();
    expanded = true;
    position();
    if (isOpen()) focusOption(last);
  }

  function choose(id: string) {
    if (!items.some((item) => item.id === id && !item.disabled)) return;
    close(true);
    onSelect(id);
  }

  onMount(() => {
    supported = typeof HTMLElement.prototype.showPopover === "function";
    if (!supported) return;
    const reposition = () => position();
    const onKey = (event: KeyboardEvent) => {
      if (event.target === trigger && (event.key === "ArrowDown" || event.key === "ArrowUp") && !isOpen()) {
        event.preventDefault();
        open(event.key === "ArrowUp");
        return;
      }
      if (!isOpen() || !(event.target instanceof Node) || (event.target !== trigger && !panel?.contains(event.target))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const options = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!options.length) return;
      event.preventDefault();
      const current = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (current + 1) % options.length
        : (current <= 0 ? options.length - 1 : current - 1);
      options[next]?.focus();
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
      document.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="rhythm-popover" data-component="PopoverMenu">
  {#if supported}
    <button type="button" class="rhythm-popover-trigger" bind:this={trigger}
      aria-label={label + ": " + selectedLabel} aria-expanded={expanded} aria-controls={panelId}
      onclick={() => isOpen() ? close(true) : open()}>
      <span>{selectedLabel}</span><span aria-hidden="true">⌄</span>
    </button>
    <div bind:this={panel} id={panelId} popover="auto" class="rhythm-popover-items"
      role="group" aria-label={label} ontoggle={() => { expanded = isOpen(); if (expanded) position(); }}>
      {#each items as item (item.id)}
        <button type="button" class="rhythm-popover-item" disabled={item.disabled}
          aria-current={item.id === selected ? "true" : undefined}
          onclick={() => choose(item.id)}>{item.label}</button>
      {/each}
    </div>
  {:else}
    <!-- Older WebViews: native select avoids a clipped fake overlay. -->
    <select class="rhythm-popover-trigger" aria-label={label} value={selected ?? ""}
      onchange={(event) => choose(event.currentTarget.value)}>
      {#if !items.some((item) => item.id === selected)}<option value="" disabled>{label}</option>{/if}
      {#each items as item (item.id)}
        <option value={item.id} disabled={item.disabled}>{item.label}</option>
      {/each}
    </select>
  {/if}
</div>
