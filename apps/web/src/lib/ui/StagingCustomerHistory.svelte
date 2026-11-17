<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedCustomerSession } from "../owner-auth";
  import { readOwnBookings, CustomerHistoryError, type OwnBookingHistory, type CustomerBookingStatus } from "../staging-customer-history-api";

  import { cancelOwnBooking, readCancellationCutoff, CancellationError } from "../staging-customer-cancellation-api";

  export let session: VerifiedCustomerSession;
  export let onUnauthorized: () => void;
  let data: OwnBookingHistory | null = null;
  let busy = true;
  let failed = false;
  let mounted = true;
  let generation = 0;
  let cutoff: number | null = null;
  let confirmationId = "";
  let pending: { bookingId: string; key: string } | null = null;
  let sending = false;
  let cancellationMessage = "";
  let cancellationUnknown = false;

  async function initialize(): Promise<void> {
    const value = await readCancellationCutoff(session);
    if (!mounted) return;
    cutoff = value;
    await refresh();
  }

  async function submitCancellation(): Promise<void> {
    if (!confirmationId || sending || pending || cutoff === null) return;
    pending = { bookingId: confirmationId, key: globalThis.crypto.randomUUID() };
    confirmationId = "";
    cancellationUnknown = false;
    await sendCancellation();
  }

  async function sendCancellation(): Promise<void> {
    if (!pending || sending) return;
    const attempt = pending;
    sending = true;
    cancellationMessage = "";
    try {
      await cancelOwnBooking(session, attempt.bookingId, attempt.key);
      if (!mounted) return;
      pending = null;
      cancellationUnknown = false;
      cancellationMessage = "Отмена подтверждена сервером.";
      await refresh();
    } catch (reason) {
      if (!mounted) return;
      if (!cancellationUnknown && reason instanceof CancellationError && reason.reason === "denied") {
        pending = null;
        cancellationMessage = "Срок самостоятельной отмены истёк. Обратитесь в салон.";
        await refresh();
      } else {
        cancellationUnknown = true;
        cancellationMessage = "Результат отмены не подтверждён. Повторите проверку с тем же запросом или обновите записи.";
        if (reason instanceof CancellationError && reason.reason === "unauthorized") onUnauthorized();
      }
    } finally { if (mounted) sending = false; }
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
    busy = true;
    failed = false;
    try {
      const result = await readOwnBookings(session);
      if (!mounted || generation !== version) return;
      if (Date.now() / 1000 >= session.expiresAtUnixSeconds) { onUnauthorized(); return; }
      data = result;
      if (pending && !sending && result.bookings.some(row => row.bookingId === pending?.bookingId && row.status === "CancelledByClient")) {
        pending = null;
        cancellationUnknown = false;
        cancellationMessage = "В списке сервера запись отменена клиентом.";
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
  onMount(() => { void initialize(); return () => { mounted = false; generation++; }; });
</script>

<section class="card" aria-label="Мои записи">
  <div class="card-title">
    <div><span class="eyebrow">STAGING / ЛИЧНЫЙ КАБИНЕТ</span><h2>Мои записи</h2></div>
    <Button type="button" variant="outline" disabled={busy || sending} onclick={() => void refresh()}>Обновить записи</Button>
  </div>
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
            {#if booking.status === "Confirmed" && cutoff !== null && Date.parse(booking.startAt) > Date.now() + cutoff * 60000}
              <Button type="button" variant="outline" disabled={sending || pending !== null || confirmationId !== ""} onclick={() => { confirmationId = booking.bookingId; cancellationMessage = ""; }}>Отменить запись</Button>
            {/if}
            {#if confirmationId === booking.bookingId}
              <p role="status">Отменить эту запись? Освободившееся время может занять другой клиент.</p>
              <div class="history-heading">
                <Button type="button" onclick={() => void submitCancellation()}>Подтвердить отмену</Button>
                <Button type="button" variant="outline" onclick={() => confirmationId = ""}>Оставить запись</Button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if data.hasMore}<p>Показаны 200 последних по дате записей. Для более ранних записей обратитесь в салон.</p>{/if}
    {/if}
  {/if}
  {#if sending}<p role="status">Ожидаем подтверждения отмены…</p>{/if}
  {#if cancellationMessage}<p role="status">{cancellationMessage}</p>{/if}
  {#if pending && !sending}<Button type="button" onclick={() => void sendCancellation()}>Повторить проверку отмены</Button>{/if}
  {#if cutoff !== null}
    <p class="owner-form-note">Самостоятельная отмена доступна до установленного сервером срока ({cutoff} мин. до визита). После срока обратитесь в салон.</p>
  {:else}<p class="owner-form-note">Самостоятельная отмена недоступна.</p>{/if}
  <p class="owner-form-note">Перенос пока недоступен. Названия услуг, филиала и мастера — текущие данные каталога.</p>
</section>

<style>
  .customer-history { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .customer-history li { border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-width: 0; overflow-wrap: anywhere; display: grid; gap: 5px; }
  .customer-history p { margin: 0; }
  .history-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; justify-content: space-between; }
  .history-heading span, .history-id { font-size: .875rem; }
</style>
