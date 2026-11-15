<script lang="ts">
  import { ArrowRight, Plus } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Badge } from "../components/ui/badge/index.js";
  import type { ViewState } from "../model";
  import { screens, type Screen } from "../navigation";

  export let screen: Screen;
  export let preview: ViewState;
  export let canCreateBooking: boolean;
  export let onNavigate: (next: Screen) => void;

  $: displayTitle = screens.find((item) => item.id === screen)?.label ?? "Cookie";
</script>

<div class="demo-ribbon">
  <span class="ribbon-pulse" aria-hidden="true"></span>
  <strong>Демонстрационный режим</strong>
  <span>Локальные данные · реальные записи не создаются</span>
</div>

<header class="topbar">
  <div class="topbar-title">
    <span class="breadcrumb">Cookie <ArrowRight size={12} aria-hidden="true" /></span>
    <strong>{displayTitle}</strong>
  </div>
  <div class="topbar-actions">
    <label class="preview-control">
      Проверить состояние
      <select bind:value={preview} aria-label="Проверить демонстрационное состояние">
        <option value="normal">Обычное</option>
        <option value="empty">Пустое</option>
        <option value="error">Ошибка сети</option>
        <option value="forbidden">Нет прав</option>
        <option value="conflict">Конфликт слота</option>
      </select>
    </label>
    <Badge variant="outline" class="topbar-demo-badge">Demo</Badge>
    <Button
      class="btn-top"
      size="lg"
      type="button"
      onclick={() => onNavigate("booking")}
      disabled={!canCreateBooking}
    >
      <Plus size={17} strokeWidth={2} aria-hidden="true" /> Новая запись
    </Button>
  </div>
</header>
