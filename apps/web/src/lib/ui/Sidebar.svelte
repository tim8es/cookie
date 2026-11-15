<script lang="ts">
  import { screens, type Screen } from "../navigation";

  export let screen: Screen;
  export let stepCount: number;
  export let onNavigate: (next: Screen) => void;
</script>

<aside class="sidebar" aria-label="Главная навигация">
  <div class="brand">
    <span class="brand-mark">C<span class="brand-petal">✳</span></span>
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
        <span class="nav-glyph" aria-hidden="true">{item.glyph}</span>
        {item.label}
        {#if item.id === "booking"}
          <span class="nav-external" aria-hidden="true">↗</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="sidebar-bottom">
    <div class="sidebar-tip">
      <span class="tip-spark" aria-hidden="true">✳</span>
      <strong>Первый салон за 5 шагов</strong>
      <p>Создайте организацию, услуги, команду, расписание и первую запись.</p>
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
      <small>{stepCount} из 5 шагов</small>
    </div>
    <div class="workspace-identity">
      <span class="identity-avatar" aria-hidden="true">T</span>
      <div>
        <strong>Тестовое пространство</strong>
        <small>Не production-аккаунт</small>
      </div>
    </div>
  </div>
</aside>
