<script lang="ts">
  import { onDestroy } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { BookingDetailReadError, readOwnerBookingDetail, type OwnerBookingDetail, type CalendarStatus } from "../owner-calendar-api";

  export let session: VerifiedOwnerSession;
  export let locationId: string;
  export let bookingId: string;
  export let disabled = false;

  let open = false;
  let request: AbortController | null = null;
  let detail: OwnerBookingDetail | null = null;
  let error = "";
  const statusNames: Record<CalendarStatus, string> = {
    Confirmed: "Подтверждена",
    CancelledByClient: "Отменена клиентом",
    CancelledByBusiness: "Отменена салоном",
    Completed: "Завершена",
    NoShow: "Неявка",
  };
  const price = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });

  function close(): void {
    request?.abort();
    request = null;
    detail = null;
    error = "";
    open = false;
  }

  $: if (disabled) close();
  onDestroy(close);

  async function load(): Promise<void> {
    if (disabled) return;
    close();
    open = true;
    const current = new AbortController();
    request = current;
    try {
      const result = await readOwnerBookingDetail(session, locationId, bookingId, globalThis.fetch, current.signal);
      if (request === current && !current.signal.aborted && !disabled) detail = result;
    } catch (reason) {
      if (request !== current || current.signal.aborted) return;
      error = reason instanceof BookingDetailReadError && reason.reason === "unauthorized"
        ? "Сеанс завершился или права отозваны."
        : reason instanceof BookingDetailReadError && reason.reason === "not-found"
          ? "Запись недоступна в этом филиале."
          : "Не удалось загрузить детали записи.";
    } finally {
      if (request === current) request = null;
    }
  }

  function format(value: string, zone: string): string {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: zone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  }
</script>

<div class="owner-booking-detail" data-booking-id={bookingId}>
  <Button type="button" variant="outline" aria-expanded={open} onclick={() => open ? close() : void load()} {disabled}>
    {open ? "Скрыть детали" : "Подробнее"}
  </Button>
  {#if open}
    {#if request}
      <p role="status">Загружаем детали записи…</p>
    {:else if error}
      <p role="alert">{error}</p>
      <Button type="button" variant="outline" onclick={() => void load()} {disabled}>Повторить</Button>
    {:else if detail}
      <div aria-label="Детали записи">
        <dl>
          <dt>Номер записи</dt><dd>{detail.id}</dd>
          <dt>Статус</dt><dd>{statusNames[detail.status]}</dd>
          <dt>Услуга</dt><dd>{detail.serviceName}</dd>
          <dt>Мастер</dt><dd>{detail.staffName}</dd>
          <dt>Начало</dt><dd>{format(detail.startAt, detail.timeZone)}</dd>
          <dt>Окончание услуги</dt><dd>{format(detail.endAt, detail.timeZone)}</dd>
          <dt>Длительность</dt><dd>{detail.durationMinutes} мин</dd>
          <dt>Буфер после услуги</dt><dd>{detail.bufferMinutes} мин</dd>
          <dt>Сохранённое окончание интервала с буфером</dt><dd>{format(detail.occupiedUntil, detail.timeZone)}</dd>
          <dt>Стоимость записи</dt><dd>{price.format(Number(detail.priceKopecks) / 100)}</dd>
          {#if detail.cancelledAt}<dt>Отменена</dt><dd>{format(detail.cancelledAt, detail.timeZone)}</dd>{/if}
        </dl>
        <p class="owner-form-note">Данные сохранённой записи. Отмена и перенос пока недоступны.</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .owner-booking-detail { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  dl { display: grid; gap: 4px; margin: 12px 0; }
  dt { font-weight: 600; }
  dd { margin: 0 0 8px; }
</style>
