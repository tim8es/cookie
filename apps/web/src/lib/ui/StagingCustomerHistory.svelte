<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { cancelOwnBooking, readCancellationCutoff, CancellationError } from "../staging-customer-cancellation-api";
  import { rescheduleOwnBooking, readRescheduleCutoff, CustomerRescheduleError } from "../staging-customer-reschedule-api";
  import type { VerifiedCustomerSession } from "../owner-auth";
  import { readOwnBookings, CustomerHistoryError, type OwnBookingHistory, type CustomerBookingStatus } from "../staging-customer-history-api";

  export let session: VerifiedCustomerSession;
  export let onUnauthorized: () => void;
  export let onHistory: (value: OwnBookingHistory | null) => void = () => {};
  let data: OwnBookingHistory | null = null;
  let busy = true;
  let failed = false;
  let mounted = true;
  let generation = 0;
  let cutoff: number | null = null;
  let moveCutoff: number | null = null;
  let moveBookingId: string | null = null;
  let moveUtc = "";
  let movePending: { bookingId: string; key: string; newStartAt: string } | null = null;
  let moveBusy = false;
  let moveUncertain = false;
  let pending: { bookingId: string; key: string } | null = null;
  let cancellationBusy = false;
  let uncertain = false;
  let message = "";
  function utcMinute(value: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
    const instant = value + ":00.000Z";
    return Number.isFinite(Date.parse(instant)) && new Date(instant).toISOString() === instant ? instant : null;
  }
  function startMove(bookingId: string): void {
    if (busy || moveBusy || cancellationBusy || pending || movePending || moveCutoff === null) return;
    moveBookingId = bookingId; moveUtc = ""; message = "";
  }
  function prepareMove(): void {
    if (!moveBookingId || moveBusy || busy || pending) return;
    const newStartAt = utcMinute(moveUtc);
    if (!newStartAt) { message = "Укажите корректные дату и время в UTC."; return; }
    movePending = { bookingId: moveBookingId, newStartAt, key: globalThis.crypto.randomUUID() };
    moveUncertain = false;
    message = "";
  }
  async function confirmMove(): Promise<void> {
    if (!movePending || moveBusy || busy) return;
    const attempt = movePending;
    moveBusy = true; onHistory(null); message = "";
    try {
      const receipt = await rescheduleOwnBooking(session, attempt.bookingId, attempt.newStartAt, attempt.key);
      if (!mounted) return;
      movePending = null; moveBookingId = null; moveUncertain = false;
      message = "Перенос подтверждён сервером. Время записи: " + time(receipt.startAt, "UTC");
      await refresh();
    } catch (reason) {
      if (!mounted) return;
      if (reason instanceof CustomerRescheduleError && reason.reason === "conflict") {
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
    if (pending || cancellationBusy || busy || cutoff === null || moveBusy || movePending || moveBookingId) return;
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
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: zone ?? "UTC", year: "numeric", month: "short",
      day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset",
    }).format(new Date(value));
  }
  function price(value: string): string {
    const amount = BigInt(value);
    return new Intl.NumberFormat("ru-RU").format(amount / 100n) + "," + String(amount % 100n).padStart(2, "0") + " ₽";
  }
  onMount(() => { void refresh(); return () => { mounted = false; generation++; }; });
</script>

