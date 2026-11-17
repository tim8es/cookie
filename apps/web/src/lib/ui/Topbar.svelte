<script lang="ts">
  import { ArrowRight, Plus, SlidersHorizontal } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { ViewState } from "../model";
  import { screens, type Screen } from "../navigation";

  export let screen: Screen;
  export let preview: ViewState;
  export let canCreateBooking: boolean;
  export let demoMode = true;
  export let onLogout: (() => void) | undefined = undefined;
  export let onNavigate: (next: Screen) => void;

  $: displayTitle = screens.find((item) => item.id === screen)?.label ?? "Cookie";
</script>

{#if demoMode}
<div class="demo-ribbon">
  <span class="ribbon-pulse" aria-hidden="true"></span>
  Демо: изменения сохраняются только в этой вкладке
</div>
{/if}
<header class="topbar">
  <div class="topbar-title">
    <span class="breadcrumb">Пространство <ArrowRight size={13} aria-hidden="true" /></span>
    <strong>{displayTitle}</strong>
  </div>
  <div class="topbar-actions">
    {#if demoMode}
    <label class="preview-control">
      <SlidersHorizontal size={15} aria-hidden="true"/>
      <span>Состояние</span>
      <select bind:value={preview} aria-label="Проверить демонстрационное состояние">
        <option value="normal">Обычное</option>
        <option value="empty">Пустое</option>
        <option value="error">Ошибка сети</option>
        <option value="forbidden">Нет прав</option>
        <option value="conflict">Конфликт слота</option>
      </select>
    </label>
    <Button class="btn-top" size="lg" type="button"
      onclick={() => onNavigate("booking")} disabled={!canCreateBooking}>
      <Plus size={17} strokeWidth={2} aria-hidden="true" />
      <span>Новая запись</span>
    </Button>
    {:else}
      <Button type="button" variant="outline" onclick={onLogout}>Выйти</Button>
    {/if}
  </div>
</header>
