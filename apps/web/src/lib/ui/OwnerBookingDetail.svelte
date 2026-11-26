<script lang="ts">
  import { onDestroy } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { BookingDetailReadError, readOwnerBookingDetail, type OwnerBookingDetail, type CalendarStatus } from "../owner-calendar-api";
  import { cancelOwnerCalendarBooking, readStagingOwnerCancellationCutoff, OwnerCancellationError } from "../staging-owner-calendar-cancellation-api";

  export let session: VerifiedOwnerSession;
  export let fetcher: typeof fetch;
  export let locationId: string;
  export let bookingId: string;
  export let disabled = false;
  export let onChanged: () => void = () => {};

  let open = false;
  let request: AbortController | null = null;
  let detail: OwnerBookingDetail | null = null;
  let error = "";
  let cancelCutoff: number | null = null;
  let cancelPending: { key: string } | null = null;
  let cancelBusy = false;
  let cancelUncertain = false;
  let cancelMessage = "";
  let mounted = true;
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
    cancelCutoff = null;
    cancelPending = null;
    cancelUncertain = false;
    cancelMessage = "";
    open = false;
  }

  $: if (disabled) close();
  onDestroy(() => { mounted = false; close(); });

  async function load(): Promise<void> {
    if (disabled) return;
    close();
    open = true;
    const current = new AbortController();
    request = current;
    try {
      const result = await readOwnerBookingDetail(session, locationId, bookingId, fetcher, current.signal);
      if (request === current && !current.signal.aborted && !disabled) {
        detail = result;
        cancelCutoff = await readStagingOwnerCancellationCutoff(session, fetcher);
      }
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

  function startCancellation(): void {
    if (!detail || detail.status !== "Confirmed" || cancelCutoff === null ||
        cancelBusy || cancelPending || disabled ||
        Date.parse(detail.startAt) <= Date.now() + cancelCutoff * 60000) return;
    cancelPending = { key: globalThis.crypto.randomUUID() };
    cancelUncertain = false;
    cancelMessage = "";
  }

  async function confirmCancellation(): Promise<void> {
    if (!cancelPending || cancelBusy || !detail || disabled) return;
    const attempt = cancelPending;
    const previouslyUncertain = cancelUncertain;
    cancelBusy = true;
    cancelMessage = "";
    try {
      await cancelOwnerCalendarBooking(
        session, locationId, bookingId, attempt.key, fetcher,
      );
      if (!mounted || !open) return;
      cancelPending = null;
      cancelUncertain = false;
      cancelMessage = "Отмена подтверждена сервером.";
      onChanged();
    } catch (reason) {
      if (!mounted || !open) return;
      if (previouslyUncertain) {
        // A rejected retry cannot establish whether the original write committed.
        cancelUncertain = true;
        cancelMessage = "Результат исходной отмены неизвестен. Повторите исходный запрос с тем же ключом; не создавайте новую операцию.";
      } else if (reason instanceof OwnerCancellationError && reason.reason === "conflict") {
        cancelPending = null;
        cancelUncertain = false;
        cancelMessage = "Отмена не выполнена. Статус записи или тестовый срок изменился.";
        onChanged();
      } else if (reason instanceof OwnerCancellationError && reason.reason === "denied") {
        cancelPending = null;
        cancelUncertain = false;
        cancelMessage = "Нет прав на отмену или сеанс завершён.";
      } else {
        cancelUncertain = true;
        cancelMessage = "Результат отмены неизвестен. Повторите исходный запрос с тем же ключом; не создавайте новую операцию.";
      }
    } finally {
      if (mounted) cancelBusy = false;
    }
  }

  function format(value: string, zone: string): string {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: zone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  }
</script>

<div class="owner-booking-detail" data-booking-id={bookingId}>
  <Button type="button" variant="outline" aria-expanded={open} onclick={() => open ? close() : void load()} disabled={disabled || cancelBusy || cancelUncertain}>
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
        {#if cancelMessage}<p role={cancelUncertain ? "alert" : "status"}>{cancelMessage}</p>{/if}
        {#if cancelPending}
          {#if !cancelUncertain}
            <p>Отменить подтверждённую запись для клиента? Это освободит время. Операция требует подтверждения сервера.</p>
          {/if}
          <Button type="button" disabled={cancelBusy || disabled} onclick={() => void confirmCancellation()}>
            {cancelUncertain ? "Повторить исходную отмену" : "Подтвердить отмену"}
          </Button>
          {#if !cancelUncertain}
            <Button type="button" variant="outline" disabled={cancelBusy} onclick={() => { cancelPending = null; }}>Оставить запись</Button>
          {/if}
        {:else if detail.status === "Confirmed" && cancelCutoff !== null &&
          Date.parse(detail.startAt) > Date.now() + cancelCutoff * 60000}
          <Button type="button" variant="outline" disabled={disabled} onclick={startCancellation}>Отменить запись</Button>
        {/if}
        <p class="owner-form-note">{cancelCutoff === null
          ? "Отмена из календаря недоступна в этом контуре."
          : "Тестовый срок отмены: более " + cancelCutoff + " мин. до начала. Сервер проверяет его при выполнении."}
          Перенос из календаря пока недоступен. Данные сохранённой записи.</p>
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
