<script lang="ts">
  import { ArrowUpRight, Info } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { Location, StaffMember } from "../model";
  import { weekdays } from "../weekdays";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";

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

<Card.Root class="owner-form-panel">
  <form class="owner-form" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <OwnerFormHeader kind="schedule" eyebrow="РАСПИСАНИЕ / 03"
      title="График мастера" description="Настройте демонстрационную рабочую неделю." />
    <div class="owner-form-fields">
      <label class="field">
        Мастер
        <select value={scheduleStaff}
          onchange={(event) => onStaffChange(event.currentTarget.value)} required>
          <option value="" disabled>Выберите мастера</option>
          {#each staff as member (member.id)}
            <option value={member.id}>{member.displayName}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        Филиал
        <select value={scheduleLocation}
          onchange={(event) => onLocationChange(event.currentTarget.value)} required>
          <option value="" disabled>Выберите филиал</option>
          {#each locations as location (location.id)}
            <option value={location.id}>{location.name}</option>
          {/each}
        </select>
      </label>
      <div class="field">
        <span class="field-caption" id="owner-weekdays-label">Рабочие дни</span>
        <div class="weekday-select" role="group" aria-labelledby="owner-weekdays-label">
          {#each weekdays as day (day.number)}
            <Button type="button" variant="outline"
              class={scheduleDays.includes(day.number) ? "selected" : undefined}
              aria-pressed={scheduleDays.includes(day.number)}
              onclick={() => onToggleWeekday(day.number)}>{day.name}</Button>
          {/each}
        </div>
      </div>
      <div class="form-pair">
        <label class="field">
          Начало смены
          <Input type="time" value={scheduleStart}
            onchange={(event) => onStartChange(event.currentTarget.value)} required />
        </label>
        <label class="field">
          Окончание смены
          <Input type="time" value={scheduleEnd}
            onchange={(event) => onEndChange(event.currentTarget.value)} required />
        </label>
      </div>
    </div>
    <div class="owner-form-note">
      <Info size={16} aria-hidden="true" />
      <span>Это шаблон демо-недели, а не реальная доступность. Занятость и конфликты проверяет сервер.</span>
    </div>
    {#if staff.length === 0}
      <Button class="owner-submit owner-submit-secondary" variant="outline" type="button" size="lg" onclick={onOpenStaff}>
        Сначала добавьте мастера <ArrowUpRight size={17} aria-hidden="true" />
      </Button>
    {:else}
      <Button class="owner-submit" type="submit" size="lg" disabled={scheduleDays.length === 0}>
        Сохранить демо-график <ArrowUpRight size={17} aria-hidden="true" />
      </Button>
    {/if}
  </form>
</Card.Root>
