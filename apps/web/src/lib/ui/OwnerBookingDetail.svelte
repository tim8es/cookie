<script module lang="ts">
  // Share the formatter across up to 500 mounted calendar detail controls.
  const price = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { BookingDetailReadError, readOwnerBookingDetail, type OwnerBookingDetail, type CalendarStatus } from "../owner-calendar-api";
  import { cancelOwnerCalendarBooking, readStagingOwnerCancellationCutoff, OwnerCancellationError } from "../staging-owner-calendar-cancellation-api";
  import { readStagingOwnerRescheduleCutoff, readOwnerRescheduleSlots, rescheduleOwnerCalendarBooking, OwnerRescheduleError, type OwnerRescheduleSlots } from "../staging-owner-calendar-reschedule-api";

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
  let moveCutoff: number | null = null;
  let moveOpen = false;
  let moveDate = "";
  let moveSlots: OwnerRescheduleSlots | null = null;
  let moveSlotId = "";
  let moveSlotsBusy = false;
  let moveSlotsError = "";
  let moveGeneration = 0;
  let movePending: { newStartAt: string; key: string } | null = null;
  let moveBusy = false;
  let moveUncertain = false;
  let moveMessage = "";
  let mounted = true;
  const statusNames: Record<CalendarStatus, string> = {
    Confirmed: "Подтверждена",
    CancelledByClient: "Отменена клиентом",
    CancelledByBusiness: "Отменена салоном",
    Completed: "Завершена",
    NoShow: "Неявка",
  };

  function close(): void {
    request?.abort();
    request = null;
    detail = null;
    error = "";
    cancelCutoff = null;
    cancelPending = null;
    cancelUncertain = false;
    cancelMessage = "";
    moveGeneration++;
    moveCutoff = null;
    moveOpen = false;
    moveDate = "";
    moveSlots = null;
    moveSlotId = "";
    moveSlotsBusy = false;
    moveSlotsError = "";
    movePending = null;
    moveUncertain = false;
    moveMessage = "";
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
        const [cancelPolicy, movePolicy] = await Promise.all([
          readStagingOwnerCancellationCutoff(session, fetcher),
          readStagingOwnerRescheduleCutoff(session, fetcher),
        ]);
        if (request === current && !current.signal.aborted && mounted && !disabled) {
          detail = result;
          cancelCutoff = cancelPolicy;
          moveCutoff = movePolicy;
        }
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
    moveOpen = false;
    movePending = null;
    moveSlots = null;
    moveSlotId = "";
    moveSlotsBusy = false;
    moveSlotsError = "";
    moveMessage = "";
  }

  async function loadMoveSlots(): Promise<void> {
    if (!detail || !moveOpen || !moveDate || movePending || moveBusy || disabled) return;
    const version = ++moveGeneration;
    const date = moveDate;
    moveSlotsBusy = true;
    moveSlots = null;
    moveSlotId = "";
    moveSlotsError = "";
    try {
      const slots = await readOwnerRescheduleSlots(
        session, locationId, bookingId, date, detail.timeZone, fetcher,
      );
      if (!mounted || version !== moveGeneration || !moveOpen) return;
      moveSlots = slots;
    } catch (reason) {
      if (!mounted || version !== moveGeneration || !moveOpen) return;
      moveSlotsError = reason instanceof OwnerRescheduleError && reason.reason === "denied"
        ? "Нет прав на перенос или сеанс завершён."
        : reason instanceof OwnerRescheduleError && reason.reason === "conflict"
          ? "Запись или расписание уже изменились. Обновите календарь."
          : "Не удалось загрузить свободное время. Повторите запрос.";
    } finally {
      if (mounted && version === moveGeneration) moveSlotsBusy = false;
    }
  }

  function startMove(): void {
    if (!detail || detail.status !== "Confirmed" || moveCutoff === null ||
        disabled || cancelBusy || cancelPending || moveBusy || movePending ||
        Date.parse(detail.startAt) <= Date.now() + moveCutoff * 60000) return;
    moveOpen = true;
    moveDate = branchDate(detail.startAt, detail.timeZone);
    moveMessage = "";
    void loadMoveSlots();
  }

  function prepareMove(): void {
    if (!detail || !moveOpen || moveBusy || moveSlotsBusy || movePending) return;
    const selected = moveSlots?.slots.find((slot) => slot.startAt === moveSlotId);
    if (!selected || selected.startAt === detail.startAt) {
      moveSlotsError = "Выберите доступное время из списка сервера.";
      return;
    }
    movePending = { newStartAt: selected.startAt, key: globalThis.crypto.randomUUID() };
    moveUncertain = false;
    moveMessage = "";
  }

  async function confirmMove(): Promise<void> {
    if (!movePending || moveBusy || disabled || !detail) return;
    const attempt = movePending;
    const previouslyUncertain = moveUncertain;
    moveBusy = true;
    moveMessage = "";
    try {
      const receipt = await rescheduleOwnerCalendarBooking(
        session, locationId, bookingId, attempt.newStartAt, attempt.key, fetcher,
      );
      if (!mounted || !open) return;
      if (receipt.priceKopecks !== detail.priceKopecks) {
        // A response with a changed monetary snapshot is never UI success.
        moveUncertain = true;
        moveMessage = "Ответ сервера о переносе не соответствует исходной стоимости. Проверьте запись.";
        return;
      }
      movePending = null;
      moveUncertain = false;
      moveMessage = "Перенос подтверждён сервером.";
      onChanged();
    } catch (reason) {
      if (!mounted || !open) return;
      if (previouslyUncertain) {
        // A rejection of this retry cannot disprove the original COMMIT.
        moveUncertain = true;
        moveMessage = "Результат исходного переноса неизвестен. Проверьте запись или повторите исходный запрос с тем же ключом.";
      } else if (reason instanceof OwnerRescheduleError && reason.reason === "denied") {
        movePending = null;
        moveUncertain = false;
        moveMessage = "Нет прав на перенос или сеанс завершён.";
      } else if (reason instanceof OwnerRescheduleError && reason.reason === "conflict") {
        movePending = null;
        moveUncertain = false;
        moveMessage = "Перенос не выполнен. Запись или свободный интервал изменились.";
        onChanged();
      } else {
        moveUncertain = true;
        moveMessage = "Результат переноса неизвестен. Повторите исходный запрос с тем же ключом.";
      }
    } finally {
      if (mounted) moveBusy = false;
    }
  }

  function startCancellation(): void {
    if (!detail || detail.status !== "Confirmed" || cancelCutoff === null ||
        cancelBusy || cancelPending || moveOpen || moveBusy || disabled ||
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
        // A rejected retry does not establish whether the earlier cancellation
        // committed. Keep its original key and require positive confirmation.
        cancelUncertain = true;
        cancelMessage = "Результат исходной отмены неизвестен. Проверьте запись или повторите исходный запрос с тем же ключом.";
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
  <Button type="button" variant="outline" aria-expanded={open} onclick={() => open ? close() : void load()} disabled={disabled || cancelBusy || cancelUncertain || moveBusy || moveUncertain}>
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
        {#if moveMessage}<p role={moveUncertain ? "alert" : "status"}>{moveMessage}</p>{/if}
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
        {:else if !moveOpen && detail.status === "Confirmed" && cancelCutoff !== null &&
          Date.parse(detail.startAt) > Date.now() + cancelCutoff * 60000}
          <Button type="button" variant="outline" disabled={disabled} onclick={startCancellation}>Отменить запись</Button>
        {/if}
        {#if moveOpen && detail.status === "Confirmed"}
          <div class="owner-calendar-move" aria-label="Перенос записи владельцем">
            <label class="field">Дата филиала ({detail.timeZone})
              <input type="date" value={moveDate} disabled={moveBusy || moveSlotsBusy || !!movePending}
                onchange={(event) => {
                  moveDate = event.currentTarget.value;
                  moveGeneration++;
                  moveSlots = null;
                  moveSlotId = "";
                  moveSlotsBusy = false;
                  moveSlotsError = "";
                }} />
            </label>
            <Button type="button" variant="outline" onclick={() => void loadMoveSlots()}
              disabled={moveBusy || moveSlotsBusy || !!movePending || !moveDate}>
              Показать свободное время
            </Button>
            {#if moveSlotsBusy}<p role="status">Проверяем интервалы филиала…</p>{/if}
            {#if moveSlotsError}<p role="alert">{moveSlotsError}</p>{/if}
            {#if moveSlots && !moveSlotsBusy}
              {#if moveSlots.slots.length === 0}
                <p>На выбранную дату нет свободного времени. Выберите другую дату.</p>
              {:else}
                <label class="field">Свободное время ({moveSlots.timeZone})
                  <select value={moveSlotId} disabled={moveBusy || !!movePending}
                    onchange={(event) => { moveSlotId = event.currentTarget.value; moveSlotsError = ""; }}>
                    <option value="">Выберите время</option>
                    {#each moveSlots.slots as slot (slot.startAt)}
                      <option value={slot.startAt}>{slotTime(slot.startAt, moveSlots.timeZone)} — {slotTime(slot.endAt, moveSlots.timeZone)}</option>
                    {/each}
                  </select>
                </label>
              {/if}
            {/if}
            {#if movePending}
              <p>Подтвердить перенос на {format(movePending.newStartAt, detail.timeZone)}? Услуга, мастер, филиал и исходная стоимость сохранятся.</p>
              <Button type="button" disabled={moveBusy || disabled} onclick={() => void confirmMove()}>
                {moveUncertain ? "Повторить исходный перенос" : "Подтвердить перенос"}
              </Button>
              {#if !moveUncertain}
                <Button type="button" variant="outline" disabled={moveBusy} onclick={closeMove}>Оставить время</Button>
              {/if}
            {:else}
              <Button type="button" disabled={moveBusy || moveSlotsBusy || !moveSlotId}
                onclick={prepareMove}>Проверить новое время</Button>
              <Button type="button" variant="outline" disabled={moveBusy} onclick={closeMove}>Назад</Button>
            {/if}
            <p class="owner-form-note">Слоты предварительные: сервер заново проверяет свободное время при подтверждении.</p>
          </div>
        {:else if !cancelPending && detail.status === "Confirmed" && moveCutoff !== null &&
          Date.parse(detail.startAt) > Date.now() + moveCutoff * 60000}
          <Button type="button" variant="outline" disabled={disabled || cancelBusy} onclick={startMove}>Перенести время</Button>
        {/if}
        <p class="owner-form-note">{cancelCutoff === null
          ? "Отмена из календаря недоступна в этом контуре."
          : "Тестовый срок отмены: более " + cancelCutoff + " мин. до начала."}
          {moveCutoff === null
            ? "Перенос из календаря недоступен в этом контуре."
            : "Тестовый срок переноса: более " + moveCutoff + " мин. до начала."}
          Сервер проверяет ограничения при выполнении. Правила салона #285 пока не подключены.</p>
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
