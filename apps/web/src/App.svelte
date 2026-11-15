<script lang="ts">
  import { onMount } from "svelte";
  import { createCookieUiApi } from "./lib/api";
  import { localDay, longDate, money, upcomingWeekday } from "./lib/dates";
  import { UiFailure } from "./lib/model";
  import type { BookingView, DemoSnapshot, SlotView, ViewState } from "./lib/model";
  import type { Screen } from "./lib/navigation";
  import Sidebar from "./lib/ui/Sidebar.svelte";
  import Topbar from "./lib/ui/Topbar.svelte";
  import PublicHeader from "./lib/ui/PublicHeader.svelte";
  import OnboardingHeader from "./lib/ui/OnboardingHeader.svelte";
  import OnboardingScreen from "./lib/ui/OnboardingScreen.svelte";
  import OwnerOverview from "./lib/ui/OwnerOverview.svelte";
  import CalendarView from "./lib/ui/CalendarView.svelte";
  import BookingForm from "./lib/ui/BookingForm.svelte";
  import ServiceForm from "./lib/ui/ServiceForm.svelte";
  import StaffForm from "./lib/ui/StaffForm.svelte";
  import ScheduleForm from "./lib/ui/ScheduleForm.svelte";
  import LocationForm from "./lib/ui/LocationForm.svelte";
  import { weekdays } from "./lib/weekdays";
  import "./styles.css";
  import "./visual-system.css";

  const api = createCookieUiApi();
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

  $: org = data.organization;
  $: stepCount = Number(!!org) + Number(data.services.length > 0) +
    Number(data.staff.length > 0) + Number(data.schedules.length > 0) +
    Number(data.bookings.length > 0);
  $: dayBookings = data.bookings.filter(item => item.date === calendarDate);
  $: bookingStaffOptions = data.staff.filter(item => !bookingService || item.serviceIds.includes(bookingService));
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
    if (next === "booking") notice = "";
    error = "";
    createdBooking = null;
    if (next === "booking") {
      const current = data.schedules.find(item =>
        data.staff.some(staff => staff.id === item.staffId && staff.serviceIds.includes(bookingService))
      ) ?? data.schedules[0];
      if (current) {
        const assignedStaff = data.staff.find(item => item.id === current.staffId);
        if (assignedStaff && !assignedStaff.serviceIds.includes(bookingService)) {
          bookingService = assignedStaff.serviceIds[0] ?? "";
        }
        bookingStaff = current.staffId;
        bookingLocation = current.locationId;
        bookingDate = upcomingWeekday(localDay(new Date()), current.weekdays);
      }
      void loadSlots();
    }
  }
  let slotRequestVersion = 0;
  async function loadSlots(): Promise<void> {
    const version = ++slotRequestVersion;
    bookingTime = "";
    slotSuggestions = [];
    busySlots = false;
    if (!bookingStaff || !bookingLocation || !bookingDate) return;
    busySlots = true;
    const staffId = bookingStaff;
    const locationId = bookingLocation;
    const date = bookingDate;
    try {
      const suggested = await api.getSlotSuggestions(staffId, locationId, date);
      if (version === slotRequestVersion) slotSuggestions = suggested;
    } catch (reason) {
      if (version === slotRequestVersion) error = describe(reason);
    } finally {
      if (version === slotRequestVersion) busySlots = false;
    }
  }
  function toggleWeekday(day: number): void {
    scheduleDays = scheduleDays.includes(day) ? scheduleDays.filter(value => value !== day) : [...scheduleDays, day];
  }
  function syncStaffSelection(serviceId: string): void {
    // Read the new option value directly rather than relying on bind timing.
    bookingService = serviceId;
    const eligible = data.staff.filter(staff => staff.serviceIds.includes(serviceId));
    if (!eligible.some(staff => staff.id === bookingStaff)) {
      bookingStaff = eligible[0]?.id ?? "";
    }
    void loadSlots();
  }
  function getService(id: string): string { return data.services.find(item => item.id === id)?.name ?? "Неизвестная услуга"; }
  function getStaff(id: string): string { return data.staff.find(item => item.id === id)?.displayName ?? "Неизвестный мастер"; }
  function getLocation(id: string): string { return data.locations.find(item => item.id === id)?.name ?? "Филиал"; }
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
  <title>{screen === "booking" ? "Cookie — онлайн-запись · демо" : "Cookie — кабинет салона · демо"}</title>
  <meta name="description" content="Cookie: интерактивный демонстрационный интерфейс салона с синтетическими данными." />
</svelte:head>

