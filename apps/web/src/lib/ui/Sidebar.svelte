<script lang="ts">
  import {
    ArrowUpRight, CalendarDays, CalendarCheck2, Clock3, LayoutDashboard,
    MapPin, Scissors, Store, UsersRound,
  } from "@lucide/svelte";
  import { Badge } from "../components/ui/badge/index.js";
  import { screens, type Screen } from "../navigation";

  export let screen: Screen;
  export let stepCount: number;
  export let onNavigate: (next: Screen) => void;
</script>

<aside class="sidebar" aria-label="Главная навигация">
  <div class="brand">
    <span class="brand-icon" aria-hidden="true"><CalendarCheck2 size={20} strokeWidth={2.2} /></span>
    <div>
      <strong>cookie<span class="brand-dot">.</span></strong>
      <small>salon workspace</small>
    </div>
  </div>

  <div class="sidebar-heading">РАБОЧЕЕ ПРОСТРАНСТВО</div>
  <nav class="nav-links" aria-label="Разделы Cookie">
    {#each screens as item (item.id)}
      <button
        type="button"
        class:active={screen === item.id}
        onclick={() => onNavigate(item.id)}
        aria-current={screen === item.id ? "page" : undefined}
      >
        <span class="nav-glyph" aria-hidden="true">
          {#if item.id === "home"}
            <LayoutDashboard size={18} strokeWidth={1.8} />
          {:else if item.id === "calendar"}
            <CalendarDays size={18} strokeWidth={1.8} />
          {:else if item.id === "services"}
            <Scissors size={18} strokeWidth={1.8} />
          {:else if item.id === "staff"}
            <UsersRound size={18} strokeWidth={1.8} />
          {:else if item.id === "schedule"}
            <Clock3 size={18} strokeWidth={1.8} />
          {:else if item.id === "locations"}
            <MapPin size={18} strokeWidth={1.8} />
          {:else}
            <ArrowUpRight size={18} strokeWidth={1.8} />
          {/if}
        </span>
        <span>{item.label}</span>
        {#if item.id === "booking"}
          <ArrowUpRight class="nav-external" size={14} aria-hidden="true" />
        {/if}
      </button>
    {/each}
  </nav>

  <div class="sidebar-bottom">
    <div class="sidebar-tip">
      <div class="tip-meta">
        <span>ПЕРВЫЕ ШАГИ</span>
        <Badge variant="secondary">{stepCount}/5</Badge>
      </div>
      <strong>Настройка салона</strong>
      <p>Услуги, специалисты, график и первая тестовая запись.</p>
      <div
        class="progress-track"
        role="progressbar"
        aria-label="Прогресс первоначальной настройки"
        aria-valuemin="0"
        aria-valuemax="5"
        aria-valuenow={stepCount}
      >
        <div style:width={`${stepCount * 20}%`}></div>
      </div>
      <small>{stepCount === 5 ? "Демо готово к просмотру" : `Выполнено ${stepCount} из 5`}</small>
    </div>
    <div class="workspace-identity">
      <span class="identity-avatar" aria-hidden="true"><Store size={17} /></span>
      <div>
        <strong>Тестовое пространство</strong>
        <small>Без реальных клиентов</small>
      </div>
    </div>
  </div>
</aside>
