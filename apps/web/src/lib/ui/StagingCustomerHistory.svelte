<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import Segment from "../components/rhythm/Segment.svelte";
  import EmptyState from "../components/rhythm/EmptyState.svelte";
  import ThemeScope from "../components/rhythm/ThemeScope.svelte";
  import { filterOwnBookings, type HistoryFilter } from "../customer-history-filter";
  import { cancelOwnBooking, readCancellationCutoff, CancellationError } from "../staging-customer-cancellation-api";
  import { rescheduleOwnBooking, readRescheduleCutoff, readRescheduleSlots, CustomerRescheduleError, type CustomerRescheduleSlots } from "../staging-customer-reschedule-api";
  import type { VerifiedCustomerSession } from "../owner-auth";
  import { readOwnBookings, CustomerHistoryError, type OwnBookingHistory, type OwnBooking, type CustomerBookingStatus } from "../staging-customer-history-api";

  export let session: VerifiedCustomerSession;
  export let onUnauthorized: () => void;
  export let onHistory: (value: OwnBookingHistory | null) => void = () => {};
  export let onNewBooking: () => void = () => {};
  export let newBookingAvailable = false;
  export let creationUnresolved = false;
  export let mutationPending = false;
  export let canStartHistoryMutation: () => boolean = () => true;
  let data: OwnBookingHistory | null = null;
  let busy = true;
  let failed = false;
  let mounted = true;
  let generation = 0;
  let cutoff: number | null = null;
  let moveCutoff: number | null = null;
  let moveBookingId: string | null = null;
  let moveDate = "";
  let moveTimeZone: string | null = null;
  let moveOriginalStart = "";
  let moveSlots: CustomerRescheduleSlots | null = null;
  let moveSlotId = "";
  let moveSlotsBusy = false;
  let moveSlotsError = "";
  let moveGeneration = 0;
  let movePending: { bookingId: string; key: string; newStartAt: string } | null = null;
  let moveBusy = false;
  let moveUncertain = false;
  let pending: { bookingId: string; key: string } | null = null;
  let cancellationBusy = false;
  let uncertain = false;
  let message = "";
  let filter: HistoryFilter = "all";
  let selectedBookingId: string | null = null;
  function toggleBooking(id: string): void {
    if (busy || cancellationBusy || moveBusy || pending || moveBookingId || movePending) return;
    selectedBookingId = selectedBookingId === id ? null : id;
  }
  $: mutationPending = cancellationBusy || moveBusy || !!pending || !!moveBookingId || !!movePending;
  $: filterLocked = busy || mutationPending;
  export function hasPendingMutation(): boolean {
    return cancellationBusy || moveBusy || !!pending || !!moveBookingId || !!movePending;
  }
  $: filterOptions = [
    { id: "all", label: "Все", disabled: filterLocked },
    { id: "confirmed", label: "Активные", disabled: filterLocked },
    { id: "cancelled", label: "Отменённые", disabled: filterLocked },
  ];
  $: visibleBookings = filterOwnBookings(data?.bookings ?? [], filter);
  function selectFilter(id: string): void {
    if (busy || cancellationBusy || moveBusy || pending || moveBookingId || movePending) return;
    if (id === "all" || id === "confirmed" || id === "cancelled") {
      filter = id;
      selectedBookingId = null;
    }
  }
  const historyClocks = new Map<string, Intl.DateTimeFormat>();
  const priceFormatter = new Intl.NumberFormat("ru-RU");
  function branchDate(value: string, zone: string): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(value));
    const field = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
    return field("year") + "-" + field("month") + "-" + field("day");
  }
  function slotTime(value: string, zone: string): string {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: zone, hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset",
    }).format(new Date(value));
  }
  function closeMove(): void {
    if (moveBusy || moveUncertain) return;
    moveGeneration++;
    moveBookingId = null;
    movePending = null;
    moveDate = "";
    moveTimeZone = null;
    moveOriginalStart = "";
    moveSlots = null;
    moveSlotId = "";
    moveSlotsBusy = false;
    moveSlotsError = "";
  }
  async function loadMoveSlots(): Promise<void> {
    if (!moveBookingId || !moveTimeZone || !moveDate || movePending || moveBusy || busy) return;
    const version = ++moveGeneration;
    const bookingId = moveBookingId;
    const localDate = moveDate;
    const zone = moveTimeZone;
    moveSlots = null;
    moveSlotId = "";
    moveSlotsError = "";
    moveSlotsBusy = true;
    try {
      const result = await readRescheduleSlots(session, bookingId, localDate, zone);
      if (!mounted || version !== moveGeneration || moveBookingId !== bookingId) return;
      moveSlots = result;
    } catch (reason) {
      if (!mounted || version !== moveGeneration || moveBookingId !== bookingId) return;
      if (reason instanceof CustomerRescheduleError && reason.reason === "denied") {
        onUnauthorized();
        return;
      }
      moveSlotsError = reason instanceof CustomerRescheduleError && reason.reason === "conflict"
        ? "Запись или расписание больше недоступны для переноса. Обновите записи."
        : "Не удалось загрузить свободные интервалы. Повторите запрос.";
    } finally {
      if (mounted && version === moveGeneration) moveSlotsBusy = false;
    }
  }
  function startMove(booking: OwnBooking): void {
    if (creationUnresolved || !canStartHistoryMutation() || busy || moveBusy || cancellationBusy || pending || movePending || moveCutoff === null || !booking.timeZone)
      return;
    moveGeneration++;
    moveBookingId = booking.bookingId;
    moveTimeZone = booking.timeZone;
    moveOriginalStart = booking.startAt;
    moveDate = branchDate(booking.startAt, booking.timeZone);
    moveSlots = null;
    moveSlotId = "";
    moveSlotsError = "";
    message = "";
    void loadMoveSlots();
  }
  function prepareMove(): void {
    if (!moveBookingId || moveBusy || busy || movePending || moveSlotsBusy) return;
    const chosen = moveSlots?.slots.find((slot) => slot.startAt === moveSlotId);
    if (!chosen || chosen.startAt === moveOriginalStart) {
      moveSlotsError = "Выберите свободное время из списка сервера.";
      return;
    }
    movePending = { bookingId: moveBookingId, newStartAt: chosen.startAt, key: globalThis.crypto.randomUUID() };
    moveUncertain = false;
    message = "";
  }
  async function confirmMove(): Promise<void> {
    if (!movePending || moveBusy || busy) return;
    const attempt = movePending;
    const previouslyUncertain = moveUncertain;
    moveBusy = true; onHistory(null); message = "";
    try {
      const receipt = await rescheduleOwnBooking(session, attempt.bookingId, attempt.newStartAt, attempt.key);
      if (!mounted) return;
      movePending = null; moveBookingId = null; moveUncertain = false;
      message = "Перенос подтверждён сервером. Время записи: " + time(receipt.startAt, "UTC");
      await refresh();
    } catch (reason) {
      if (!mounted) return;
      if (previouslyUncertain) {
        // A rejected replay cannot disprove the original transaction's commit.
        moveUncertain = true;
        message = "Результат исходного переноса не подтверждён. Повторите тот же запрос с исходным ключом.";
        // A denial may mean the entire customer context was revoked. Hide
        // stale history and revalidate it without discarding the pending key.
        if (reason instanceof CustomerRescheduleError && reason.reason === "denied") await refresh();
      } else if (reason instanceof CustomerRescheduleError && reason.reason === "conflict") {
        movePending = null; moveBookingId = null; moveUncertain = false;
        message = "Перенос не выполнен. Выбранное время или правило изменилось, обновите список.";
        await refresh();
      } else if (reason instanceof CustomerRescheduleError && reason.reason === "denied") {
        movePending = null; moveBookingId = null; moveUncertain = false;
        message = "Нет доступа к переносу. Проверьте текущий сеанс.";
        await refresh();
      } else {
        moveUncertain = true;
        message = "Результат переноса не подтверждён. Повторите тот же запрос; новая запись не создаётся.";
      }
    } finally { if (mounted) moveBusy = false; }
  }
  function selectCancellation(bookingId: string): void {
    if (creationUnresolved || !canStartHistoryMutation() || pending || cancellationBusy || busy || cutoff === null || moveBusy || movePending || moveBookingId) return;
    pending = { bookingId, key: globalThis.crypto.randomUUID() };
    uncertain = false; message = "";
  }
  async function confirmCancellation(): Promise<void> {
    if (!pending || cancellationBusy || busy) return;
    const attempt = pending;
    cancellationBusy = true;
    onHistory(null);
    message = "";
    try {
      await cancelOwnBooking(session, attempt.bookingId, attempt.key);
      if (!mounted) return;
      pending = null; uncertain = false;
      filter = "all";
      message = "Запись отменена сервером. Для новой записи обновите свободное время.";
      await refresh();
    } catch (reason) {
      if (!mounted) return;
      if (!uncertain && reason instanceof CancellationError && reason.reason === "conflict") {
        pending = null;
        message = "Отмена недоступна. Проверьте актуальный статус записи или обратитесь в салон.";
        await refresh();
      } else if (!uncertain && reason instanceof CancellationError && reason.reason === "denied") {
        pending = null;
        message = "Нет доступа к отмене. Проверьте действующий сеанс.";
        await refresh();
      } else {
        uncertain = true;
        message = "Результат отмены не подтверждён. Повторите исходный запрос или проверьте статус в списке.";
      }
    } finally { if (mounted) cancellationBusy = false; }
  }
  const statuses: Record<CustomerBookingStatus, string> = {
    Confirmed: "Подтверждена",
    CancelledByClient: "Отменена клиентом",
    CancelledByBusiness: "Отменена салоном",
    Completed: "Завершена",
    NoShow: "Неявка",
  };

  async function refresh(): Promise<void> {
    const version = ++generation;
    data = null;
    onHistory(null);
    cutoff = null;
    moveCutoff = null;
    moveGeneration++;
    moveSlots = null;
    moveSlotId = "";
    moveSlotsBusy = false;
    busy = true;
    failed = false;
    try {
      const result = await readOwnBookings(session);
      if (!mounted || generation !== version) return;
      if (Date.now() / 1000 >= session.expiresAtUnixSeconds) { onUnauthorized(); return; }
      data = result;
      // The current own-booking state can resolve the UI lock, but is not
      // evidence of which cancellation command committed.
      if (uncertain && pending && !cancellationBusy && result.bookings.some(row => row.bookingId === pending?.bookingId && row.status === "CancelledByClient")) {
        pending = null;
        uncertain = false;
        filter = "all";
        message = "В списке сервера запись отменена клиентом.";
      }
      onHistory(result);
      const [cancelPolicy, movePolicy] = await Promise.all([
        readCancellationCutoff(session), readRescheduleCutoff(session),
      ]);
      if (mounted && generation === version) {
        cutoff = cancelPolicy;
        moveCutoff = movePolicy;
      }
    } catch (reason) {
      if (!mounted || generation !== version) return;
      if (reason instanceof CustomerHistoryError && reason.reason === "unauthorized") {
        onUnauthorized();
        return;
      }
      failed = true;
    } finally {
      if (mounted && generation === version) busy = false;
    }
  }

  function time(value: string, zone: string | null): string {
    const key = zone ?? "UTC";
    let formatter = historyClocks.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: key, year: "numeric", month: "short",
        day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset",
      });
      if (historyClocks.size >= 64) historyClocks.clear();
      historyClocks.set(key, formatter);
    }
    return formatter.format(new Date(value));
  }
  function price(value: string): string {
    const amount = BigInt(value);
    return priceFormatter.format(amount / 100n) + "," + String(amount % 100n).padStart(2, "0") + " ₽";
  }
  onMount(() => { void refresh(); return () => { mounted = false; generation++; moveGeneration++; }; });