<div class="app-shell" class:public-shell={screen === "booking"} class:onboarding-shell={screen === "home" && !org}>
  {#if screen !== "booking" && !(screen === "home" && !org)}
    <Sidebar {screen} {stepCount} onNavigate={goto} />
  {/if}

  <div class="main-area">
    {#if screen === "booking"}
      <PublicHeader onBack={() => goto("home")} />
    {:else if screen === "home" && !org}
      <OnboardingHeader />
    {:else}
      <Topbar {screen} bind:preview canCreateBooking={!!org} onNavigate={goto} />
    {/if}

    <main class="content" class:public-content={screen === "booking"}>
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
          <OnboardingScreen
            {organizationName}
            onOrganizationNameChange={(value) => organizationName = value}
            onCreateOrganization={() => void createOrganization()}
          />
        {:else}
          <OwnerOverview
            organizationName={org.name}
            {data}
            {stepCount}
            {calendarDate}
            {dayBookings}
            getService={getService}
            getStaff={getStaff}
            onNavigate={goto}
          />
        {/if}
      {:else if !org}
        <section class="state-card"><span class="state-illustration">✳</span><h2>Сначала создайте тестовый салон</h2><p>После этого откроются услуги, команда, графики и календарь.</p><button class="btn btn-primary" onclick={() => goto("home")}>К созданию салона →</button></section>
      {:else if screen === "services"}
        <div class="section-head"><div><span class="eyebrow">КАТАЛОГ САЛОНА</span><h1>Услуги и цены</h1><p>Единая длительность и базовая цена на уровне организации.</p></div><span class="counter-pill">{data.services.length} услуг</span></div>
        <div class="workspace-grid"><section class="card"><div class="card-title"><div><span class="eyebrow">КАТАЛОГ</span><h2>Ваши услуги</h2></div></div>
          {#if data.services.length === 0}<div class="empty-mini"><span>◇</span><strong>Здесь появятся услуги</strong><p>Добавьте услугу через форму создания.</p></div>{:else}
            <div class="list-items">{#each data.services as service}<div class="entity-row"><span class="service-tile">✳</span><div class="entity-text"><strong>{service.name}</strong><small>{service.durationMinutes} мин · единая длительность</small></div><strong class="price-label">{money(service.basePriceRub)}</strong></div>{/each}</div>
          {/if}
        </section>
        <ServiceForm
            {serviceName}
            {serviceDuration}
            {servicePrice}
            onNameChange={(value) => serviceName = value}
            onDurationChange={(value) => serviceDuration = value}
            onPriceChange={(value) => servicePrice = value}
            onSubmit={() => void createService()}
          /></div>
      {:else if screen === "staff"}
        <div class="section-head"><div><span class="eyebrow">ВАША КОМАНДА</span><h1>Мастера</h1><p>Профили и услуги мастеров. Доступы и права здесь не назначаются.</p></div><span class="counter-pill">{data.staff.length} специалистов</span></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">КОМАНДА</span><h2>Специалисты салона</h2>
          {#if data.staff.length === 0}<div class="empty-mini"><span>♧</span><strong>Команда пока пуста</strong><p>Добавьте мастера с синтетическим именем.</p></div>{:else}
            <div class="list-items">{#each data.staff as member}<div class="entity-row"><span class="staff-avatar">{member.displayName.slice(0, 1)}</span><div class="entity-text"><strong>{member.displayName}</strong><small>{member.positionTitle} · {member.serviceIds.map(getService).join(", ")}</small></div><span class="status-pill">Демо</span></div>{/each}</div>
          {/if}
        </section>
        <StaffForm
            services={data.services}
            {staffName}
            {staffTitle}
            {staffService}
            onNameChange={(value) => staffName = value}
            onTitleChange={(value) => staffTitle = value}
            onServiceChange={(value) => staffService = value}
            onOpenServices={() => goto("services")}
            onSubmit={() => void createStaff()}
          /></div>
      {:else if screen === "schedule"}
        <div class="section-head"><div><span class="eyebrow">РАБОЧЕЕ ВРЕМЯ</span><h1>Расписание</h1><p>Настройка шаблона рабочих дней для тестового мастера и филиала.</p></div></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">ТЕКУЩИЕ ГРАФИКИ</span><h2>Рабочие недели</h2>
          {#if data.schedules.length === 0}<div class="empty-mini"><span>◷</span><strong>График не задан</strong><p>Добавьте расписание, чтобы появились демо-слоты.</p></div>{:else}
            {#each data.schedules as schedule}<div class="schedule-summary"><div class="schedule-icon">◷</div><div><strong>{getStaff(schedule.staffId)}</strong><p>{getLocation(schedule.locationId)} · {schedule.startsAt}–{schedule.endsAt}</p><div class="weekday-chips">{#each weekdays as day}<span class:chosen={schedule.weekdays.includes(day.number)}>{day.name}</span>{/each}</div></div></div>{/each}
          {/if}
          <div class="inline-note">Изменения расписания не пересчитывают существующие записи. В production конфликты, права и занятость проверяет сервер.</div>
        </section>
        <ScheduleForm
            staff={data.staff}
            locations={data.locations}
            {scheduleStaff}
            {scheduleLocation}
            {scheduleDays}
            {scheduleStart}
            {scheduleEnd}
            onStaffChange={(value) => scheduleStaff = value}
            onLocationChange={(value) => scheduleLocation = value}
            onToggleWeekday={toggleWeekday}
            onStartChange={(value) => scheduleStart = value}
            onEndChange={(value) => scheduleEnd = value}
            onOpenStaff={() => goto("staff")}
            onSubmit={() => void saveSchedule()}
          /></div>
      {:else if screen === "locations"}
        <div class="section-head"><div><span class="eyebrow">СТРУКТУРА САЛОНА</span><h1>Филиалы</h1><p>Синтетические адреса для демонстрации переключения локаций.</p></div></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">ЛОКАЦИИ</span><h2>Филиалы организации</h2>
          <div class="list-items">{#each data.locations as location}<div class="entity-row"><span class="service-tile">⌂</span><div class="entity-text"><strong>{location.name}</strong><small>{location.address}</small></div><span class="status-pill">Демо</span></div>{/each}</div>
        </section>
        <LocationForm
            {locationName}
            {locationAddress}
            onNameChange={(value) => locationName = value}
            onAddressChange={(value) => locationAddress = value}
            onSubmit={() => void createLocation()}
          /></div>
      {:else if screen === "calendar"}
        <CalendarView
          bookings={data.bookings}
          bind:calendarDate
          bind:calendarMode
          serviceName={getService}
          staffName={getStaff}
          locationName={getLocation}
          onCreateBooking={() => goto("booking")}
        />
      {:else if screen === "booking"}
        <section class="booking-head booking-hero" aria-label="Онлайн-запись">
          <div class="booking-hero-copy">
            <span class="booking-hero-section">Cookie / запись к мастеру</span>
            <h1>Время для себя.<br /><em>В вашем ритме.</em></h1>
            <p>Выберите услугу, мастера и удобное время. Остальное мы уже собрали в одном месте.</p>
          </div>
          <div class="booking-hero-studio">
            <div class="hero-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <span>Ваша студия</span>
            <strong>{org.name}</strong>
            <small>Демонстрационная запись</small>
          </div>
        </section>
        {#if createdBooking}
          <section class="card success-screen"><div class="success-symbol">✓</div><span class="eyebrow">ЗАПИСЬ СОЗДАНА ЛОКАЛЬНО</span><h2>Готово! Это демо-запись.</h2><p>Запись сохранена только в браузерной сессии. Она <strong>не подтверждена backend</strong> и не резервирует время у мастера.</p>
            <div class="success-receipt"><div><span>Услуга</span><strong>{getService(createdBooking.serviceId)}</strong></div><div><span>Дата и время</span><strong>{longDate(createdBooking.date)}, {createdBooking.time}</strong></div><div><span>Мастер</span><strong>{getStaff(createdBooking.staffId)}</strong></div><div><span>Демо-ID</span><strong class="mono">{createdBooking.id.slice(0, 8)}</strong></div></div>
            <div class="button-row"><button class="btn btn-primary" onclick={() => { calendarDate = createdBooking!.date; goto("calendar"); }}>Посмотреть в календаре →</button><button class="btn btn-secondary" onclick={() => goto("booking")}>Ещё одна демо-запись</button></div>
          </section>
        {:else}
          <BookingForm
            {data}
            staffOptions={bookingStaffOptions}
            {bookingService}
            {bookingStaff}
            {bookingLocation}
            {bookingDate}
            {bookingTime}
            {clientAlias}
            {busySlots}
            {slotSuggestions}
            {canBook}
            staffName={getStaff}
            onServiceChange={syncStaffSelection}
            onLocationChange={(value) => { bookingLocation = value; void loadSlots(); }}
            onStaffChange={(value) => { bookingStaff = value; void loadSlots(); }}
            onDateChange={(value) => { bookingDate = value; void loadSlots(); }}
            onTimeChange={(value) => bookingTime = value}
            onAliasChange={(value) => clientAlias = value}
            onSubmit={() => void submitBooking()}
          />
          {#if data.services.length === 0 || data.staff.length === 0 || data.schedules.length === 0}<div class="setup-shortcut"><span>Для полного сценария сначала создайте услугу, мастера и график.</span><button class="btn btn-secondary" onclick={() => goto(currentOnboardingStep === "services" ? "services" : currentOnboardingStep === "staff" ? "staff" : "schedule")}>Продолжить настройку →</button></div>{/if}
        {/if}
      {/if}

      {#if !initializing}<footer class="footer"><span>Cookie · frontend preview · запись не отправляется на сервер</span>{#if screen !== "booking"}<button type="button" onclick={() => void resetDemo()} disabled={busy}>Сбросить демо-данные</button>{/if}</footer>{/if}
    </main>
  </div>
</div>