<section class="card" aria-label="Мои записи">
  <div class="card-title">
    <div><span class="eyebrow">STAGING / ЛИЧНЫЙ КАБИНЕТ</span><h2>Мои записи</h2></div>
    <Button type="button" variant="outline" disabled={busy || cancellationBusy || moveBusy} onclick={() => void refresh()}>Обновить записи</Button>
  </div>
  {#if message}<p role="status">{message}</p>{/if}
  {#if uncertain && pending}<Button type="button" disabled={cancellationBusy || busy} onclick={() => void confirmCancellation()}>Повторить запрос отмены</Button>{/if}
  {#if moveUncertain && movePending}<Button type="button" disabled={moveBusy || busy} onclick={() => void confirmMove()}>Повторить исходный перенос</Button>{/if}
  {#if busy}<p role="status">Загружаем ваши записи…</p>
  {:else if failed}<p role="alert" class="alert-error">Не удалось получить ваши записи. Обновите список или проверьте доступ.</p>
  {:else if data}
    {#if data.bookings.length === 0}<p>У вас пока нет записей.</p>
    {:else}
      <ul class="customer-history">
        {#each data.bookings as booking (booking.bookingId)}
          <li>
            <div class="history-heading"><strong>{booking.serviceName}</strong><span>{statuses[booking.status]}</span></div>
            <p>{booking.staffName} · {booking.locationName}</p>
            <p><time datetime={booking.startAt}>{time(booking.startAt, booking.timeZone)}</time> — <time datetime={booking.endAt}>{time(booking.endAt, booking.timeZone)}</time></p>
            {#if !booking.timeZone}<p>Часовой пояс филиала не задан; показано UTC.</p>{/if}
            <p>Стоимость записи: {price(booking.priceKopecks)}</p>
            <p class="history-id">Номер: {booking.bookingId}</p>
            {#if pending?.bookingId === booking.bookingId && !uncertain}
              <p>Отменить эту запись? Время снова станет свободным, если его не занимает другая запись.</p>
              <Button type="button" disabled={cancellationBusy} onclick={() => void confirmCancellation()}>Подтвердить отмену</Button>
              <Button type="button" variant="outline" disabled={cancellationBusy} onclick={() => { pending = null; }}>Оставить запись</Button>
            {:else}
              {#if cutoff !== null && booking.status === "Confirmed" && Date.parse(booking.startAt) > Date.now() + cutoff * 60000}
                <Button type="button" variant="outline" disabled={!!pending || cancellationBusy || !!moveBookingId || moveBusy} onclick={() => selectCancellation(booking.bookingId)}>Отменить запись</Button>
              {/if}
              {#if moveCutoff !== null && booking.status === "Confirmed" && Date.parse(booking.startAt) > Date.now() + moveCutoff * 60000}
                {#if moveBookingId === booking.bookingId}
                  <label>Новое время в UTC (только тестовый контур)
                    <input type="datetime-local" step="60" bind:value={moveUtc} disabled={moveBusy || !!movePending} />
                  </label>
                  {#if movePending?.bookingId === booking.bookingId}
                    <p>Подтвердить перенос только времени на {movePending.newStartAt}? Услуга, мастер, филиал и стоимость сохранятся.</p>
                    <Button type="button" disabled={moveBusy || busy} onclick={() => void confirmMove()}>Подтвердить перенос</Button>
                    {#if !moveUncertain}<Button type="button" variant="outline" disabled={moveBusy} onclick={() => { moveBookingId = null; movePending = null; }}>Отмена</Button>{/if}
                  {:else}
                    <Button type="button" disabled={moveBusy || busy} onclick={prepareMove}>Проверить новое время</Button>
                    <Button type="button" variant="outline" disabled={moveBusy} onclick={() => { moveBookingId = null; moveUtc = ""; }}>Назад</Button>
                  {/if}
                {:else}
                  <Button type="button" variant="outline" disabled={!!pending || cancellationBusy || !!moveBookingId || moveBusy} onclick={() => startMove(booking.bookingId)}>Перенести запись</Button>
                {/if}
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
      {#if data.hasMore}<p>Показаны 200 последних по дате записей. Для более ранних записей обратитесь в салон.</p>{/if}
    {/if}
  {/if}
  <p class="owner-form-note">Статусы в списке отображаются на момент последнего обновления с сервера.</p>
  <p class="owner-form-note">{cutoff === null ? "Отмена в тестовом режиме недоступна." : "Отмена проверяется сервером; тестовый срок — до начала записи более чем " + cutoff + " мин."} {moveCutoff === null ? "Перенос в тестовом режиме недоступен." : "Перенос проверяется сервером; отдельный тестовый срок — более " + moveCutoff + " мин. до начала."} Ввод времени переноса здесь строго UTC; для обычного клиентского интерфейса потребуется выбор слота в часовом поясе филиала. Названия услуг, филиала и мастера — текущие данные каталога.</p>
</section>

<style>
  .customer-history { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .customer-history li { border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-width: 0; overflow-wrap: anywhere; display: grid; gap: 5px; }
  .customer-history p { margin: 0; }
  .history-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; justify-content: space-between; }
  .history-heading span, .history-id { font-size: .875rem; }
</style>