</script>

<section class="card" aria-label="Мои записи">
  <div class="card-title">
    <div><span class="eyebrow">STAGING / ЛИЧНЫЙ КАБИНЕТ</span><h2>Мои записи</h2></div>
    <div class="history-header-actions">
      <Button type="button" disabled={filterLocked || !newBookingAvailable} onclick={onNewBooking}>Новая запись</Button>
      <Button type="button" variant="outline" disabled={busy || cancellationBusy || moveBusy} onclick={() => void refresh()}>Обновить записи</Button>
    </div>
  </div>
  {#if message}<p role="status">{message}</p>{/if}
  {#if creationUnresolved}<p role="status">Сначала подтвердите результат новой записи. Отмена и перенос временно недоступны.</p>{/if}
  {#if uncertain && pending}<Button type="button" disabled={cancellationBusy || busy} onclick={() => void confirmCancellation()}>Повторить запрос отмены</Button>{/if}
  {#if moveUncertain && movePending}<Button type="button" disabled={moveBusy || busy} onclick={() => void confirmMove()}>Повторить исходный перенос</Button>{/if}
  {#if busy}<p role="status">Загружаем ваши записи…</p>
  {:else if failed}<p role="alert" class="alert-error">Не удалось получить ваши записи. Обновите список или проверьте доступ.</p>
  {:else if data}
    <ThemeScope>
      {#if data.bookings.length === 0}
        <EmptyState title="У вас пока нет записей." description="После подтверждения записи она появится здесь." />
      {:else}
        <div class="history-filters">
          <Segment label="Статус записи" options={filterOptions} selected={filter} onSelect={selectFilter} />
          <p class="rhythm-muted" role="status">Показано: {visibleBookings.length} из {data.bookings.length}</p>
        </div>
        {#if visibleBookings.length === 0}
          <EmptyState title="Нет записей" description="В выбранном разделе пока ничего нет."
            actionLabel={filterLocked ? undefined : "Показать все записи"} onAction={() => selectFilter("all")} />
        {:else}
      <ul class="customer-history">
        {#each visibleBookings as booking (booking.bookingId)}
          <li data-booking-id={booking.bookingId}>
            <div class="history-heading"><strong>{booking.serviceName}</strong><span>{statuses[booking.status]}</span></div>
            <p>{booking.staffName} · {booking.locationName}</p>
            <p><time datetime={booking.startAt}>{time(booking.startAt, booking.timeZone)}</time> — <time datetime={booking.endAt}>{time(booking.endAt, booking.timeZone)}</time></p>
            {#if !booking.timeZone}<p>Часовой пояс филиала не задан; показано UTC.</p>{/if}
            <p>Стоимость записи: {price(booking.priceKopecks)}</p>
            <p class="history-id">Номер: {booking.bookingId}</p>
            <Button type="button" variant="outline" disabled={filterLocked}
              aria-label={(selectedBookingId === booking.bookingId ? "Закрыть запись: " : "Открыть запись: ") + booking.serviceName + ", " + time(booking.startAt, booking.timeZone)}
              aria-expanded={selectedBookingId === booking.bookingId}
              aria-controls={"customer-visit-" + booking.bookingId}
              onclick={() => toggleBooking(booking.bookingId)}>
              {selectedBookingId === booking.bookingId ? "Закрыть запись" : "Открыть запись"}
            </Button>
            <div id={"customer-visit-" + booking.bookingId} hidden={selectedBookingId !== booking.bookingId}
              class="history-detail" role="group" aria-label="Управление записью">
            {#if selectedBookingId === booking.bookingId}
              <h3>Управление визитом</h3>
              {#if booking.status !== "Confirmed"}
                <p>Запись имеет статус «{statuses[booking.status]}». Отмена и перенос недоступны.</p>
              {:else}
                {#if cutoff === null}
                  <p>Отмена недоступна в текущем контуре.</p>
                {:else if Date.parse(booking.startAt) <= Date.now() + cutoff * 60000}
                  <p>Срок для самостоятельной отмены истёк.</p>
                {/if}
                {#if moveCutoff === null || !booking.timeZone}
                  <p>Самостоятельный перенос недоступен.</p>
                {:else if Date.parse(booking.startAt) <= Date.now() + moveCutoff * 60000}
                  <p>Срок для самостоятельного переноса истёк.</p>
                {/if}
                <p>Перенос меняет только дату и время. Услуга, мастер, филиал и стоимость сохраняются. Если действие недоступно, обратитесь в салон.</p>
              {/if}
            {#if pending?.bookingId === booking.bookingId && !uncertain}
              <p>Отменить эту запись? Время снова станет свободным, если его не занимает другая запись.</p>
              <Button type="button" disabled={cancellationBusy} onclick={() => void confirmCancellation()}>Подтвердить отмену</Button>
              <Button type="button" variant="outline" disabled={cancellationBusy} onclick={() => { pending = null; }}>Оставить запись</Button>
            {:else}
              {#if cutoff !== null && booking.status === "Confirmed" && Date.parse(booking.startAt) > Date.now() + cutoff * 60000}
                <Button type="button" variant="outline" disabled={creationUnresolved || !!pending || cancellationBusy || !!moveBookingId || moveBusy} onclick={() => selectCancellation(booking.bookingId)}>Отменить запись</Button>
              {/if}
              {#if moveCutoff !== null && booking.status === "Confirmed" && booking.timeZone && Date.parse(booking.startAt) > Date.now() + moveCutoff * 60000}
                {#if moveBookingId === booking.bookingId}
                  <label class="field">Дата филиала ({moveTimeZone})
                    <input type="date" value={moveDate} disabled={moveBusy || !!movePending || moveSlotsBusy}
                      onchange={event => { moveDate = event.currentTarget.value; moveGeneration++; moveSlots = null; moveSlotId = ""; moveSlotsBusy = false; moveSlotsError = ""; }} />
                  </label>
                  <Button type="button" variant="outline" disabled={moveBusy || !!movePending || moveSlotsBusy || !moveDate} onclick={() => void loadMoveSlots()}>Показать свободные интервалы</Button>
                  {#if moveSlotsBusy}<p role="status">Проверяем свободное время филиала…</p>{/if}
                  {#if moveSlotsError}<p role="alert" class="alert-error">{moveSlotsError}</p>{/if}
                  {#if moveSlots && !moveSlotsBusy}
                    {#if moveSlots.slots.length === 0}<p>На выбранную дату свободного времени нет. Выберите другую дату.</p>
                    {:else}
                      <label class="field">Доступное время ({moveSlots.timeZone})
                        <select value={moveSlotId} disabled={moveBusy || !!movePending} onchange={event => { moveSlotId = event.currentTarget.value; moveSlotsError = ""; }}>
                          <option value="">Выберите время</option>
                          {#each moveSlots.slots as slot (slot.startAt)}
                            <option value={slot.startAt}>{slotTime(slot.startAt, moveSlots.timeZone)} — {slotTime(slot.endAt, moveSlots.timeZone)}</option>
                          {/each}
                        </select>
                      </label>
                    {/if}
                  {/if}
                  {#if movePending?.bookingId === booking.bookingId}
                    {#if !moveUncertain}
                      <p>Подтвердить перенос на {time(movePending.newStartAt, booking.timeZone)}? Услуга, мастер, филиал и исходная стоимость сохранятся.</p>
                      <Button type="button" disabled={moveBusy || busy} onclick={() => void confirmMove()}>Подтвердить перенос</Button>
                      <Button type="button" variant="outline" disabled={moveBusy} onclick={closeMove}>Отмена</Button>
                    {/if}
                  {:else}
                    <Button type="button" disabled={moveBusy || busy || moveSlotsBusy || !moveSlotId} onclick={prepareMove}>Проверить новое время</Button>
                    <Button type="button" variant="outline" disabled={moveBusy} onclick={closeMove}>Назад</Button>
                  {/if}
                {:else}
                  <Button type="button" variant="outline" disabled={creationUnresolved || !!pending || cancellationBusy || !!moveBookingId || moveBusy} onclick={() => startMove(booking)}>Перенести запись</Button>
                {/if}
              {/if}
            {/if}
            {/if}
            </div>
          </li>
        {/each}
      </ul>
        {/if}
      {#if data.hasMore}<p>Фильтры применяются к 200 последним по дате записям. Для более ранних записей обратитесь в салон.</p>{/if}
      {/if}
    </ThemeScope>
  {/if}
  <p class="owner-form-note">Статусы в списке отображаются на момент последнего обновления с сервера.</p>
  <p class="owner-form-note">{cutoff === null ? "Отмена в тестовом режиме недоступна." : "Отмена проверяется сервером; тестовый срок — до начала записи более чем " + cutoff + " мин."} {moveCutoff === null ? "Перенос в тестовом режиме недоступен." : "Перенос проверяется сервером; отдельный тестовый срок — более " + moveCutoff + " мин. до начала."} Перенос выбирается из предварительно доступных серверных слотов во времени филиала (с UTC-смещением для неоднозначных часов); подтверждение и проверка конфликтов выполняются сервером. Настройки политики владельца пока не подключены. Названия услуг, филиала и мастера — текущие данные каталога.</p>
</section>

<style>
  .history-header-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .history-header-actions :global(button) { min-width: 0; max-width: 100%; white-space: normal; height: auto; }
  .history-filters { display: grid; gap: 6px; margin-bottom: 12px; min-width: 0; }
  .history-filters p { margin: 0; }
  .customer-history { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .customer-history li { border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-width: 0; overflow-wrap: anywhere; display: grid; gap: 5px; }
  .customer-history p { margin: 0; }
  .history-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; justify-content: space-between; }
  .history-heading span, .history-id { font-size: .875rem; }
  .history-detail:not([hidden]) { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--border); min-width: 0; }
  .history-detail h3 { font-size: 1rem; margin: 0; }
  .customer-history :global(button) { min-width: 0; max-width: 100%; height: auto; white-space: normal; overflow-wrap: anywhere; }
</style>
