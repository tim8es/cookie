<script lang="ts">
  import { longDate } from "../dates";
  import type { BookingView, DemoSnapshot } from "../model";
  import type { Screen } from "../navigation";

  /** Render-only. Navigation and state mutations belong to App. */
  export let organizationName: string;
  export let data: DemoSnapshot;
  export let stepCount: number;
  export let calendarDate: string;
  export let dayBookings: BookingView[];
  export let getService: (id: string) => string;
  export let getStaff: (id: string) => string;
  export let onNavigate: (next: Screen) => void;
</script>

          <div class="section-head dashboard-welcome"><div><p class="dashboard-kicker">Cookie / рабочее пространство</p><h1>Хорошего дня!</h1><p><strong>{organizationName}</strong> · здесь начинается порядок в записи</p></div><button class="btn btn-secondary" onclick={() => onNavigate("booking")}>Открыть запись ↗</button></div>
          <div class="stat-grid">
            <div class="stat-card"><span>Услуги</span><strong>{data.services.length.toString().padStart(2, "0")}</strong><small>в каталоге</small><span class="stat-symbol" aria-hidden="true">01</span></div>
            <div class="stat-card"><span>Мастера</span><strong>{data.staff.length.toString().padStart(2, "0")}</strong><small>в команде</small><span class="stat-symbol" aria-hidden="true">02</span></div>
            <div class="stat-card"><span>Демо-записи</span><strong>{data.bookings.length.toString().padStart(2, "0")}</strong><small>в этой вкладке</small><span class="stat-symbol" aria-hidden="true">03</span></div>
            <div class="stat-card"><span>Филиалы</span><strong>{data.locations.length.toString().padStart(2, "0")}</strong><small>тестовые точки</small><span class="stat-symbol" aria-hidden="true">04</span></div>
          </div>
          <div class="dashboard-grid"><section class="card dashboard-onboarding"><div class="card-title"><div><span class="eyebrow">БЫСТРЫЙ СТАРТ</span><h2>Подготовьте салон к первой записи</h2></div><span class="round-progress">{stepCount}/5</span></div><div class="checklist">
            {#each [{key:"organization",text:"Создать салон",screen:"home"},{key:"services",text:"Добавить услугу и цену",screen:"services"},{key:"staff",text:"Добавить мастера",screen:"staff"},{key:"schedule",text:"Настроить график",screen:"schedule"},{key:"booking",text:"Создать тестовую запись",screen:"booking"}] as step, index}
              <button class="check-row" onclick={() => onNavigate(step.screen as Screen)}><span class:done={index < stepCount} class="check-indicator">{index < stepCount ? "✓" : index + 1}</span><span>{step.text}</span><span class="check-arrow">→</span></button>
            {/each}</div></section>
            <section class="card today-card"><div class="card-title"><div><span class="eyebrow">ЗАПИСИ</span><h2>Ближайший день</h2></div><span class="small-icon">◷</span></div><p class="muted">{longDate(calendarDate)}</p>
              {#if dayBookings.length === 0}<div class="empty-mini"><span>▦</span><strong>Пока записей нет</strong><p>Создайте первую демо-запись, чтобы увидеть её в календаре.</p></div>{:else}
                {#each dayBookings.slice(0, 3) as booking}<div class="mini-booking"><strong>{booking.time}</strong><div>{getService(booking.serviceId)}<small>{getStaff(booking.staffId)}</small></div></div>{/each}
              {/if}<button class="text-link" onclick={() => onNavigate("calendar")}>Открыть календарь →</button>
            </section></div>
