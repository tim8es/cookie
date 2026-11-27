<script lang="ts">
  import { onMount, tick } from "svelte";
  import ActionButton from "../components/rhythm/ActionButton.svelte";
  import { Input } from "../components/ui/input/index.js";
  import ThemeScope from "../components/rhythm/ThemeScope.svelte";
  import BookingLayout from "../components/rhythm/BookingLayout.svelte";
  import BookingTicket from "../components/rhythm/BookingTicket.svelte";
  import ChoiceList from "../components/rhythm/ChoiceList.svelte";
  import type { BookingStep, TicketLine } from "../components/rhythm/contracts.js";
  import { canCreateCustomerBooking, customerBookingAttempt, recoverCustomerBooking, type CustomerBookingSelection } from "../staging-customer-booking-api";
  import type { BookingAttempt, BookingAttemptState } from "../booking-attempt";
  import type { ConfirmedBookingReceipt } from "../confirmed-booking-receipt";
  import type { OwnBookingHistory } from "../staging-customer-history-api";
  import { receiptDisposition } from "../customer-receipt-disposition";
  import type { CustomerSlot } from "../staging-customer-offers-api";
  import type { VerifiedCustomerSession } from "../owner-auth";
  import { readCustomerOffers, readCustomerSlots, CustomerOffersError, type CustomerOffer, type CustomerSlots } from "../staging-customer-offers-api";
  export let session: VerifiedCustomerSession;
  export let onUnauthorized: () => void;
  export let onConfirmed: () => void = () => {};
  export let historySnapshot: OwnBookingHistory | null = null;
  let offers: CustomerOffer[] = [];
  let locationId = "";
  let serviceId = "";
  let serviceQuery = "";
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
  let recoveryBusy = false;
  let recoveryMessage = "";
  let recovered = false;
  let attempt: BookingAttempt<CustomerBookingSelection, ConfirmedBookingReceipt, CustomerSlot> | null = null;
  let bookingState: BookingAttemptState<ConfirmedBookingReceipt, CustomerSlot> = { phase: "idle" };
  let locked = false;
  let receiptSummary: HTMLDivElement | undefined;
  let bookingLayout: BookingLayout | undefined;
  let step: "service" | "staff" | "time" | "review" = "service";
  $: disposition = bookingState.phase === "confirmed" ? receiptDisposition(bookingState.receipt, historySnapshot) : "unverified";
  $: locked = recoveryBusy || blocked || bookingState.phase === "submitting" || bookingState.phase === "error" || bookingState.phase === "confirmed";
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
    try { sessionStorage.removeItem(storageKey); blocked = false; }
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
    if (recoveryBusy || !attempt || bookingState.phase !== "error" || !bookingState.retryable) return;
    bookingState = { phase: "submitting" };
    applyResult(await attempt.retry());
  }
  async function recoverPending(): Promise<void> {
    if (recoveryBusy || !bookingEnabled || (!blocked && bookingState.phase !== "error")) return;
    recoveryBusy = true;
    recoveryMessage = "";
    try {
      const key = sessionStorage.getItem(storageKey);
      if (!key) { recoveryMessage = "Исходный ключ недоступен. Обратитесь в салон."; return; }
      const receipt = await recoverCustomerBooking(session, key);
      if (!mounted) return;
      if (Date.now() / 1000 >= session.expiresAtUnixSeconds) { onUnauthorized(); return; }
      if (!receipt || sessionStorage.getItem(storageKey) !== key) {
        recoveryMessage = "Сервер не подтвердил исходную операцию. Не создавайте новую запись; повторите проверку или обратитесь в салон.";
        return;
      }
      clearPending();
      attempt = null;
      recovered = true;
      bookingState = { phase: "confirmed", receipt };
      slots = null; slotId = "";
      onConfirmed();
      void focusReceipt();
    } catch {
      if (mounted) recoveryMessage = "Не удалось проверить исходную операцию. Не создавайте новую запись.";
    } finally { if (mounted) recoveryBusy = false; }
  }
  function applyResult(result: BookingAttemptState<ConfirmedBookingReceipt, CustomerSlot>): void {
    if (!mounted) return;
    recovered = false;
    recoveryMessage = "";
    bookingState = result;
    if (result.phase === "confirmed") {
      clearPending();
      slots = null; slotId = "";
      onConfirmed();
      void focusReceipt();
    } else if (result.phase === "conflict") {
      clearPending();
      step = "time";
      void focusStep();
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
  async function focusReceipt(): Promise<void> {
    await tick();
    if (mounted && bookingState.phase === "confirmed") receiptSummary?.focus();
  }
  function newSelection(): void {
    if (blocked || bookingState.phase !== "confirmed") return;
    attempt = null; bookingState = { phase: "idle" };
    recovered = false; recoveryMessage = "";
    step = "service";
    void refresh();
  }
  function unique(items: CustomerOffer[], key: "locationId" | "serviceId" | "staffId") {
    return [...new Map(items.map(item => [item[key], item])).values()];
  }
  $: services = unique(offers, "serviceId");
  $: serviceChoices = offers.reduce((items, item) => {
    const current = items.get(item.serviceId);
    const amount = Number(item.basePriceKopecks);
    if (current) {
      current.minPrice = Math.min(current.minPrice, amount);
      current.maxPrice = Math.max(current.maxPrice, amount);
      current.minDuration = Math.min(current.minDuration, item.durationMinutes);
      current.maxDuration = Math.max(current.maxDuration, item.durationMinutes);
    } else {
      items.set(item.serviceId, {
        title: item.serviceName, minPrice: amount, maxPrice: amount,
        minDuration: item.durationMinutes, maxDuration: item.durationMinutes,
      });
    }
    return items;
  }, new Map<string, { title: string; minPrice: number; maxPrice: number; minDuration: number; maxDuration: number }>());
  $: visibleServices = [...serviceChoices.entries()]
    .filter(([, item]) => item.title.toLocaleLowerCase("ru-RU").includes(serviceQuery.trim().toLocaleLowerCase("ru-RU")))
    .map(([id, item]) => ({
      id, title: item.title,
      description: (item.minDuration === item.maxDuration ? String(item.minDuration) : item.minDuration + "–" + item.maxDuration) + " мин",
      detail: (item.minPrice === item.maxPrice ? "" : "от ") + price(String(item.minPrice)),
    }));
  $: locations = unique(offers.filter(o => o.serviceId === serviceId), "locationId");
  $: staff = unique(offers.filter(o => o.locationId === locationId && o.serviceId === serviceId), "staffId");
  $: selected = offers.find(o => o.locationId === locationId && o.serviceId === serviceId && o.staffId === staffId);
  $: chosen = slots?.slots.find(s => s.startAt === slotId);
  $: steps = [
    { id: "service", label: "Услуга", reachable: true, complete: !!serviceId },
    { id: "staff", label: "Филиал и мастер", reachable: !!serviceId, complete: !!selected },
    { id: "time", label: "Дата и время", reachable: !!selected, complete: !!chosen },
    { id: "review", label: "Проверка", reachable: !!chosen },
  ] satisfies BookingStep[];
  $: ticketLines = [
    ...(serviceId ? [{ label: "Услуга", value: services.find(item => item.serviceId === serviceId)?.serviceName ?? "" }] : []),
    ...(locationId ? [{ label: "Филиал", value: locations.find(item => item.locationId === locationId)?.locationName ?? "" }] : []),
    ...(selected ? [{ label: "Мастер", value: selected.staffName }, { label: "Длительность", value: selected.durationMinutes + " мин" }] : []),
    ...(chosen && slots ? [{ label: "Время", value: date + " · " + format(chosen.startAt, slots.timeZone) }] : []),
  ] satisfies TicketLine[];
  function navigateStep(id: string): void {
    if (locked || busy || !steps.some(item => item.id === id && item.reachable)) return;
    if (id === "service" || id === "staff" || id === "time" || id === "review") {
      step = id;
      void focusStep();
    }
  }
  function nextStep(): void {
    if (step === "service" && serviceId) step = "staff";
    else if (step === "staff" && selected) step = "time";
    else if (step === "time" && chosen) step = "review";
    void focusStep();
  }
  async function focusStep(): Promise<void> {
    await tick();
    if (mounted && !locked) bookingLayout?.focusHeading();
  }
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
    step = "service";
    busy = true; loaded = false; offers = []; locationId = ""; serviceId = ""; serviceQuery = ""; staffId = ""; date = ""; slots = null; slotId = ""; error = "";
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

<ThemeScope>
<section class="card" aria-label="Клиентская витрина staging">
  <div class="card-title">
    <ActionButton disabled={busy || locked} onclick={() => void refresh()}>Обновить каталог</ActionButton>
  </div>
  {#if error}<p role="alert" class="alert-error">{error}</p>{/if}
  {#if busy && !loaded}<p role="status">Загружаем опубликованные услуги…</p>
  {:else if loaded && offers.length === 0}<p>Сейчас нет доступных опубликованных услуг.</p>
  {:else if loaded && !blocked && bookingState.phase !== "confirmed"}
    <BookingLayout bind:this={bookingLayout} title={step === "service" ? "Выберите услугу" : step === "staff" ? "Филиал и мастер" : step === "time" ? "Дата и время" : "Проверьте запись"}
      {steps} current={step} onStep={locked ? undefined : navigateStep} {busy}
      nextLabel={step === "review" || locked ? undefined : "Продолжить"}
      nextDisabled={step === "service" ? !serviceId : step === "staff" ? !selected : !chosen}
      onNext={nextStep}>
      {#snippet summary()}
        <BookingTicket lines={ticketLines} priceLabel={selected ? price(selected.basePriceKopecks) : undefined}
          priceNote="Базовая цена каталога. Итоговую стоимость подтвердит сервер." />
      {/snippet}
      <div class="owner-form">
        {#if step === "service"}
          <label class="field">Поиск услуги
            <Input type="search" bind:value={serviceQuery} disabled={busy || locked} placeholder="Название услуги" />
          </label>
          <ChoiceList title="Услуги" items={visibleServices} selected={serviceId}
            disabled={busy || locked} emptyLabel="Услуги по вашему запросу не найдены"
            onSelect={id => { if (id !== serviceId) { serviceId = id; locationId = ""; staffId = ""; date = ""; resetSlots(); } }} />
        {:else if step === "staff"}
          <label class="field">Филиал
            <select value={locationId} disabled={busy || locked} onchange={event => { locationId = event.currentTarget.value; staffId = ""; date = ""; resetSlots(); }}>
              <option value="">Выберите филиал</option>
              {#each locations as item (item.locationId)}<option value={item.locationId}>{item.locationName}</option>{/each}
            </select>
          </label>
          <label class="field">Мастер
            <select value={staffId} disabled={!locationId || busy || locked} onchange={event => { staffId = event.currentTarget.value; date = ""; resetSlots(); }}>
              <option value="">Выберите мастера</option>
              {#each staff as item (item.staffId)}<option value={item.staffId}>{item.staffName}</option>{/each}
            </select>
          </label>
        {:else if step === "time"}
          <label class="field">Дата филиала
            <Input type="date" value={date} disabled={busy || locked} onchange={event => { date = event.currentTarget.value; resetSlots(); }} />
          </label>
          <ActionButton tone="primary" disabled={!date || busy || locked} onclick={() => void check()}>Найти свободное время</ActionButton>
          {#if busy}<p role="status">Проверяем расписание…</p>{/if}
          {#if slots}
            <p role="status">Свободных вариантов: {slots.slots.length}. Часовой пояс: {slots.timeZone}.</p>
            {#if slots.slots.length === 0}<p>Нет свободного времени на выбранную дату.</p>{/if}
            <div class="customer-slot-list">
              {#each slots.slots as slot (slot.startAt)}
                <button type="button" class="customer-slot-choice" disabled={locked} aria-pressed={slotId === slot.startAt} onclick={() => slotId = slot.startAt}>{format(slot.startAt, slots.timeZone)}</button>
              {/each}
            </div>
          {/if}
        {:else if chosen && selected && slots}
          <div class="customer-choice-summary" role="status">
            <strong>Выбранное время</strong>
            <p>{date} · {format(chosen.startAt, slots.timeZone)} – {format(chosen.endAt, slots.timeZone)}</p>
            <p>{selected.serviceName} · {selected.staffName} · {selected.locationName}</p>
            <p>Время не забронировано. Итоговую стоимость подтвердит сервер.</p>
            {#if bookingEnabled}
              <ActionButton tone="primary" disabled={locked || busy} onclick={() => void submitBooking()}>Записаться</ActionButton>
            {:else}<p>Подтверждение записи пока недоступно.</p>{/if}
          </div>
        {/if}
      </div>
    </BookingLayout>
  {/if}
  {#if blocked}
    <p role="alert" class="alert-error">Статус предыдущей попытки неизвестен. Не создавайте новую запись до проверки результата. Если браузер запретил хранение, запись также недоступна.</p>
    {#if bookingEnabled}<ActionButton disabled={recoveryBusy} onclick={() => void recoverPending()}>Найти подтверждение записи</ActionButton>{/if}
  {:else if bookingState.phase === "submitting"}
    <p role="status">Ожидаем подтверждения сервера. Запись ещё не подтверждена.</p>
  {:else if bookingState.phase === "error"}
    <div role="alert" class="alert-error">
      <p>Статус записи не подтверждён. Не создавайте новую запись до проверки результата.</p>
      {#if bookingState.retryable}<ActionButton disabled={recoveryBusy} onclick={() => void retryBooking()}>Повторить проверку записи</ActionButton>{/if}
      <ActionButton disabled={recoveryBusy} onclick={() => void recoverPending()}>Найти подтверждение записи</ActionButton>
    </div>
  {:else if bookingState.phase === "confirmed"}
    <div class="customer-choice-summary" role="status" tabindex="-1" bind:this={receiptSummary}>
      {#if disposition === "changed"}
        <strong>Запись изменена после создания</strong>
        <p>Номер записи: {bookingState.receipt.bookingId}</p>
        <p>Актуальные время, стоимость и статус смотрите в разделе «Мои записи».</p>
      {:else}
        <strong>Создание записи подтверждено</strong>
        {#if recovered}<p>Восстановлено по исходной операции.</p>{/if}
        <p>Номер записи: {bookingState.receipt.bookingId}</p>
        {#if disposition === "original"}
          <p>Статус на момент обновления списка: подтверждена.</p>
        {:else}
          <p>Текущий статус ещё не проверен. Это подтверждение первоначальной операции, а не текущего состояния.</p>
        {/if}
        {#if recovered}
          <p>Время при создании (UTC): {bookingState.receipt.startAt.slice(0,16).replace("T"," ")} – {bookingState.receipt.endAt.slice(0,16).replace("T"," ")}</p>
        {:else}
          <p>Время при создании: {date} · {format(bookingState.receipt.startAt, selected?.timeZone ?? "UTC")} – {format(bookingState.receipt.endAt, selected?.timeZone ?? "UTC")}</p>
        {/if}
        <p>Фактическая стоимость при создании: {receiptPrice(bookingState.receipt.priceKopecks)}</p>
      {/if}
      <ActionButton tone="primary" onclick={newSelection}>Создать ещё запись</ActionButton>
    </div>
  {/if}
  {#if recoveryBusy}<p role="status">Проверяем исходную операцию на сервере…</p>{/if}
  {#if recoveryMessage}<p role="alert">{recoveryMessage}</p>{/if}
  <p class="owner-form-note">Тестовая витрина. Свободное время — моментальный снимок, без резервирования слота и платежей.</p>
</section>
</ThemeScope>

<style>
  .customer-slot-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
  .customer-slot-choice { min-height: 44px; padding: 8px; border: 1px solid currentColor; border-radius: 9px; font: inherit; background: transparent; color: inherit; cursor: pointer; }
  .customer-slot-choice[aria-pressed="true"] { font-weight: 700; outline: 2px solid currentColor; outline-offset: -3px; }
  .customer-choice-summary { display: grid; gap: 6px; margin-top: 12px; }
</style>
