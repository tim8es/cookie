<script lang="ts">
  import type { ViewState } from "../model";
  import { screens, type Screen } from "../navigation";

  export let screen: Screen;
  export let preview: ViewState;
  export let canCreateBooking: boolean;
  export let onNavigate: (next: Screen) => void;

  $: displayTitle =
    screens.find((item) => item.id === screen)?.label ?? "Cookie";
</script>

<div class="demo-ribbon">
  <span class="ribbon-pulse" aria-hidden="true"></span>
  <strong>DEMO MODE</strong>
  <span>Данные синтетические · только sessionStorage · нет связи с backend</span>
</div>

<header class="topbar">
  <div class="topbar-title">
    <span class="breadcrumb">Workspace <span aria-hidden="true">/</span></span>
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
    <button
      class="btn btn-primary btn-top"
      type="button"
      onclick={() => onNavigate("booking")}
      disabled={!canCreateBooking}
    >
      + Новая запись
    </button>
  </div>
</header>
