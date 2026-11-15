<script lang="ts">
  import { ArrowRight, CalendarDays, Clock3, Info, MapPin, Scissors, UserRound } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
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
  <Card.Root class="booking-panel">
    <form class="booking-form" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div class="booking-form-header">
        <span class="booking-form-symbol" aria-hidden="true">
          <CalendarDays size={23} strokeWidth={1.8} />
        </span>
        <div class="booking-form-intro">
          <span class="eyebrow">НОВАЯ ЗАПИСЬ</span>
          <h2>Параметры визита</h2>
          <p>Выберите услугу, специалиста и удобное время.</p>
        </div>
      </div>

      <div class="booking-section-title">
        <span class="booking-section-count">01</span>
        <div><strong>Услуга и специалист</strong><small>Основные параметры визита</small></div>
      </div>
      <div class="booking-fields">
        <label class="field">
          <span class="field-label"><Scissors size={15} aria-hidden="true" /> Услуга</span>
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
            <span class="field-label"><MapPin size={15} aria-hidden="true" /> Филиал</span>
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
            <span class="field-label"><UserRound size={15} aria-hidden="true" /> Мастер</span>
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
      </div>

      <div class="booking-section-title">
        <span class="booking-section-count">02</span>
        <div><strong>Дата и время</strong><small>Предложения из демонстрационного графика</small></div>
      </div>
      <label class="field">
        <span class="field-label"><CalendarDays size={15} aria-hidden="true" /> Дата визита</span>
        <Input
          type="date"
          min={localDay(new Date())}
          value={bookingDate}
          onchange={(event) => onDateChange(event.currentTarget.value)}
          required
        />
      </label>

      <div class="field slot-field">
        <span class="field-label"><Clock3 size={15} aria-hidden="true" /> Свободное время <small>· демо</small></span>
        {#if busySlots}
          <div class="inline-note" role="status">Загружаем демонстрационные слоты…</div>
        {:else if slotSuggestions.length === 0}
          <div class="empty-slots" role="status">
            Нет демонстрационных слотов. Задайте график мастера или выберите рабочий день.
          </div>
        {:else}
          <div class="slot-grid" aria-label="Время визита">
            {#each slotSuggestions as slot (slot.time)}
              <Button
                type="button"
                variant="outline"
                class={bookingTime === slot.time ? "selected" : undefined}
                aria-pressed={bookingTime === slot.time}
                onclick={() => onTimeChange(slot.time)}
              >{slot.time}</Button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="booking-section-title">
        <span class="booking-section-count">03</span>
        <div><strong>Информация о клиенте</strong><small>Для проверки сценария используйте псевдоним</small></div>
      </div>
      <label class="field">
        <span class="field-label"><UserRound size={15} aria-hidden="true" /> Псевдоним клиента</span>
        <Input
          value={clientAlias}
          oninput={(event) => onAliasChange(event.currentTarget.value)}
          maxlength={80}
          required
          placeholder="Тестовый клиент"
        />
      </label>
      <div class="booking-privacy">
        <Info size={16} aria-hidden="true" />
        <span>Не указывайте реальные имена, номера телефонов и другие персональные данные.</span>
      </div>
      <Button
        class="book-submit"
        type="submit"
        size="lg"
        disabled={!canBook || busySlots}
      >
        Создать тестовую запись <ArrowRight size={17} aria-hidden="true" />
      </Button>
      <p class="booking-form-disclaimer">
        Это демонстрация интерфейса. Время не резервируется на сервере.
      </p>
    </form>
  </Card.Root>

  <BookingSummary
    service={selectedService}
    staffId={bookingStaff}
    {bookingDate}
    {bookingTime}
    {staffName}
  />
</div>
