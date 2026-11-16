<script lang="ts">
  import { ArrowUpRight, CalendarDays, CalendarPlus2, ChevronLeft, ChevronRight, Clock3, Plus } from "@lucide/svelte";
  import { Badge } from "../components/ui/badge/index.js";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
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

<div class="section-head calendar-page-head">
  <div>
    <span class="calendar-page-kicker">COOKIE / РАБОЧЕЕ ВРЕМЯ</span>
    <h1>Календарь записей</h1>
    <p>Демонстрационный график салона. Без реальных клиентов.</p>
  </div>
  <Button class="calendar-create" size="lg" type="button" onclick={onCreateBooking}>
    <Plus size={17} aria-hidden="true" /> Новая запись
  </Button>
</div>

<Card.Root class="calendar-card calendar-surface" role="region" aria-label="Демонстрационный календарь">
  <div class="calendar-toolbar">
    <div class="calendar-toolbar-heading">
      <span class="calendar-label"><CalendarDays size={15} aria-hidden="true" /> Период</span>
      <h2 aria-live="polite">
        {calendarMode === "day"
          ? longDate(calendarDate)
          : shortDate(weekDates[0] ?? calendarDate) + " — " + shortDate(weekDates[6] ?? calendarDate)}
      </h2>
    </div>
    <div class="calendar-toolbar-actions">
      <div class="calendar-move" role="group" aria-label="Навигация по датам">
        <Button variant="outline" class="calendar-nav-arrow" type="button"
          aria-label="Предыдущий период" onclick={() => changePeriod(-1)}>
          <ChevronLeft size={17} aria-hidden="true" />
        </Button>
        <Button variant="outline" type="button" class="calendar-today"
          onclick={() => calendarDate = localDay(new Date())}>Сегодня</Button>
        <Button variant="outline" class="calendar-nav-arrow" type="button"
          aria-label="Следующий период" onclick={() => changePeriod(1)}>
          <ChevronRight size={17} aria-hidden="true" />
        </Button>
      </div>
      <div class="segmented" role="group" aria-label="Период календаря">
        <Button type="button" variant="ghost"
          class={calendarMode === "day" ? "active" : undefined} aria-pressed={calendarMode === "day"}
          onclick={() => calendarMode = "day"}>День</Button>
        <Button type="button" variant="ghost"
          class={calendarMode === "week" ? "active" : undefined} aria-pressed={calendarMode === "week"}
          onclick={() => calendarMode = "week"}>Неделя</Button>
      </div>
    </div>
  </div>

  {#if calendarMode === "week"}
    <div class="calendar-week-scroller" role="region" aria-label="Неделя, прокручиваемая горизонтально при узком экране" tabindex="0">
      <div class="week-grid">
        {#each weekDates as day (day)}
          <div class="week-column">
            <button type="button" class="week-heading"
              class:today={day === localDay(new Date())}
              aria-label={"Открыть день: " + longDate(day)}
              onclick={() => { calendarDate = day; calendarMode = "day"; }}>
              <small>{new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(parseDay(day))}</small>
              <strong>{day.slice(-2)}</strong>
            </button>
            <div class="week-body">
              {#if bookingsForDay(bookings, day).length === 0}
                <span class="no-bookings" aria-label="Записей нет">—</span>
              {:else}
                {#each bookingsForDay(bookings, day) as booking (booking.id)}
                  <button type="button" class="calendar-event"
                    aria-label={"Демо-запись " + booking.time + ", " + serviceName(booking.serviceId) + ", " + staffName(booking.staffId)}
                    onclick={() => selectedBookingId = booking.id}>
                    <span class="calendar-event-time"><Clock3 size={12} aria-hidden="true" /> {booking.time}</span>
                    <strong>{serviceName(booking.serviceId)}</strong>
                    <small>{staffName(booking.staffId)}</small>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
    <p class="calendar-scroll-hint">На узком экране проведите по неделе в сторону, чтобы увидеть остальные дни.</p>
  {:else}
    <div class="day-timeline">
      {#if dayBookings.length === 0}
        <div class="empty-mini calendar-empty-day">
          <span aria-hidden="true"><CalendarPlus2 size={27} /></span>
          <strong>На этот день записей нет</strong>
          <p>Можно выбрать другой день или создать тестовую запись.</p>
          <Button type="button" variant="outline" onclick={onCreateBooking}>
            <Plus size={16} aria-hidden="true" /> Создать запись
          </Button>
        </div>
      {:else}
        <div class="day-timeline-heading">
          <span>{longDate(calendarDate)}</span>
          <Badge variant="secondary">{dayBookings.length} демо-зап.</Badge>
        </div>
        {#each dayBookings as booking (booking.id)}
          <button type="button" class="timeline-entry"
            aria-label={"Открыть демо-запись " + booking.time + ", " + serviceName(booking.serviceId)}
            onclick={() => selectedBookingId = booking.id}>
            <strong class="timeline-time">{booking.time}</strong>
            <span class="timeline-detail">
              <strong>{serviceName(booking.serviceId)}</strong>
              <span>{staffName(booking.staffId)} · {locationName(booking.locationId)}</span>
            </span>
            <Badge variant="secondary" class="calendar-demo-badge">Демо</Badge>
            <ArrowUpRight size={17} class="timeline-arrow" aria-hidden="true" />
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</Card.Root>

{#if chosenBooking}
  <BookingDetail booking={chosenBooking} {serviceName} {staffName} {locationName}
    onClose={() => selectedBookingId = ""} />
{/if}
