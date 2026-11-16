<script lang="ts">
  import { onMount } from "../../apps/web/node_modules/svelte/src/index-client.js";
  import BookingForm from "../../apps/web/src/lib/ui/BookingForm.svelte";
  import BookingAttemptStatus from "../../apps/web/src/lib/ui/BookingAttemptStatus.svelte";
  import { BookingAttempt } from "../../apps/web/src/lib/booking-attempt";
  import { createProposedF1SyntheticLoopbackClient } from "../../apps/web/src/lib/proposed-f1-synthetic-loopback";
  import type { ClientBookingState } from "../../apps/web/src/lib/booking-attempt-view";
  import type { DemoSnapshot, SlotView } from "../../apps/web/src/lib/model";
  import type { BookingAttemptState } from "../../apps/web/src/lib/booking-attempt";
  import type { ConfirmedBookingReceiptView } from "../../apps/web/src/lib/booking-attempt-view";
  import type { ProposedF1AvailableSlot, ProposedF1SyntheticSelection } from "../../apps/web/src/lib/proposed-f1-synthetic-loopback";

  const q = new URLSearchParams(window.location.search);
  const tenantId = q.get("tenantId") ?? "";
  const locationId = q.get("locationId") ?? "";
  const staffId = q.get("staffId") ?? "";
  const serviceId = q.get("serviceId") ?? "";
  const customerId = q.get("customerId") ?? "";
  const syntheticBearer = q.get("syntheticBearer") ?? "";
  const localDate = "2027-04-13";
  const client = createProposedF1SyntheticLoopbackClient({
    origin: window.location.origin,
    tenantId,
    syntheticCustomerId: customerId,
    syntheticBearer,
    fetcher: fetch,
  });
  const attempt = new BookingAttempt(client.port, () => crypto.randomUUID());

  const data: DemoSnapshot = {
    organization: { id: tenantId, name: "Browser PG fixture (тест)", createdAt: "2027-04-01T00:00:00Z" },
    locations: [{ id: locationId, organizationId: tenantId, name: "Тестовый филиал", address: "Только локальный тест" }],
    services: [{ id: serviceId, organizationId: tenantId, name: "Тестовая стрижка", durationMinutes: 60, basePriceRub: 1500 }],
    staff: [{ id: staffId, organizationId: tenantId, displayName: "Синтетический мастер", positionTitle: "Тест", serviceIds: [serviceId] }],
    schedules: [],
    bookings: [],
  };

  let bookingService = serviceId;
  let bookingStaff = staffId;
  let bookingLocation = locationId;
  let bookingDate = localDate;
  let bookingTime = "";
  let clientAlias = "Тестовый клиент";
  let busySlots = true;
  let slotSuggestions: SlotView[] = [];
  let state: ClientBookingState = { phase: "idle" };
  let error = "";

  $: canBook = Boolean(bookingService && bookingStaff && bookingLocation && bookingDate && bookingTime && clientAlias.trim());
  $: selectedStaff = data.staff.filter((item) => item.serviceIds.includes(bookingService));

  function selection(): ProposedF1SyntheticSelection {
    return {
      locationId: bookingLocation,
      staffId: bookingStaff,
      serviceId: bookingService,
      localDate: bookingDate,
      startAt: `${bookingDate}T${bookingTime || "09:00"}:00Z`,
    };
  }

  function timeSlot(slot: ProposedF1AvailableSlot): SlotView {
    const time = slot.startAt.slice(11, 16);
    return { time, label: time };
  }

  function present(value: BookingAttemptState<ConfirmedBookingReceiptView, ProposedF1AvailableSlot>): ClientBookingState {
    return value.phase === "conflict"
      ? { ...value, slots: value.slots.map(timeSlot) }
      : value;
  }

  async function refresh(): Promise<void> {
    busySlots = true;
    error = "";
    bookingTime = "";
    try {
      const latest = await client.readAvailability(selection());
      slotSuggestions = latest.slots.filter((slot) => slot.startAt.endsWith(":00.000Z")).map(timeSlot);
    } catch {
      slotSuggestions = [];
      error = "Синтетический сервер отказал или недоступен";
    } finally {
      busySlots = false;
    }
  }

  onMount(() => { void refresh(); });

  async function submit(): Promise<void> {
    const work = attempt.submit(selection());
    state = { phase: "submitting" };
    state = present(await work);
  }

  async function retry(): Promise<void> {
    const work = attempt.retry();
    state = { phase: "submitting" };
    state = present(await work);
  }
</script>

<main class="public-shell" style="max-width: 1100px; margin: 0 auto; padding: 20px;">
  <header style="padding: 12px 0 24px;">
    <h1>Cookie F1 · локальный браузерный тест</h1>
    <p>Изолированная тестовая форма. Нажатие создаёт настоящую запись только в синтетической PostgreSQL CI.</p>
    <p>Никаких реальных клиентов, оплат, публичных сессий и production-маршрутов.</p>
  </header>
  <BookingForm
    {data} staffOptions={selectedStaff} {bookingService} {bookingStaff}
    {bookingLocation} {bookingDate} {bookingTime} {clientAlias}
    {busySlots} {slotSuggestions} {canBook}
    staffName={(id) => data.staff.find((person) => person.id === id)?.displayName ?? "—"}
    onServiceChange={(id) => { bookingService = id; void refresh(); }}
    onLocationChange={(id) => { bookingLocation = id; void refresh(); }}
    onStaffChange={(id) => { bookingStaff = id; void refresh(); }}
    onDateChange={(day) => { bookingDate = day; void refresh(); }}
    onTimeChange={(time) => { bookingTime = time; }}
    onAliasChange={(alias) => { clientAlias = alias; }}
    onSubmit={() => { void submit(); }}
  />
  {#if error}<p role="alert">{error}</p>{/if}
  <BookingAttemptStatus {state} onRetry={() => { void retry(); }}
    onChooseSlot={(time) => { bookingTime = time; state = { phase: "idle" }; }}
    onEditSelection={() => { state = { phase: "idle" }; void refresh(); }}
  />
</main>
