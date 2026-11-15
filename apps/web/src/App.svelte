<script lang="ts">
  import { onMount } from "svelte";
  import { createCookieUiApi } from "./lib/api";
  import { localDay, longDate, mondayOf, money, offsetDay, shortDate, upcomingWeekday } from "./lib/dates";
  import { UiFailure } from "./lib/model";
  import type { BookingView, DemoSnapshot, SlotView, ViewState } from "./lib/model";
  import type { Screen } from "./lib/navigation";
  import Sidebar from "./lib/ui/Sidebar.svelte";
  import Topbar from "./lib/ui/Topbar.svelte";
  import BookingDetail from "./lib/ui/BookingDetail.svelte";
  import BookingSummary from "./lib/ui/BookingSummary.svelte";
  import "./styles.css";

  const api = createCookieUiApi();
  const weekdays = [
    { number: 1, name: "Пн" }, { number: 2, name: "Вт" }, { number: 3, name: "Ср" },
    { number: 4, name: "Чт" }, { number: 5, name: "Пт" }, { number: 6, name: "Сб" },
    { number: 0, name: "Вс" },
  ];
  const blank: DemoSnapshot = { organization: null, locations: [], services: [], staff: [], schedules: [], bookings: [] };

  let screen: Screen = "home";
  let data: DemoSnapshot = blank;
  let initializing = true;
  let busy = false;
  let busySlots = false;
  let error = "";
  let notice = "";
  let preview: ViewState = "normal";
  let organizationName = "Студия Cookie (тест)";
  let serviceName = "Женская стрижка";
  let serviceDuration = 60;
  let servicePrice = 1500;
  let staffName = "Алекс Демо";
  let staffTitle = "Стилист";
  let staffService = "";
  let locationName = "Второй филиал (демо)";
  let locationAddress = "Тестовый адрес";
  let scheduleStaff = "";
  let scheduleLocation = "";
  let scheduleDays: number[] = [1, 2, 3, 4, 5, 6];
  let scheduleStart = "09:00";
  let scheduleEnd = "18:00";
  let bookingService = "";
  let bookingStaff = "";
  let bookingLocation = "";
  let bookingDate = localDay(new Date());
  let bookingTime = "";
  let clientAlias = "Тестовый клиент";
  let slotSuggestions: SlotView[] = [];
  let createdBooking: BookingView | null = null;
  let calendarDate = localDay(new Date());
  let calendarMode: "day" | "week" = "week";
  let selectedBookingId = "";

  $: org = data.organization;
  $: stepCount = Number(!!org) + Number(data.services.length > 0) +
    Number(data.staff.length > 0) + Number(data.schedules.length > 0) +
    Number(data.bookings.length > 0);
  $: weekDates = Array.from({ length: 7 }, (_, index) => offsetDay(mondayOf(calendarDate), index));
  $: dayBookings = data.bookings.filter(item => item.date === calendarDate);
  $: bookingStaffOptions = data.staff.filter(item => !bookingService || item.serviceIds.includes(bookingService));
  $: chosenBooking = data.bookings.find(item => item.id === selectedBookingId);
  $: chosenService = data.services.find(item => item.id === bookingService);
  $: canBook = Boolean(bookingService && bookingStaff && bookingLocation && bookingDate && bookingTime && clientAlias.trim());
  $: currentOnboardingStep = !org ? "organization" : !data.services.length ? "services" :
    !data.staff.length ? "staff" : !data.schedules.length ? "schedule" :
    !data.bookings.length ? "booking" : "complete";

  onMount(() => { void reload(); });

  function describe(errorValue: unknown): string {
    return errorValue instanceof Error ? errorValue.message : "Не удалось выполнить действие. Повторите попытку.";
  }
  async function reload(): Promise<void> {
    try {
      data = await api.getSnapshot();
      if (!staffService) staffService = data.services[0]?.id ?? "";
      if (!scheduleStaff) scheduleStaff = data.staff[0]?.id ?? "";
      if (!scheduleLocation) scheduleLocation = data.locations[0]?.id ?? "";
      if (!bookingService) bookingService = data.services[0]?.id ?? "";
      if (!bookingLocation) bookingLocation = data.locations[0]?.id ?? "";
      if (!bookingStaff) bookingStaff = data.staff[0]?.id ?? "";
    } catch (reason) {
      error = describe(reason);
    } finally {
      initializing = false;
    }
  }
  async function transact(work: () => Promise<unknown>, next: Screen | undefined, message = "Демо-данные изменены только в этой вкладке."): Promise<void> {
    busy = true;
    error = "";
    notice = "";
    try {
      await work();
      await reload();
      notice = message;
      if (next) goto(next);
    } catch (reason) {
      error = describe(reason);
      if (reason instanceof UiFailure && reason.code === "SLOT_CONFLICT") {
        notice = "Выберите другое тестовое время. Настоящая проверка слотов должна выполняться сервером.";
        await loadSlots();
      }
    } finally {
      busy = false;
    }
  }
  function goto(next: Screen): void {
    screen = next;
    error = "";
    selectedBookingId = "";
    createdBooking = null;
    if (next === "booking") {
      const current = data.schedules.find(item => item.staffId === bookingStaff) ?? data.schedules[0];
      if (current) {
        bookingStaff = current.staffId;
        bookingLocation = current.locationId;
        bookingDate = upcomingWeekday(localDay(new Date()), current.weekdays);
      }
      void loadSlots();
    }
  }
  async function loadSlots(): Promise<void> {
    bookingTime = "";
    slotSuggestions = [];
    if (!bookingStaff || !bookingLocation || !bookingDate) return;
    busySlots = true;
    try {
      slotSuggestions = await api.getSlotSuggestions(bookingStaff, bookingLocation, bookingDate);
    } catch (reason) {
      error = describe(reason);
    } finally {
      busySlots = false;
    }
  }
  function toggleWeekday(day: number): void {
    scheduleDays = scheduleDays.includes(day) ? scheduleDays.filter(value => value !== day) : [...scheduleDays, day];
  }
  function syncStaffSelection(): void {
    if (!bookingStaffOptions.some(staff => staff.id === bookingStaff)) {
      bookingStaff = bookingStaffOptions[0]?.id ?? "";
    }
    void loadSlots();
  }
  function getService(id: string): string { return data.services.find(item => item.id === id)?.name ?? "Неизвестная услуга"; }
  function getStaff(id: string): string { return data.staff.find(item => item.id === id)?.displayName ?? "Неизвестный мастер"; }
  function getLocation(id: string): string { return data.locations.find(item => item.id === id)?.name ?? "Филиал"; }
  function bookingFor(day: string): BookingView[] { return data.bookings.filter(item => item.date === day); }
  async function createOrganization(): Promise<void> {
    await transact(() => api.createOrganization(organizationName), "services", "Тестовая организация создана в браузерной сессии.");
  }
  async function createService(): Promise<void> {
    await transact(async () => {
      const result = await api.addService(serviceName, serviceDuration, servicePrice);
      staffService = result.id;
      bookingService = result.id;
    }, "staff");
  }
  async function createStaff(): Promise<void> {
    await transact(async () => {
      const result = await api.addStaff(staffName, staffTitle, staffService ? [staffService] : []);
      scheduleStaff = result.id;
      bookingStaff = result.id;
    }, "schedule");
  }
  async function saveSchedule(): Promise<void> {
    await transact(() => api.saveSchedule({
      staffId: scheduleStaff, locationId: scheduleLocation, weekdays: scheduleDays,
      startsAt: scheduleStart, endsAt: scheduleEnd,
    }), "booking", "Демо-график сохранён. Далее можно создать тестовую запись.");
  }
  async function createLocation(): Promise<void> {
    await transact(() => api.addLocation(locationName, locationAddress), "locations");
  }
  async function submitBooking(): Promise<void> {
    if (!canBook) return;
    await transact(async () => {
      if (preview === "conflict") throw new UiFailure("SLOT_CONFLICT", "Демо-конфликт: выбранное время больше не доступно.");
      createdBooking = await api.createBooking({
        locationId: bookingLocation, serviceId: bookingService, staffId: bookingStaff,
        date: bookingDate, time: bookingTime, clientAlias,
      });
      calendarDate = bookingDate;
    }, undefined, "Создана только демо-запись в sessionStorage. Backend ничего не подтверждал.");
  }
  async function resetDemo(): Promise<void> {
    await transact(() => api.resetDemo(), "home", "Тестовые данные этой вкладки удалены.");
    data = blank;
    bookingService = ""; bookingStaff = ""; bookingLocation = "";
    scheduleStaff = ""; scheduleLocation = ""; staffService = "";
    createdBooking = null;
  }
