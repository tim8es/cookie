<script lang="ts">
  import type { Location, StaffMember } from "../model";
  import { weekdays } from "../weekdays";

  export let staff: StaffMember[];
  export let locations: Location[];
  export let scheduleStaff: string;
  export let scheduleLocation: string;
  export let scheduleDays: number[];
  export let scheduleStart: string;
  export let scheduleEnd: string;
  export let onStaffChange: (value: string) => void;
  export let onLocationChange: (value: string) => void;
  export let onToggleWeekday: (day: number) => void;
  export let onStartChange: (value: string) => void;
  export let onEndChange: (value: string) => void;
  export let onSubmit: () => void;
  export let onOpenStaff: () => void;
</script>

<form class="card" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
  <span class="eyebrow">НАСТРОИТЬ НЕДЕЛЮ</span>
  <h2>График мастера</h2>
  <label class="field">
    Мастер
    <select
      value={scheduleStaff}
      onchange={(event) => onStaffChange(event.currentTarget.value)}
      required
    >
      <option value="" disabled>Выберите мастера</option>
      {#each staff as member (member.id)}
        <option value={member.id}>{member.displayName}</option>
      {/each}
    </select>
  </label>
  <label class="field">
    Филиал
    <select
      value={scheduleLocation}
      onchange={(event) => onLocationChange(event.currentTarget.value)}
      required
    >
      <option value="" disabled>Выберите филиал</option>
      {#each locations as location (location.id)}
        <option value={location.id}>{location.name}</option>
      {/each}
    </select>
  </label>
  <div class="field">
    <span class="field-caption">Рабочие дни</span>
    <div class="weekday-select">
      {#each weekdays as day (day.number)}
        <button
          type="button"
          class:selected={scheduleDays.includes(day.number)}
          aria-pressed={scheduleDays.includes(day.number)}
          onclick={() => onToggleWeekday(day.number)}
        >{day.name}</button>
      {/each}
    </div>
  </div>
  <div class="form-pair">
    <label class="field">
      Начало
      <input
        type="time"
        value={scheduleStart}
        onchange={(event) => onStartChange(event.currentTarget.value)}
        required
      />
    </label>
    <label class="field">
      Окончание
      <input
        type="time"
        value={scheduleEnd}
        onchange={(event) => onEndChange(event.currentTarget.value)}
        required
      />
    </label>
  </div>
  {#if staff.length === 0}
    <button class="btn btn-secondary btn-wide" type="button" onclick={onOpenStaff}>
      Сначала добавьте мастера →
    </button>
  {:else}
    <button
      class="btn btn-primary btn-wide"
      type="submit"
      disabled={scheduleDays.length === 0}
    >
      Сохранить демо-график <span aria-hidden="true">→</span>
    </button>
  {/if}
</form>
