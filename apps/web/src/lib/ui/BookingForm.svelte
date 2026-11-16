<script lang="ts">
  import { ArrowUpRight, CalendarDays, Clock3, LockKeyhole, Scissors, UserRound, MapPin } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
  import { localDay, money } from "../dates";
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
        <div>
          <h2>Соберём ваш визит</h2>
          <p>Выберите услугу, дату и время, затем укажите, как к вам обращаться.</p>
        </div>
        <span class="booking-steps">Три раздела · одна форма</span>
      </div>

      <section class="booking-group" aria-labelledby="service-group-title">
        <div class="booking-group-head">
          <span class="booking-group-number">01</span>
          <div>
            <h3 id="service-group-title">Что будем делать?</h3>
            <p>Выберите услугу и специалиста</p>
          </div>
        </div>
        <div class="booking-fields">
          <label class="field">
            <span class="field-label"><Scissors size={15} aria-hidden="true" /> Услуга</span>
            <select value={bookingService} onchange={(event) => onServiceChange(event.currentTarget.value)} required>
              <option value="" disabled>Выберите услугу</option>
              {#each data.services as service (service.id)}
                <option value={service.id}>{service.name} · {service.durationMinutes} мин</option>
              {/each}
            </select>
          </label>
          <div class="form-pair">
            <label class="field">
              <span class="field-label"><MapPin size={15} aria-hidden="true" /> Филиал</span>
              <select value={bookingLocation} onchange={(event) => onLocationChange(event.currentTarget.value)} required>
                <option value="" disabled>Выберите филиал</option>
                {#each data.locations as location (location.id)}
                  <option value={location.id}>{location.name}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              <span class="field-label"><UserRound size={15} aria-hidden="true" /> Мастер</span>
              <select value={bookingStaff} onchange={(event) => onStaffChange(event.currentTarget.value)} required>
                <option value="" disabled>Выберите мастера</option>
                {#each staffOptions as member (member.id)}
                  <option value={member.id}>{member.displayName}</option>
                {/each}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section class="booking-group" aria-labelledby="date-group-title">
        <div class="booking-group-head">
          <span class="booking-group-number">02</span>
          <div>
            <h3 id="date-group-title">Когда вам удобно?</h3>
            <p>Выберите день и свободное время</p>
          </div>
        </div>
        <label class="field">
          <span class="field-label"><CalendarDays size={15} aria-hidden="true" /> Дата визита</span>
          <Input type="date" min={localDay(new Date())} value={bookingDate}
            onchange={(event) => onDateChange(event.currentTarget.value)} required />
        </label>
        <div class="field slot-field">
          <span class="field-label"><Clock3 size={15} aria-hidden="true" /> Время визита</span>
          {#if busySlots}
            <div class="inline-note" role="status">Подбираем демонстрационные слоты…</div>
          {:else if slotSuggestions.length === 0}
            <div class="empty-slots" role="status">
              Свободных демонстрационных интервалов нет. Выберите другой день или настройте график мастера.
            </div>
          {:else}
            <div class="slot-grid" aria-label="Доступное время">
              {#each slotSuggestions as slot (slot.time)}
                <Button type="button" variant="outline"
                  class={bookingTime === slot.time ? "selected" : undefined}
                  aria-pressed={bookingTime === slot.time}
                  onclick={() => onTimeChange(slot.time)}>{slot.time}</Button>
              {/each}
            </div>
          {/if}
        </div>
      </section>

      <section class="booking-group" aria-labelledby="client-group-title">
        <div class="booking-group-head">
          <span class="booking-group-number">03</span>
          <div>
            <h3 id="client-group-title">Как к вам обращаться?</h3>
            <p>В демо используйте только вымышленное имя</p>
          </div>
        </div>
        <label class="field">
          <span class="field-label"><UserRound size={15} aria-hidden="true" /> Псевдоним клиента</span>
          <Input value={clientAlias} oninput={(event) => onAliasChange(event.currentTarget.value)}
            maxlength={80} required placeholder="Тестовый клиент" />
        </label>
      </section>

      <div class="booking-checkout">
        <div class="booking-checkout-summary" aria-live="polite">
          <span>Предварительно по каталогу</span>
          <strong>{selectedService ? money(selectedService.basePriceRub) : "Выберите услугу"}</strong>
        </div>
        <div class="booking-privacy">
          <LockKeyhole size={17} aria-hidden="true" />
          <p>Демонстрация без передачи данных. Не вводите настоящие имена или телефоны.</p>
        </div>
        <Button class="book-submit" type="submit" size="lg" disabled={!canBook || busySlots}>
          <span>Создать тестовую запись</span>
          <ArrowUpRight size={19} aria-hidden="true" />
        </Button>
        <p class="booking-form-disclaimer">Время не бронируется на сервере</p>
      </div>
    </form>
  </Card.Root>
  <BookingSummary service={selectedService} location={data.locations.find((item) => item.id === bookingLocation)} staffId={bookingStaff}
    {bookingDate} {bookingTime} {staffName} />
</div>
