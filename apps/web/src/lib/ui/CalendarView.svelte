<script lang="ts">
  import { bookingsForDay } from "../calendar";
  import { localDay, longDate, mondayOf, offsetDay, parseDay, shortDate } from "../dates";
  import type { BookingView } from "../model";
  import BookingDetail from "./BookingDetail.svelte";

  export let bookings: BookingView[];
  export let calendarDate: string;
  export let calendarMode: "day" | "week";
  export let serviceName: (id: string) => string;
  export let staffName: (id: string) => string;
  export let locationName: (id: string) => string;
  export let onCreateBooking: () => void;

  let selectedBookingId = "";

  $: weekDates = Array.from({ length: 7 }, (_, index) =>
    offsetDay(mondayOf(calendarDate), index),
  );
  $: dayBookings = bookingsForDay(bookings, calendarDate);
  $: chosenBooking = bookings.find((item) => item.id === selectedBookingId);

  function changePeriod(delta: number): void {
    calendarDate = offsetDay(calendarDate, calendarMode === "week" ? 7 * delta : delta);
  }
</script>

<div class="section-head">
  <div>
    <span class="eyebrow">РАСПИСАНИЕ ВИЗИТОВ</span>
    <h1>Календарь записей</h1>
    <p>Только тестовые записи. Без доступа к реальным клиентам.</p>
  </div>
  <button type="button" class="btn btn-primary" onclick={onCreateBooking}>
    + Новая запись
  </button>
</div>

<section class="card calendar-card" aria-label="Демонстрационный календарь">
  <div class="calendar-toolbar">
    <div class="calendar-move">
      <button
        type="button"
        aria-label="Предыдущий период"
        onclick={() => changePeriod(-1)}
      >‹</button>
      <button type="button" onclick={() => calendarDate = localDay(new Date())}>
        Сегодня
      </button>
      <button
        type="button"
        aria-label="Следующий период"
        onclick={() => changePeriod(1)}
      >›</button>
    </div>
    <h2 aria-live="polite">
      {calendarMode === "day"
        ? longDate(calendarDate)
        : `${shortDate(weekDates[0] ?? calendarDate)} — ${shortDate(weekDates[6] ?? calendarDate)}`}
    </h2>
    <div class="segmented" aria-label="Период календаря">
      <button
        type="button"
        class:active={calendarMode === "day"}
        aria-pressed={calendarMode === "day"}
        onclick={() => calendarMode = "day"}
      >День</button>
      <button
        type="button"
        class:active={calendarMode === "week"}
        aria-pressed={calendarMode === "week"}
        onclick={() => calendarMode = "week"}
      >Неделя</button>
    </div>
  </div>
  {#if calendarMode === "week"}
    <div class="week-grid">
      {#each weekDates as day (day)}
        <div class="week-column">
          <button
            type="button"
            class="week-heading"
            class:today={day === localDay(new Date())}
            aria-label={`Открыть день: ${longDate(day)}`}
            onclick={() => { calendarDate = day; calendarMode = "day"; }}
          >
            <small>{new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(parseDay(day))}</small>
            <strong>{day.slice(-2)}</strong>
          </button>
          <div class="week-body">
            {#if bookingsForDay(bookings, day).length === 0}
              <div class="no-bookings">—</div>
            {:else}
              {#each bookingsForDay(bookings, day) as booking (booking.id)}
                <button
                  type="button"
                  class="calendar-event"
                  aria-label={`Демо-запись ${booking.time}, ${serviceName(booking.serviceId)}, ${staffName(booking.staffId)}`}
                  onclick={() => selectedBookingId = booking.id}
                >
                  <span>{booking.time}</span>
                  <strong>{serviceName(booking.serviceId)}</strong>
                  <small>{staffName(booking.staffId)}</small>
                </button>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="day-timeline">
      {#if dayBookings.length === 0}
        <div class="empty-mini">
          <span aria-hidden="true">▦</span>
          <strong>На этот день записей нет</strong>
          <p>Выберите другой день или создайте тестовую запись.</p>
          <button type="button" class="btn btn-secondary" onclick={onCreateBooking}>
            Создать запись
          </button>
        </div>
      {:else}
        {#each dayBookings as booking (booking.id)}
          <button
            type="button"
            class="timeline-entry"
            onclick={() => selectedBookingId = booking.id}
          >
            <strong class="timeline-time">{booking.time}</strong>
            <div class="timeline-detail">
              <strong>{serviceName(booking.serviceId)}</strong>
              <span>{staffName(booking.staffId)} · {locationName(booking.locationId)}</span>
            </div>
            <span class="status-pill">Демо</span>
            <span aria-hidden="true">→</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</section>

{#if chosenBooking}
  <BookingDetail
    booking={chosenBooking}
    {serviceName}
    {staffName}
    {locationName}
    onClose={() => selectedBookingId = ""}
  />
{/if}
