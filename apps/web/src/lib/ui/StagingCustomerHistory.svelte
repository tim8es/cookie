<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedCustomerSession } from "../owner-auth";
  import { readOwnBookings, CustomerHistoryError, type OwnBookingHistory, type CustomerBookingStatus } from "../staging-customer-history-api";

  export let session: VerifiedCustomerSession;
  export let onUnauthorized: () => void;
  let data: OwnBookingHistory | null = null;
  let busy = true;
  let failed = false;
  let mounted = true;
  let generation = 0;
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
      data = result;
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
    <Button type="button" variant="outline" disabled={busy} onclick={() => void refresh()}>Обновить записи</Button>
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
          </li>
        {/each}
      </ul>
      {#if data.hasMore}<p>Показаны 200 последних по дате записей. Для более ранних записей обратитесь в салон.</p>{/if}
    {/if}
  {/if}
  <p class="owner-form-note">Отмена и перенос пока недоступны. Названия услуг, филиала и мастера — текущие данные каталога.</p>
</section>

<style>
  .customer-history { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .customer-history li { border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-width: 0; overflow-wrap: anywhere; display: grid; gap: 5px; }
  .customer-history p { margin: 0; }
  .history-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; justify-content: space-between; }
  .history-heading span, .history-id { font-size: .875rem; }
</style>
