<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import { canCreateCustomerBooking, customerBookingAttempt, type CustomerBookingSelection } from "../staging-customer-booking-api";
  import type { BookingAttempt, BookingAttemptState } from "../booking-attempt";
  import type { ConfirmedBookingReceipt } from "../confirmed-booking-receipt";
  import type { CustomerSlot } from "../staging-customer-offers-api";
  import type { VerifiedCustomerSession } from "../owner-auth";
  import { readCustomerOffers, readCustomerSlots, CustomerOffersError, type CustomerOffer, type CustomerSlots } from "../staging-customer-offers-api";
  export let session: VerifiedCustomerSession;
  export let onUnauthorized: () => void;
  let offers: CustomerOffer[] = [];
  let locationId = "";
  let serviceId = "";
  let staffId = "";
  let date = "";
  let slots: CustomerSlots | null = null;
  let slotId = "";
  let busy = true;
  let error = "";
  let loaded = false;
  let generation = 0;
  let mounted = true;
  let bookingEnabled = false;
  let blocked = false;
  let storageKey = "";
  let attempt: BookingAttempt<CustomerBookingSelection, ConfirmedBookingReceipt, CustomerSlot> | null = null;
  let bookingState: BookingAttemptState<ConfirmedBookingReceipt, CustomerSlot> = { phase: "idle" };
  let locked = false;
  $: locked = blocked || bookingState.phase === "submitting" || bookingState.phase === "error" || bookingState.phase === "confirmed";
  async function initialize(): Promise<void> {
    bookingEnabled = await canCreateCustomerBooking(session);
    if (!mounted) return;
    if (bookingEnabled) {
      storageKey = "cookie.staging.pending." + session.tenantId + "." + session.customerId;
      try { blocked = sessionStorage.getItem(storageKey) !== null; }
      catch { blocked = true; }
    }
    await refresh();
  }
  function clearPending(): void {
    try { sessionStorage.removeItem(storageKey); }
    catch { blocked = true; }
  }
  async function submitBooking(): Promise<void> {
    if (!bookingEnabled || blocked || locked || busy || !selected || !chosen) return;
    const key = globalThis.crypto.randomUUID();
    try {
      // Non-secret marker only. No token, proof, price or selection is stored.
      if (sessionStorage.getItem(storageKey) !== null) { blocked = true; return; }
      sessionStorage.setItem(storageKey, key);
    } catch { blocked = true; return; }
    const selection = { offer: selected, localDate: date, startAt: chosen.startAt };
    attempt = customerBookingAttempt(session, key);
    bookingState = { phase: "submitting" };
    applyResult(await attempt.submit(selection));
  }
  async function retryBooking(): Promise<void> {
    if (!attempt || bookingState.phase !== "error" || !bookingState.retryable) return;
    bookingState = { phase: "submitting" };
    applyResult(await attempt.retry());
  }
  function applyResult(result: BookingAttemptState<ConfirmedBookingReceipt, CustomerSlot>): void {
    if (!mounted) return;
    bookingState = result;
    if (result.phase === "confirmed") {
      clearPending();
      slots = null; slotId = "";
    } else if (result.phase === "conflict") {
      clearPending();
      slots = result.refreshFailed || !slots ? null : { ...slots, slots: [...result.slots] };
      slotId = "";
      error = result.refreshFailed ? "Время недоступно. Не удалось обновить слоты." : "Время недоступно. Выберите другой свободный интервал.";
      attempt = null; bookingState = { phase: "idle" };
    } else if (result.phase === "denied") {
      clearPending();
      onUnauthorized();
    }
  }
  function receiptPrice(value: string): string {
    const amount = BigInt(value);
    return new Intl.NumberFormat("ru-RU").format(amount / 100n) + "," + String(amount % 100n).padStart(2, "0") + " ₽";
  }
  function newSelection(): void {
    if (blocked || bookingState.phase !== "confirmed") return;
    attempt = null; bookingState = { phase: "idle" };
    void refresh();
  }
  function unique(items: CustomerOffer[], key: "locationId" | "serviceId" | "staffId") {
    return [...new Map(items.map(item => [item[key], item])).values()];
  }
  $: locations = unique(offers, "locationId");
  $: services = unique(offers.filter(o => o.locationId === locationId), "serviceId");
  $: staff = unique(offers.filter(o => o.locationId === locationId && o.serviceId === serviceId), "staffId");
  $: selected = offers.find(o => o.locationId === locationId && o.serviceId === serviceId && o.staffId === staffId);
  $: chosen = slots?.slots.find(s => s.startAt === slotId);
  function resetSlots(): void { slots = null; slotId = ""; error = ""; generation++; busy = false; }
  function failed(reason: unknown): void {
    if (reason instanceof CustomerOffersError && reason.reason === "unauthorized") {
      offers = []; slots = null; slotId = ""; onUnauthorized(); return;
    }
    error = reason instanceof CustomerOffersError && reason.reason === "target-unavailable"
      ? "Назначение больше недоступно. Обновите каталог." : "Не удалось получить подтверждённые данные. Повторите запрос.";
  }
  async function refresh(): Promise<void> {
    const version = ++generation;
    busy = true; loaded = false; offers = []; locationId = ""; serviceId = ""; staffId = ""; date = ""; slots = null; slotId = ""; error = "";
    try {
      const result = await readCustomerOffers(session);
      if (!mounted || version !== generation) return;
      offers = result; loaded = true;
    } catch (reason) { if (mounted && version === generation) failed(reason); }
    finally { if (mounted && version === generation) busy = false; }
  }
  async function check(): Promise<void> {
    if (!selected || !date || busy || locked) return;
    const version = ++generation;
    const selection = selected; const day = date;
    slots = null; slotId = ""; error = ""; busy = true;
    try {
      const result = await readCustomerSlots(session, selection, day);
      if (!mounted || version !== generation) return;
      slots = result;
    } catch (reason) { if (mounted && version === generation) failed(reason); }
    finally { if (mounted && version === generation) busy = false; }
  }
  function price(value: string): string {
    return new Intl.NumberFormat("ru-RU", {style:"currency",currency:"RUB",maximumFractionDigits:2,minimumFractionDigits:0}).format(Number(value)/100);
  }
  function format(value: string, zone: string): string {
    return new Intl.DateTimeFormat("ru-RU", {timeZone:zone,hour:"2-digit",minute:"2-digit",timeZoneName:"shortOffset"}).format(new Date(value));
  }
  onMount(() => { void initialize(); return () => { mounted = false; generation++; }; });
