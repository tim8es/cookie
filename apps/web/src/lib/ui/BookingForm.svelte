<script lang="ts">
  import { localDay } from "../dates";
  import type { DemoSnapshot, SlotView, StaffMember } from "../model";
  import BookingSummary from "./BookingSummary.svelte";

  export let data: DemoSnapshot;
  export let staffOptions: StaffMember[];
  export let bookingService: string;
  export let bookingStaff: string;
  export let bookingLocation: string;
  export let bookingDate: string;
  export let bookingTime: string;
  export let clientAlias: string;
  export let busySlots: boolean;
  export let slotSuggestions: SlotView[];
  export let canBook: boolean;

  export let staffName: (id: string) => string;
  export let onServiceChange: (id: string) => void;
  export let onLocationChange: (id: string) => void;
  export let onStaffChange: (id: string) => void;
  export let onDateChange: (date: string) => void;
  export let onTimeChange: (time: string) => void;
  export let onAliasChange: (alias: string) => void;
  export let onSubmit: () => void;

  $: selectedService = data.services.find((item) => item.id === bookingService);
</script>

<div class="booking-layout">
  <form
    class="card booking-form"
    onsubmit={(event) => { event.preventDefault(); onSubmit(); }}
  >
    <div class="card-title">
      <div>
        <span class="eyebrow">ШАГИ БРОНИРОВАНИЯ</span>
        <h2>Выберите время для визита</h2>
      </div>
      <span class="small-icon" aria-hidden="true">✳</span>
    </div>

    <label class="field">
      01 · Услуга
      <select
        value={bookingService}
        onchange={(event) => onServiceChange(event.currentTarget.value)}
        required
      >
        <option value="" disabled>Выберите услугу</option>
        {#each data.services as service (service.id)}
          <option value={service.id}>{service.name} · {service.durationMinutes} мин</option>
        {/each}
      </select>
    </label>

    <div class="form-pair">
      <label class="field">
        02 · Филиал
        <select
          value={bookingLocation}
          onchange={(event) => onLocationChange(event.currentTarget.value)}
          required
        >
          <option value="" disabled>Выберите филиал</option>
          {#each data.locations as location (location.id)}
            <option value={location.id}>{location.name}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        03 · Мастер
        <select
          value={bookingStaff}
          onchange={(event) => onStaffChange(event.currentTarget.value)}
          required
        >
          <option value="" disabled>Выберите мастера</option>
          {#each staffOptions as member (member.id)}
            <option value={member.id}>{member.displayName}</option>
          {/each}
        </select>
      </label>
    </div>

    <label class="field">
      04 · Дата
      <input
        type="date"
        min={localDay(new Date())}
        value={bookingDate}
        onchange={(event) => onDateChange(event.currentTarget.value)}
        required
      />
    </label>

    <div class="field">
      <span class="field-caption">05 · Время <small>(синтетические слоты)</small></span>
      {#if busySlots}
        <div class="inline-note" role="status">Загружаем демонстрационные слоты…</div>
      {:else if slotSuggestions.length === 0}
        <div class="empty-slots" role="status">
          Нет демонстрационных слотов. Сначала задайте график мастера либо выберите рабочий день.
        </div>
      {:else}
        <div class="slot-grid">
          {#each slotSuggestions as slot (slot.time)}
            <button
              type="button"
              class:selected={bookingTime === slot.time}
              aria-pressed={bookingTime === slot.time}
              onclick={() => onTimeChange(slot.time)}
            >{slot.time}</button>
          {/each}
        </div>
      {/if}
    </div>

    <label class="field">
      06 · Псевдоним тестового клиента
      <input
        value={clientAlias}
        oninput={(event) => onAliasChange(event.currentTarget.value)}
        maxlength="80"
        required
        placeholder="Тестовый клиент"
      />
    </label>
    <div class="inline-note">
      Не вводите реальные имена, телефоны или другие персональные данные.
      В реальном продукте идентификацию выполнит backend.
    </div>
    <button class="btn btn-primary btn-wide" type="submit" disabled={!canBook || busySlots}>
      Создать тестовую запись →
    </button>
  </form>
  <BookingSummary
    service={selectedService}
    staffId={bookingStaff}
    {bookingDate}
    {bookingTime}
    {staffName}
  />
</div>
