<script lang="ts">
  import type { DemoSnapshot } from "../model";
  import { weekdays } from "../weekdays";
  import ScheduleForm from "./ScheduleForm.svelte";

  export let data: DemoSnapshot;
  export let scheduleStaff: string;
  export let scheduleLocation: string;
  export let scheduleDays: number[];
  export let scheduleStart: string;
  export let scheduleEnd: string;
  export let getStaff: (id: string) => string;
  export let getLocation: (id: string) => string;
  export let onStaffChange: (value: string) => void;
  export let onLocationChange: (value: string) => void;
  export let onToggleWeekday: (day: number) => void;
  export let onStartChange: (value: string) => void;
  export let onEndChange: (value: string) => void;
  export let onOpenStaff: () => void;
  export let onSubmit: () => void;
</script>

<div class="section-head"><div><span class="eyebrow">РАБОЧЕЕ ВРЕМЯ</span><h1>Расписание</h1><p>Настройка шаблона рабочих дней для тестового мастера и филиала.</p></div></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">ТЕКУЩИЕ ГРАФИКИ</span><h2>Рабочие недели</h2>
          {#if data.schedules.length === 0}<div class="empty-mini"><span>◷</span><strong>График не задан</strong><p>Добавьте расписание, чтобы появились демо-слоты.</p></div>{:else}
            {#each data.schedules as schedule}<div class="schedule-summary"><div class="schedule-icon">◷</div><div><strong>{getStaff(schedule.staffId)}</strong><p>{getLocation(schedule.locationId)} · {schedule.startsAt}–{schedule.endsAt}</p><div class="weekday-chips">{#each weekdays as day}<span class:chosen={schedule.weekdays.includes(day.number)}>{day.name}</span>{/each}</div></div></div>{/each}
          {/if}
          <div class="inline-note">Изменения расписания не пересчитывают существующие записи. В production конфликты, права и занятость проверяет сервер.</div>
        </section>
        <ScheduleForm
            staff={data.staff}
            locations={data.locations}
            {scheduleStaff}
            {scheduleLocation}
            {scheduleDays}
            {scheduleStart}
            {scheduleEnd}
            {onStaffChange}
            {onLocationChange}
            {onToggleWeekday}
            {onStartChange}
            {onEndChange}
            {onOpenStaff}
            {onSubmit}
          /></div>