</script>

<svelte:head>
  <title>Cookie — кабинет салона · демо</title>
  <meta name="description" content="Cookie: интерактивный демонстрационный интерфейс салона с синтетическими данными." />
</svelte:head>

<div class="app-shell">
  <Sidebar {screen} {stepCount} onNavigate={goto} />

  <div class="main-area">
    <Topbar {screen} bind:preview canCreateBooking={!!org} onNavigate={goto} />

    <main class="content">
      {#if error}<div class="alert alert-error" role="alert"><span aria-hidden="true">!</span><div><strong>Операция не выполнена</strong><p>{error}</p></div><button class="alert-close" type="button" onclick={() => error = ""} aria-label="Закрыть ошибку">×</button></div>{/if}
      {#if notice}<div class="alert alert-ok" role="status"><span aria-hidden="true">✓</span><p>{notice}</p><button class="alert-close" type="button" onclick={() => notice = ""} aria-label="Закрыть сообщение">×</button></div>{/if}
      {#if initializing || busy}
        <div class="loading-card" role="status"><div class="spinner"></div><span>{initializing ? "Загружаем демо-пространство…" : "Обновляем данные в браузерной сессии…"}</span></div>
      {:else if preview === "error"}
        <section class="state-card" role="alert"><span class="state-illustration">!</span><h2>Демо: ошибка загрузки</h2><p>Пример состояния при недоступном API. Изменения не выполнялись.</p><button class="btn btn-primary" onclick={() => preview = "normal"}>Повторить просмотр</button></section>
      {:else if preview === "forbidden"}
        <section class="state-card" role="status"><span class="state-illustration">⊘</span><h2>Демо: недостаточно прав</h2><p>Эту операцию должен разрешать backend с учётом роли и филиала. Здесь только UX-состояние.</p><button class="btn btn-secondary" onclick={() => preview = "normal"}>Вернуться</button></section>
      {:else if preview === "empty"}
        <section class="state-card" role="status"><span class="state-illustration">◇</span><h2>Демо: ничего не найдено</h2><p>Здесь будет сообщение о пустом списке, доступном действии и способе вернуться назад.</p><button class="btn btn-secondary" onclick={() => preview = "normal"}>Показать данные</button></section>
      {:else if screen === "home"}
        {#if !org}
          <div class="welcome-grid">
            <div class="welcome-copy"><span class="eyebrow">WELCOME TO COOKIE <span class="decor-line"></span></span><h1>Ваш салон.<br /><em>Ваш ритм.</em></h1><p>Простое пространство, где команда, услуги и записи работают вместе. Начните с тестового салона — без регистрации и реальных клиентов.</p><div class="welcome-metrics"><div><strong>5 шагов</strong><span>до первой записи</span></div><div><strong>0 ₽</strong><span>демо без платежей</span></div></div></div>
            <form class="welcome-form card" onsubmit={(event) => { event.preventDefault(); void createOrganization(); }}>
              <div class="form-icon">✳</div><span class="eyebrow">ШАГ 01 / 05</span><h2>Создайте тестовый салон</h2><p class="muted">Это не настоящая регистрация: данные останутся в текущей вкладке браузера.</p>
              <label class="field">Название салона<input bind:value={organizationName} required maxlength="80" placeholder="Студия Cookie (тест)" /></label>
              <div class="inline-note">Основной филиал будет добавлен автоматически как демонстрационный.</div>
              <button class="btn btn-primary btn-wide" type="submit">Создать тестовое пространство <span aria-hidden="true">→</span></button>
              <div class="form-foot">Без email, пароля и персональных данных</div>
            </form>
          </div>
        {:else}
          <div class="section-head"><div><span class="eyebrow">ВАШЕ ПРОСТРАНСТВО</span><h1>Хорошего дня!</h1><p>Организация <strong>{org.name}</strong> · только демонстрационные данные</p></div><button class="btn btn-secondary" onclick={() => goto("booking")}>Открыть онлайн-запись ↗</button></div>
          <div class="stat-grid">
            <div class="stat-card"><span>Услуги</span><strong>{data.services.length.toString().padStart(2, "0")}</strong><small>в каталоге</small><span class="stat-symbol">◇</span></div>
            <div class="stat-card"><span>Мастера</span><strong>{data.staff.length.toString().padStart(2, "0")}</strong><small>в команде</small><span class="stat-symbol">♧</span></div>
            <div class="stat-card"><span>Демо-записи</span><strong>{data.bookings.length.toString().padStart(2, "0")}</strong><small>в этой вкладке</small><span class="stat-symbol">▦</span></div>
            <div class="stat-card"><span>Филиалы</span><strong>{data.locations.length.toString().padStart(2, "0")}</strong><small>тестовые точки</small><span class="stat-symbol">⌂</span></div>
          </div>
          <div class="dashboard-grid"><section class="card dashboard-onboarding"><div class="card-title"><div><span class="eyebrow">БЫСТРЫЙ СТАРТ</span><h2>Подготовьте салон к первой записи</h2></div><span class="round-progress">{stepCount}/5</span></div><div class="checklist">
            {#each [{key:"organization",text:"Создать салон",screen:"home"},{key:"services",text:"Добавить услугу и цену",screen:"services"},{key:"staff",text:"Добавить мастера",screen:"staff"},{key:"schedule",text:"Настроить график",screen:"schedule"},{key:"booking",text:"Создать тестовую запись",screen:"booking"}] as step, index}
              <button class="check-row" onclick={() => goto(step.screen as Screen)}><span class:done={index < stepCount} class="check-indicator">{index < stepCount ? "✓" : index + 1}</span><span>{step.text}</span><span class="check-arrow">→</span></button>
            {/each}</div></section>
            <section class="card today-card"><div class="card-title"><div><span class="eyebrow">ЗАПИСИ</span><h2>Ближайший день</h2></div><span class="small-icon">◷</span></div><p class="muted">{longDate(calendarDate)}</p>
              {#if dayBookings.length === 0}<div class="empty-mini"><span>▦</span><strong>Пока записей нет</strong><p>Создайте первую демо-запись, чтобы увидеть её в календаре.</p></div>{:else}
                {#each dayBookings.slice(0, 3) as booking}<div class="mini-booking"><strong>{booking.time}</strong><div>{getService(booking.serviceId)}<small>{getStaff(booking.staffId)}</small></div></div>{/each}
              {/if}<button class="text-link" onclick={() => goto("calendar")}>Открыть календарь →</button>
            </section></div>
        {/if}
      {:else if !org}
        <section class="state-card"><span class="state-illustration">✳</span><h2>Сначала создайте тестовый салон</h2><p>После этого откроются услуги, команда, графики и календарь.</p><button class="btn btn-primary" onclick={() => goto("home")}>К созданию салона →</button></section>
      {:else if screen === "services"}
        <div class="section-head"><div><span class="eyebrow">КАТАЛОГ САЛОНА</span><h1>Услуги и цены</h1><p>Единая длительность и базовая цена на уровне организации.</p></div><span class="counter-pill">{data.services.length} услуг</span></div>
        <div class="workspace-grid"><section class="card"><div class="card-title"><div><span class="eyebrow">КАТАЛОГ</span><h2>Ваши услуги</h2></div></div>
          {#if data.services.length === 0}<div class="empty-mini"><span>◇</span><strong>Здесь появятся услуги</strong><p>Добавьте первую тестовую услугу справа.</p></div>{:else}
            <div class="list-items">{#each data.services as service}<div class="entity-row"><span class="service-tile">✳</span><div class="entity-text"><strong>{service.name}</strong><small>{service.durationMinutes} мин · единая длительность</small></div><strong class="price-label">{money(service.basePriceRub)}</strong></div>{/each}</div>
          {/if}
        </section>
        <form class="card" onsubmit={(event) => { event.preventDefault(); void createService(); }}><span class="eyebrow">ДОБАВИТЬ УСЛУГУ</span><h2>Новая услуга</h2><p class="muted">Базовая цена без скидок и надбавок. Никаких вычислений стоимости в браузере.</p>
          <label class="field">Название<input bind:value={serviceName} required maxlength="100" /></label>
          <div class="form-pair"><label class="field">Длительность, мин<input type="number" bind:value={serviceDuration} min="1" step="5" required /></label><label class="field">Базовая цена, ₽<input type="number" bind:value={servicePrice} min="0" step="1" required /></label></div>
          <button class="btn btn-primary btn-wide" type="submit">Добавить демо-услугу <span aria-hidden="true">→</span></button>
        </form></div>
      {:else if screen === "staff"}
        <div class="section-head"><div><span class="eyebrow">ВАША КОМАНДА</span><h1>Мастера</h1><p>Профили и услуги мастеров. Доступы и права здесь не назначаются.</p></div><span class="counter-pill">{data.staff.length} специалистов</span></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">КОМАНДА</span><h2>Специалисты салона</h2>
          {#if data.staff.length === 0}<div class="empty-mini"><span>♧</span><strong>Команда пока пуста</strong><p>Добавьте мастера с синтетическим именем.</p></div>{:else}
            <div class="list-items">{#each data.staff as member}<div class="entity-row"><span class="staff-avatar">{member.displayName.slice(0, 1)}</span><div class="entity-text"><strong>{member.displayName}</strong><small>{member.positionTitle} · {member.serviceIds.map(getService).join(", ")}</small></div><span class="status-pill">Демо</span></div>{/each}</div>
          {/if}
        </section>
        <form class="card" onsubmit={(event) => { event.preventDefault(); void createStaff(); }}><span class="eyebrow">ДОБАВИТЬ МАСТЕРА</span><h2>Новый специалист</h2>
          <label class="field">Псевдоним мастера<input bind:value={staffName} required maxlength="80" placeholder="Алекс Демо" /></label>
          <label class="field">Название на витрине<input bind:value={staffTitle} maxlength="80" placeholder="Стилист" /></label>
          <label class="field">Услуга<select bind:value={staffService} required><option value="" disabled>Выберите услугу</option>{#each data.services as service}<option value={service.id}>{service.name}</option>{/each}</select></label>
          {#if data.services.length === 0}<p class="inline-note">Сначала добавьте хотя бы одну услугу.</p><button type="button" class="btn btn-secondary btn-wide" onclick={() => goto("services")}>К услугам →</button>{:else}<button type="submit" class="btn btn-primary btn-wide">Добавить демо-мастера <span aria-hidden="true">→</span></button>{/if}
        </form></div>
      {:else if screen === "schedule"}
        <div class="section-head"><div><span class="eyebrow">РАБОЧЕЕ ВРЕМЯ</span><h1>Расписание</h1><p>Настройка шаблона рабочих дней для тестового мастера и филиала.</p></div></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">ТЕКУЩИЕ ГРАФИКИ</span><h2>Рабочие недели</h2>
          {#if data.schedules.length === 0}<div class="empty-mini"><span>◷</span><strong>График не задан</strong><p>Добавьте расписание, чтобы появились демо-слоты.</p></div>{:else}
            {#each data.schedules as schedule}<div class="schedule-summary"><div class="schedule-icon">◷</div><div><strong>{getStaff(schedule.staffId)}</strong><p>{getLocation(schedule.locationId)} · {schedule.startsAt}–{schedule.endsAt}</p><div class="weekday-chips">{#each weekdays as day}<span class:chosen={schedule.weekdays.includes(day.number)}>{day.name}</span>{/each}</div></div></div>{/each}
          {/if}
          <div class="inline-note">Изменения расписания не пересчитывают существующие записи. В production конфликты, права и занятость проверяет сервер.</div>
        </section>
        <form class="card" onsubmit={(event) => { event.preventDefault(); void saveSchedule(); }}><span class="eyebrow">НАСТРОИТЬ НЕДЕЛЮ</span><h2>График мастера</h2>
          <label class="field">Мастер<select bind:value={scheduleStaff} required><option value="" disabled>Выберите мастера</option>{#each data.staff as member}<option value={member.id}>{member.displayName}</option>{/each}</select></label>
          <label class="field">Филиал<select bind:value={scheduleLocation} required>{#each data.locations as location}<option value={location.id}>{location.name}</option>{/each}</select></label>
          <div class="field"><span class="field-caption">Рабочие дни</span><div class="weekday-select">{#each weekdays as day}<button type="button" class:selected={scheduleDays.includes(day.number)} onclick={() => toggleWeekday(day.number)} aria-pressed={scheduleDays.includes(day.number)}>{day.name}</button>{/each}</div></div>
          <div class="form-pair"><label class="field">Начало<input type="time" bind:value={scheduleStart} required /></label><label class="field">Окончание<input type="time" bind:value={scheduleEnd} required /></label></div>
          {#if data.staff.length === 0}<button class="btn btn-secondary btn-wide" type="button" onclick={() => goto("staff")}>Сначала добавьте мастера →</button>{:else}<button class="btn btn-primary btn-wide" type="submit" disabled={scheduleDays.length === 0}>Сохранить демо-график <span aria-hidden="true">→</span></button>{/if}
        </form></div>
      {:else if screen === "locations"}
        <div class="section-head"><div><span class="eyebrow">СТРУКТУРА САЛОНА</span><h1>Филиалы</h1><p>Синтетические адреса для демонстрации переключения локаций.</p></div></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">ЛОКАЦИИ</span><h2>Филиалы организации</h2>
          <div class="list-items">{#each data.locations as location}<div class="entity-row"><span class="service-tile">⌂</span><div class="entity-text"><strong>{location.name}</strong><small>{location.address}</small></div><span class="status-pill">Демо</span></div>{/each}</div>
        </section>
        <form class="card" onsubmit={(event) => { event.preventDefault(); void createLocation(); }}><span class="eyebrow">НОВЫЙ ФИЛИАЛ</span><h2>Добавить локацию</h2>
          <label class="field">Название<input bind:value={locationName} maxlength="80" required /></label>
          <label class="field">Демонстрационный адрес<input bind:value={locationAddress} maxlength="120" /></label>
          <button class="btn btn-primary btn-wide" type="submit">Добавить демо-филиал →</button>
        </form></div>
      {:else if screen === "calendar"}
        <div class="section-head"><div><span class="eyebrow">РАСПИСАНИЕ ВИЗИТОВ</span><h1>Календарь записей</h1><p>Только тестовые записи. Без доступа к реальным клиентам.</p></div><button class="btn btn-primary" onclick={() => goto("booking")}>+ Новая запись</button></div>
        <section class="card calendar-card"><div class="calendar-toolbar"><div class="calendar-move"><button type="button" aria-label="Предыдущий период" onclick={() => calendarDate = offsetDay(calendarDate, calendarMode === "week" ? -7 : -1)}>‹</button><button type="button" onclick={() => calendarDate = localDay(new Date())}>Сегодня</button><button type="button" aria-label="Следующий период" onclick={() => calendarDate = offsetDay(calendarDate, calendarMode === "week" ? 7 : 1)}>›</button></div><h2>{calendarMode === "day" ? longDate(calendarDate) : `${shortDate(weekDates[0] ?? calendarDate)} — ${shortDate(weekDates[6] ?? calendarDate)}`}</h2><div class="segmented"><button class:active={calendarMode === "day"} onclick={() => calendarMode = "day"}>День</button><button class:active={calendarMode === "week"} onclick={() => calendarMode = "week"}>Неделя</button></div></div>
          {#if calendarMode === "week"}<div class="week-grid">{#each weekDates as day}<div class="week-column"><button type="button" class="week-heading" class:today={day === localDay(new Date())} onclick={() => { calendarDate = day; calendarMode = "day"; }}><small>{new Intl.DateTimeFormat("ru-RU", {weekday:"short"}).format(new Date(day + "T12:00:00"))}</small><strong>{day.slice(-2)}</strong></button><div class="week-body">{#if bookingFor(day).length === 0}<div class="no-bookings">—</div>{:else}{#each bookingFor(day) as booking}<button class="calendar-event" onclick={() => selectedBookingId = booking.id}><span>{booking.time}</span><strong>{getService(booking.serviceId)}</strong><small>{getStaff(booking.staffId)}</small></button>{/each}{/if}</div></div>{/each}</div>
          {:else}<div class="day-timeline">{#if dayBookings.length === 0}<div class="empty-mini"><span>▦</span><strong>На этот день записей нет</strong><p>Выберите другой день или создайте тестовую запись.</p><button class="btn btn-secondary" onclick={() => goto("booking")}>Создать запись</button></div>{:else}
            {#each [...dayBookings].sort((a,b) => a.time.localeCompare(b.time)) as booking}<button class="timeline-entry" onclick={() => selectedBookingId = booking.id}><strong class="timeline-time">{booking.time}</strong><div class="timeline-detail"><strong>{getService(booking.serviceId)}</strong><span>{getStaff(booking.staffId)} · {getLocation(booking.locationId)}</span></div><span class="status-pill">Демо</span><span aria-hidden="true">→</span></button>{/each}{/if}</div>{/if}
        </section>
        {#if chosenBooking}
          <BookingDetail
            booking={chosenBooking}
            serviceName={getService}
            staffName={getStaff}
            locationName={getLocation}
            onClose={() => selectedBookingId = ""}
          />
        {/if}
      {:else if screen === "booking"}
        <div class="booking-head"><div><span class="eyebrow">КЛИЕНТСКАЯ ВИТРИНА · ПРЕДПРОСМОТР</span><h1>Записаться на услугу</h1><p>{org.name} · демонстрационная форма без реального бронирования</p></div><span class="public-chip">PUBLIC UI / DEMO</span></div>
        {#if createdBooking}
          <section class="card success-screen"><div class="success-symbol">✓</div><span class="eyebrow">ЗАПИСЬ СОЗДАНА ЛОКАЛЬНО</span><h2>Готово! Это демо-запись.</h2><p>Запись сохранена только в браузерной сессии. Она <strong>не подтверждена backend</strong> и не резервирует время у мастера.</p>
            <div class="success-receipt"><div><span>Услуга</span><strong>{getService(createdBooking.serviceId)}</strong></div><div><span>Дата и время</span><strong>{longDate(createdBooking.date)}, {createdBooking.time}</strong></div><div><span>Мастер</span><strong>{getStaff(createdBooking.staffId)}</strong></div><div><span>Демо-ID</span><strong class="mono">{createdBooking.id.slice(0, 8)}</strong></div></div>
            <div class="button-row"><button class="btn btn-primary" onclick={() => { calendarDate = createdBooking!.date; goto("calendar"); }}>Посмотреть в календаре →</button><button class="btn btn-secondary" onclick={() => goto("booking")}>Ещё одна демо-запись</button></div>
          </section>
        {:else}
          <div class="booking-layout"><form class="card booking-form" onsubmit={(event) => { event.preventDefault(); void submitBooking(); }}><div class="card-title"><div><span class="eyebrow">ШАГИ БРОНИРОВАНИЯ</span><h2>Выберите время для визита</h2></div><span class="small-icon">✳</span></div>
            <label class="field">01 · Услуга<select bind:value={bookingService} onchange={syncStaffSelection} required><option value="" disabled>Выберите услугу</option>{#each data.services as service}<option value={service.id}>{service.name} · {service.durationMinutes} мин</option>{/each}</select></label>
            <div class="form-pair"><label class="field">02 · Филиал<select bind:value={bookingLocation} onchange={() => void loadSlots()} required>{#each data.locations as location}<option value={location.id}>{location.name}</option>{/each}</select></label>
            <label class="field">03 · Мастер<select bind:value={bookingStaff} onchange={() => void loadSlots()} required><option value="" disabled>Выберите мастера</option>{#each bookingStaffOptions as member}<option value={member.id}>{member.displayName}</option>{/each}</select></label></div>
            <label class="field">04 · Дата<input type="date" min={localDay(new Date())} bind:value={bookingDate} onchange={() => void loadSlots()} required /></label>
            <div class="field"><span class="field-caption">05 · Время <small>(синтетические слоты)</small></span>
              {#if busySlots}<div class="inline-note" role="status">Загружаем демонстрационные слоты…</div>
              {:else if slotSuggestions.length === 0}<div class="empty-slots" role="status">Нет демонстрационных слотов. Сначала задайте график мастера либо выберите рабочий день.</div>
              {:else}<div class="slot-grid">{#each slotSuggestions as slot}<button type="button" class:selected={bookingTime === slot.time} aria-pressed={bookingTime === slot.time} onclick={() => bookingTime = slot.time}>{slot.time}</button>{/each}</div>{/if}
            </div>
            <label class="field">06 · Псевдоним тестового клиента<input bind:value={clientAlias} maxlength="80" required placeholder="Тестовый клиент" /></label>
            <div class="inline-note">Не вводите реальные имена, телефоны или другие персональные данные. В реальном продукте идентификацию выполнит backend.</div>
            <button class="btn btn-primary btn-wide" type="submit" disabled={!canBook || busySlots}>Создать тестовую запись →</button>
          </form>
          <BookingSummary
            service={chosenService}
            staffId={bookingStaff}
            {bookingDate}
            {bookingTime}
            staffName={getStaff}
          />
        </div>
          {#if data.services.length === 0 || data.staff.length === 0 || data.schedules.length === 0}<div class="setup-shortcut"><span>Для полного сценария сначала создайте услугу, мастера и график.</span><button class="btn btn-secondary" onclick={() => goto(currentOnboardingStep === "services" ? "services" : currentOnboardingStep === "staff" ? "staff" : "schedule")}>Продолжить настройку →</button></div>{/if}
        {/if}
      {/if}

      {#if !initializing}<footer class="footer"><span>Cookie / frontend preview · F1 · никакие записи не отправляются на сервер</span><button type="button" onclick={() => void resetDemo()} disabled={busy}>Сбросить демо-данные</button></footer>{/if}
    </main>
  </div>
</div>
