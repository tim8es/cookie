<script lang="ts">
  import { ArrowUpRight, CalendarDays, Check, Clock3, LayoutDashboard, MapPin, Scissors, UsersRound } from "@lucide/svelte";
  import { screens, type Screen } from "../navigation";

  export let screen: Screen;
  export let stepCount: number;
  export let onNavigate: (next: Screen) => void;
</script>

<aside class="sidebar" aria-label="Главная навигация">
  <div class="brand">
    <span class="brand-seal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <div>
      <strong>cookie<span class="brand-dot">.</span></strong>
      <small>studio manager</small>
    </div>
  </div>

  <div class="sidebar-heading">Пространство</div>
  <nav class="nav-links" aria-label="Разделы Cookie">
    {#each screens as item (item.id)}
      <button type="button" class:active={screen === item.id}
        onclick={() => onNavigate(item.id)}
        aria-current={screen === item.id ? "page" : undefined}>
        <span class="nav-glyph" aria-hidden="true">
          {#if item.id === "home"}
            <LayoutDashboard size={18} strokeWidth={1.85}/>
          {:else if item.id === "calendar"}
            <CalendarDays size={18} strokeWidth={1.85}/>
          {:else if item.id === "services"}
            <Scissors size={18} strokeWidth={1.85}/>
          {:else if item.id === "staff"}
            <UsersRound size={18} strokeWidth={1.85}/>
          {:else if item.id === "schedule"}
            <Clock3 size={18} strokeWidth={1.85}/>
          {:else if item.id === "locations"}
            <MapPin size={18} strokeWidth={1.85}/>
          {:else}
            <ArrowUpRight size={18} strokeWidth={1.85}/>
          {/if}
        </span>
        <span>{item.label}</span>
      </button>
    {/each}
  </nav>

  <div class="sidebar-bottom">
    <div class="sidebar-tip">
      <div class="tip-progress-header">
        <span>Настройка пространства</span>
        <span>{stepCount} / 5</span>
      </div>
      <div class="progress-track" role="progressbar" aria-label="Прогресс первоначальной настройки"
        aria-valuemin="0" aria-valuemax="5" aria-valuenow={stepCount}>
        <div style:width={`${stepCount * 20}%`}></div>
      </div>
      <p>{stepCount === 5 ? "Все шаги демонстрации выполнены" : "Добавьте услуги, команду и расписание"}</p>
    </div>
    <div class="workspace-identity">
      <span class="identity-avatar" aria-hidden="true"><Check size={16}/></span>
      <div><strong>Демо-пространство</strong><small>Локальные данные</small></div>
    </div>
  </div>
</aside>