</script>

<section class="card" aria-label="Клиентская витрина staging">
  <div class="card-title">
    <div><span class="eyebrow">STAGING / ОНЛАЙН-ЗАПИСЬ</span><h2>Выберите услугу и время</h2></div>
    <Button type="button" variant="outline" disabled={busy || locked} onclick={() => void refresh()}>Обновить каталог</Button>
  </div>
  {#if error}<p role="alert" class="alert-error">{error}</p>{/if}
  {#if busy && !loaded}<p role="status">Загружаем опубликованные услуги…</p>
  {:else if loaded && offers.length === 0}<p>Сейчас нет доступных опубликованных услуг.</p>
  {:else if loaded}
    <div class="owner-form">
      <label class="field">Филиал
        <select value={locationId} disabled={busy || locked} onchange={event => { locationId = event.currentTarget.value; serviceId = ""; staffId = ""; date = ""; resetSlots(); }}>
          <option value="">Выберите филиал</option>
          {#each locations as item (item.locationId)}<option value={item.locationId}>{item.locationName}</option>{/each}
        </select>
      </label>
      <label class="field">Услуга
        <select value={serviceId} disabled={!locationId || busy || locked} onchange={event => { serviceId = event.currentTarget.value; staffId = ""; date = ""; resetSlots(); }}>
          <option value="">Выберите услугу</option>
          {#each services as item (item.serviceId)}<option value={item.serviceId}>{item.serviceName}</option>{/each}
        </select>
      </label>
      <label class="field">Мастер
        <select value={staffId} disabled={!serviceId || busy || locked} onchange={event => { staffId = event.currentTarget.value; date = ""; resetSlots(); }}>
          <option value="">Выберите мастера</option>
          {#each staff as item (item.staffId)}<option value={item.staffId}>{item.staffName}</option>{/each}
        </select>
      </label>
      {#if selected}
        <p><strong>{price(selected.basePriceKopecks)}</strong> · {selected.durationMinutes} мин.</p>
        <p class="owner-form-note">Базовая цена каталога, не подтверждённая стоимость записи.</p>
      {/if}
      <label class="field">Дата филиала
        <Input type="date" value={date} disabled={!selected || busy || locked} onchange={event => { date = event.currentTarget.value; resetSlots(); }} />
      </label>
      <Button type="button" disabled={!selected || !date || busy || locked} onclick={() => void check()}>Найти свободное время</Button>
    </div>
    {#if busy}<p role="status">Проверяем расписание…</p>{/if}
    {#if slots}
      <p role="status">Свободных вариантов: {slots.slots.length}. Часовой пояс: {slots.timeZone}.</p>
      {#if slots.slots.length === 0}<p>Нет свободного времени на выбранную дату.</p>{/if}
      <div class="customer-slot-list">
        {#each slots.slots as slot (slot.startAt)}
          <button type="button" class="customer-slot-choice" disabled={locked} aria-pressed={slotId === slot.startAt} onclick={() => slotId = slot.startAt}>{format(slot.startAt, slots.timeZone)}</button>
        {/each}
      </div>
      {#if chosen && selected}
        <div class="customer-choice-summary" role="status">
          <strong>Выбранное время</strong>
          <p>{date} · {format(chosen.startAt, slots.timeZone)} – {format(chosen.endAt, slots.timeZone)}</p>
          <p>{selected.serviceName} · {selected.staffName} · {selected.locationName}</p>
          <p>Время не забронировано. Итоговую стоимость подтвердит сервер.</p>
          {#if bookingEnabled}
            <Button type="button" disabled={locked || busy} onclick={() => void submitBooking()}>Записаться</Button>
          {:else}<p>Подтверждение записи пока недоступно.</p>{/if}
        </div>
      {/if}
    {/if}
  {/if}
  {#if blocked}
    <p role="alert" class="alert-error">Статус предыдущей попытки неизвестен. Не создавайте новую запись до проверки салоном. Если браузер запретил хранение, запись также недоступна.</p>
  {:else if bookingState.phase === "submitting"}
    <p role="status">Ожидаем подтверждения сервера. Запись ещё не подтверждена.</p>
  {:else if bookingState.phase === "error"}
    <div role="alert" class="alert-error">
      <p>Статус записи не подтверждён. Не создавайте новую запись до проверки результата.</p>
      {#if bookingState.retryable}<Button type="button" onclick={() => void retryBooking()}>Повторить проверку записи</Button>{/if}
    </div>
  {:else if bookingState.phase === "confirmed"}
    <div class="customer-choice-summary" role="status">
      <strong>Запись подтверждена</strong>
      <p>Номер записи: {bookingState.receipt.bookingId}</p>
      <p>{date} · {format(bookingState.receipt.startAt, selected?.timeZone ?? "UTC")} – {format(bookingState.receipt.endAt, selected?.timeZone ?? "UTC")}</p>
      <p>Фактическая стоимость: {receiptPrice(bookingState.receipt.priceKopecks)}</p>
      <Button type="button" onclick={newSelection}>Создать ещё запись</Button>
    </div>
  {/if}
  <p class="owner-form-note">Тестовая витрина. Свободное время — моментальный снимок, без резервирования слота и платежей.</p>
</section>

<style>
  .customer-slot-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
  .customer-slot-choice { min-height: 44px; padding: 8px; border: 1px solid currentColor; border-radius: 9px; font: inherit; background: transparent; color: inherit; cursor: pointer; }
  .customer-slot-choice[aria-pressed="true"] { font-weight: 700; outline: 2px solid currentColor; outline-offset: -3px; }
  .customer-choice-summary { display: grid; gap: 6px; margin-top: 12px; }
</style>
