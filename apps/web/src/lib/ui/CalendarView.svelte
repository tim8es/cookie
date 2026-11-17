<script lang="ts">
  import { ArrowUpRight, CalendarDays, CalendarPlus2, ChevronLeft, ChevronRight, Clock3, Plus } from "@lucide/svelte";
  import { Badge } from "../components/ui/badge/index.js";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { bookingsForDay } from "../calendar";
  import { localDay, longDate, mondayOf, offsetDay, parseDay, shortDate } from "../dates";
  import type { BookingView, Service, SlotView, StaffMember } from "../model";
  import BookingDetail from "./BookingDetail.svelte";

  export let bookings: BookingView[];
  export let services: Service[];
  export let staff: StaffMember[];
  export let calendarDate: string;
  export let calendarMode: "day" | "week";
  export let serviceName: (id: string) => string;
  export let staffName: (id: string) => string;
  export let locationName: (id: string) => string;
  export let onCreateBooking: () => void;
  export let onReadRescheduleSlots: (id: string, date: string) => Promise<SlotView[]>;
  export let onRescheduleBooking: (id: string, date: string, time: string) => Promise<void>;
  export let onCancelBooking: (id: string) => Promise<void>;

  let selectedBookingId = "";

  $: weekDates = Array.from({ length: 7 }, (_, index) =>
    offsetDay(mondayOf(calendarDate), index),
  );
  $: activeBookings = bookings.filter((item) => item.status === "demo-confirmed");
  $: cancelledBookings = bookings.filter((item) => item.status === "demo-cancelled");
  $: dayBookings = bookingsForDay(activeBookings, calendarDate);
  $: chosenBooking = bookings.find((item) => item.id === selectedBookingId);

  // A visual schedule of existing synthetic bookings, NOT live availability.
  const hourHeight = 56;
  function startMinutes(time: string): number {
    const [hours = 0, minutes = 0] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }
  function bookingDuration(serviceId: string): number {
    return services.find((item) => item.id === serviceId)?.durationMinutes ?? 60;
  }
  // Show every member, including those without demo bookings: empty never implies availability.
  $: bookedStaff = staff;
  $: dayStartHour = dayBookings.length
    ? Math.max(6, Math.min(9, Math.floor(Math.min(...dayBookings.map((item) => startMinutes(item.time))) / 60) - 1))
    : 8;
  $: dayEndHour = dayBookings.length
    ? Math.min(24, Math.max(dayStartHour + 5, Math.ceil(Math.max(...dayBookings.map((item) =>
        startMinutes(item.time) + bookingDuration(item.serviceId))) / 60) + 1))
    : 18;
  $: hourLabels = Array.from({ length: dayEndHour - dayStartHour }, (_, index) => dayStartHour + index);
  $: boardHeight = (dayEndHour - dayStartHour) * hourHeight;

  function changePeriod(delta: number): void {
    calendarDate = offsetDay(calendarDate, calendarMode === "week" ? 7 * delta : delta);
  }
</script>

<div class="section-head calendar-page-head">
  <div>
    <span class="calendar-page-kicker">kuki / РАБОЧЕЕ ВРЕМЯ</span>
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
    <!-- A scrollable region needs keyboard focus at narrow widths; the Svelte warning does not account for overflow scrolling. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
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
              {#if bookingsForDay(activeBookings, day).length === 0}
                <span class="no-bookings" aria-label="Записей нет">—</span>
              {:else}
                {#each bookingsForDay(activeBookings, day) as booking (booking.id)}
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
        <div class="calendar-day-board" role="region" aria-label="Записи по мастерам и времени" tabindex="0">
          <div class="resource-time-column" aria-hidden="true">
            <span class="resource-column-heading">Время</span>
            <div class="resource-time-ticks" style:height={boardHeight + "px"}>
              {#each hourLabels as hour (hour)}
                <span style:top={(hour - dayStartHour) * hourHeight + "px"}>{String(hour).padStart(2, "0")}:00</span>
              {/each}
            </div>
          </div>
          {#each bookedStaff as member (member.id)}
            <section class="resource-staff-column" aria-label={"Записи мастера " + member.displayName}>
              <h3 class="resource-column-heading">{member.displayName}</h3>
              <div class="resource-time-lane" style:height={boardHeight + "px"}>
                {#if !dayBookings.some((item) => item.staffId === member.id)}
                  <span class="resource-empty">Нет демо-записей</span>
                {/if}
                {#each dayBookings.filter((item) => item.staffId === member.id) as booking (booking.id)}
                  <button type="button" class="resource-visit"
                    style:top={((startMinutes(booking.time) - dayStartHour * 60) / 60) * hourHeight + "px"}
                    style:height={Math.max(42, bookingDuration(booking.serviceId) / 60 * hourHeight - 4) + "px"}
                    aria-label={"Открыть демо-запись: " + booking.time + ", " + serviceName(booking.serviceId) + ", " + member.displayName}
                    onclick={() => selectedBookingId = booking.id}>
                    <span>{booking.time} · {bookingDuration(booking.serviceId)} мин</span>
                    <strong>{serviceName(booking.serviceId)}</strong>
                  </button>
                {/each}
              </div>
            </section>
          {/each}
        </div>
        <p class="calendar-board-note">Показаны только демо-записи, не реальные свободные окна.</p>
        <div class="calendar-day-list">
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
        </div>
      {/if}
    </div>
  {/if}
</Card.Root>

{#if cancelledBookings.length}
  <section class="calendar-cancelled-history" aria-label="История отменённых демо-записей">
    <h2>Отменённые демо-записи</h2>
    <p>Сохранены только в этой вкладке и не занимают время мастеров.</p>
    {#each cancelledBookings as booking (booking.id)}
      <button type="button" class="calendar-cancelled-entry"
        onclick={() => selectedBookingId = booking.id}>
        <span>{longDate(booking.date)}, {booking.time}</span>
        <strong>{serviceName(booking.serviceId)} · {staffName(booking.staffId)}</strong>
        <Badge variant="secondary">Отменена</Badge>
      </button>
    {/each}
  </section>
{/if}

{#if chosenBooking}
  <BookingDetail booking={chosenBooking} {serviceName} {staffName} {locationName}
    onReadMoveSlots={(date) => onReadRescheduleSlots(chosenBooking!.id, date)}
    onReschedule={(date, time) => onRescheduleBooking(chosenBooking!.id, date, time)}
    onCancel={() => onCancelBooking(chosenBooking!.id)}
    onClose={() => selectedBookingId = ""} />
{/if}
