<script lang="ts">
  import { onMount } from "svelte";
  import { createCookieUiApi } from "./lib/api";
  import { localDay, upcomingWeekday } from "./lib/dates";
  import { UiFailure } from "./lib/model";
  import type { BookingView, DemoSnapshot, SlotView, ViewState } from "./lib/model";
  import type { Screen } from "./lib/navigation";
  import Sidebar from "./lib/ui/Sidebar.svelte";
  import Topbar from "./lib/ui/Topbar.svelte";
  import PublicHeader from "./lib/ui/PublicHeader.svelte";
  import OnboardingHeader from "./lib/ui/OnboardingHeader.svelte";
  import OnboardingScreen from "./lib/ui/OnboardingScreen.svelte";
  import OwnerOverview from "./lib/ui/OwnerOverview.svelte";
  import OwnerServicesPage from "./lib/ui/OwnerServicesPage.svelte";
  import OwnerStaffPage from "./lib/ui/OwnerStaffPage.svelte";
  import OwnerSchedulePage from "./lib/ui/OwnerSchedulePage.svelte";
  import OwnerLocationsPage from "./lib/ui/OwnerLocationsPage.svelte";
  import BookingConfirmation from "./lib/ui/BookingConfirmation.svelte";
  import PublicBookingHero from "./lib/ui/PublicBookingHero.svelte";
  import DemoFooter from "./lib/ui/DemoFooter.svelte";
  import DemoNotices from "./lib/ui/DemoNotices.svelte";
  import BookingSetupHint from "./lib/ui/BookingSetupHint.svelte";
  import DemoState from "./lib/ui/DemoState.svelte";
  import OwnerAuthGate from "./lib/ui/OwnerAuthGate.svelte";
  import {
    authenticateTelegramOwner,
    loadTelegramInitData,
    revokeTelegramOwnerSession,
    type VerifiedOwnerSession,
  } from "./lib/owner-auth";
  import CalendarView from "./lib/ui/CalendarView.svelte";
  import BookingForm from "./lib/ui/BookingForm.svelte";
  import "./styles.css";
  import "./visual-system.css";

  const api = createCookieUiApi();
  // Presentation-only Telegram-sized preview; no Telegram API, initData or auth.
  const telegramPreview = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("surface") === "telegram-preview";
  const blank: DemoSnapshot = { organization: null, locations: [], services: [], staff: [], schedules: [], bookings: [] };

  let screen: Screen = "home";
  let data: DemoSnapshot = blank;
  let initializing = true;
  let apiDisconnected = false;
  let ownerSession: VerifiedOwnerSession | null = null;
  let ownerAuthPhase: "unavailable" | "loading" | "verified" | "error" | "signing-out" | "signed-out" | "logout-failed" = "unavailable";
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
  let calendarMode: "day" | "week" = typeof window !== "undefined" && window.innerWidth <= 900 ? "day" : "week";

  $: org = data.organization;
  $: stepCount = Number(!!org) + Number(data.services.length > 0) +
    Number(data.staff.length > 0) + Number(data.schedules.length > 0) +
    Number(data.bookings.length > 0);
  $: dayBookings = data.bookings.filter(item => item.date === calendarDate && item.status === "demo-confirmed");
  $: bookingStaffOptions = data.staff.filter(item => !bookingService || item.serviceIds.includes(bookingService));
  $: canBook = Boolean(bookingService && bookingStaff && bookingLocation && bookingDate && bookingTime && clientAlias.trim());
  $: currentOnboardingStep = !org ? "organization" : !data.services.length ? "services" :
    !data.staff.length ? "staff" : !data.schedules.length ? "schedule" :
    !data.bookings.length ? "booking" : "complete";

  onMount(() => {
    void reload();
    if (api.mode === "api") void authenticateOwner();
  });

  async function authenticateOwner(): Promise<void> {
    ownerAuthPhase = "loading";
    const initData = await loadTelegramInitData(window, document);
    if (!initData) {
      ownerAuthPhase = "unavailable";
      return;
    }
    try {
      ownerSession = await authenticateTelegramOwner(initData);
      ownerAuthPhase = "verified";
    } catch {
      ownerSession = null;
      ownerAuthPhase = "error";
    }
  }

  async function logoutOwner(): Promise<void> {
    const session = ownerSession;
    if (!session || ownerAuthPhase !== "verified") return;
    // Discard the bearer immediately; even failed remote revocation cannot
    // restore any owner permissions in the current browser session.
    ownerSession = null;
    ownerAuthPhase = "signing-out";
    try {
      await revokeTelegramOwnerSession(session);
      ownerAuthPhase = "signed-out";
    } catch {
      ownerAuthPhase = "logout-failed";
    }
  }

  function describe(errorValue: unknown): string {
    return errorValue instanceof Error ? errorValue.message : "Не удалось выполнить действие. Повторите попытку.";
  }
  async function reload(): Promise<void> {
    try {
      data = await api.getSnapshot();
      apiDisconnected = false;
      if (!staffService) staffService = data.services[0]?.id ?? "";
      if (!scheduleStaff) scheduleStaff = data.staff[0]?.id ?? "";
      if (!scheduleLocation) scheduleLocation = data.locations[0]?.id ?? "";
      if (!bookingService) bookingService = data.services[0]?.id ?? "";
      if (!bookingLocation) bookingLocation = data.locations[0]?.id ?? "";
      if (!bookingStaff) bookingStaff = data.staff[0]?.id ?? "";
    } catch (reason) {
      if (api.mode === "api" && reason instanceof UiFailure && reason.code === "NOT_CONNECTED") {
        apiDisconnected = true;
        error = "";
      } else {
        error = describe(reason);
      }
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
  async function readDemoRescheduleSlots(id: string, date: string): Promise<SlotView[]> {
    const booking = data.bookings.find((item) => item.id === id);
    if (!booking || booking.status !== "demo-confirmed") {
      throw new UiFailure("NOT_FOUND", "Демо-запись недоступна.");
    }
    const slots = await api.getSlotSuggestions(booking.staffId, booking.locationId, date);
    return slots.filter((slot) => !data.bookings.some(
      (item) =>
        item.id !== id &&
        item.status === "demo-confirmed" &&
        item.staffId === booking.staffId &&
        item.date === date &&
        item.time === slot.time,
    ));
  }
  async function rescheduleDemoBooking(id: string, date: string, time: string): Promise<void> {
    await api.rescheduleBooking(id, date, time);
    calendarDate = date;
    await reload();
    notice = "Демо-запись перенесена только в этой вкладке. Backend не изменялся.";
  }
  async function cancelDemoBooking(id: string): Promise<void> {
    await api.cancelBooking(id);
    await reload();
    notice = "Демо-запись отменена локально; запись сохранена в истории.";
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
  <title>{apiDisconnected ? "Cookie — вход владельца" : screen === "booking" ? "Cookie — онлайн-запись · демо" : "Cookie — кабинет салона · демо"}</title>
  <meta name="description" content={api.mode === "api" ? "Cookie: тестовое подключение Backend API пока недоступно." : "Cookie: интерактивный демонстрационный интерфейс салона с синтетическими данными."} />
</svelte:head>

<div class="app-shell" class:public-shell={screen === "booking"} class:onboarding-shell={screen === "home" && !org} class:telegramPreview={telegramPreview && screen === "booking"}>
  {#if screen !== "booking" && !(screen === "home" && !org)}
    <Sidebar {screen} {stepCount} onNavigate={goto} />
  {/if}

  <div class="main-area">
    {#if screen === "booking"}
      <PublicHeader organizationName={org?.name ?? "Тестовый салон"} {telegramPreview} onBack={() => goto("home")} />
    {:else if screen === "home" && !org}
      <OnboardingHeader apiMode={apiDisconnected} />
    {:else}
      <Topbar {screen} bind:preview canCreateBooking={!!org} onNavigate={goto} />
    {/if}

    <main class="content" class:public-content={screen === "booking"}>
      <DemoNotices
        {error} {notice}
        onDismissError={() => error = ""}
        onDismissNotice={() => notice = ""}
      />
      {#if apiDisconnected}
        <OwnerAuthGate phase={ownerAuthPhase} onLogout={() => void logoutOwner()} />
      {:else if initializing || busy}
        <div class="loading-card" role="status"><div class="spinner"></div><span>{initializing ? "Загружаем демо-пространство…" : "Обновляем данные в браузерной сессии…"}</span></div>
      {:else if preview === "error"}
        <DemoState kind="error" onPrimary={() => preview = "normal"} />
      {:else if preview === "forbidden"}
        <DemoState kind="forbidden" onPrimary={() => preview = "normal"} />
      {:else if preview === "empty"}
        <DemoState kind="empty" onPrimary={() => preview = "normal"} />
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
        <DemoState kind="setup" onPrimary={() => goto("home")} />
      {:else if screen === "services"}
        <OwnerServicesPage
          {data} {serviceName} {serviceDuration} {servicePrice}
          onNameChange={(value) => serviceName = value}
          onDurationChange={(value) => serviceDuration = value}
          onPriceChange={(value) => servicePrice = value}
          onSubmit={() => void createService()}
        />
      {:else if screen === "staff"}
        <OwnerStaffPage
          {data} {staffName} {staffTitle} {staffService}
          getService={getService}
          onNameChange={(value) => staffName = value}
          onTitleChange={(value) => staffTitle = value}
          onServiceChange={(value) => staffService = value}
          onOpenServices={() => goto("services")}
          onSubmit={() => void createStaff()}
        />
      {:else if screen === "schedule"}
        <OwnerSchedulePage
          {data} {scheduleStaff} {scheduleLocation} {scheduleDays} {scheduleStart} {scheduleEnd}
          getStaff={getStaff} getLocation={getLocation}
          onStaffChange={(value) => scheduleStaff = value}
          onLocationChange={(value) => scheduleLocation = value}
          onToggleWeekday={toggleWeekday}
          onStartChange={(value) => scheduleStart = value}
          onEndChange={(value) => scheduleEnd = value}
          onOpenStaff={() => goto("staff")}
          onSubmit={() => void saveSchedule()}
        />
      {:else if screen === "locations"}
        <OwnerLocationsPage
          {data} {locationName} {locationAddress}
          onNameChange={(value) => locationName = value}
          onAddressChange={(value) => locationAddress = value}
          onSubmit={() => void createLocation()}
        />
      {:else if screen === "calendar"}
        <CalendarView
          bookings={data.bookings}
          services={data.services}
          staff={data.staff}
          bind:calendarDate
          bind:calendarMode
          serviceName={getService}
          staffName={getStaff}
          locationName={getLocation}
          onCreateBooking={() => goto("booking")}
          onReadRescheduleSlots={readDemoRescheduleSlots}
          onRescheduleBooking={rescheduleDemoBooking}
          onCancelBooking={cancelDemoBooking}
        />
      {:else if screen === "booking"}
        {#if createdBooking}
          <BookingConfirmation
            booking={createdBooking}
            location={data.locations.find((item) => item.id === createdBooking?.locationId)}
            serviceName={getService}
            staffName={getStaff}
            onOpenCalendar={() => { calendarDate = createdBooking!.date; goto("calendar"); }}
            onCreateAnother={() => goto("booking")}
          />
        {:else}
          <PublicBookingHero organizationName={org.name} />
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
          {#if data.services.length === 0 || data.staff.length === 0 || data.schedules.length === 0}
            <BookingSetupHint
              onContinueSetup={() => goto(currentOnboardingStep === "services" ? "services" : currentOnboardingStep === "staff" ? "staff" : "schedule")}
            />
          {/if}
        {/if}
      {/if}

      {#if !initializing && api.mode === "mock"}
        <DemoFooter showReset={screen !== "booking"} {busy} onReset={() => void resetDemo()} />
      {/if}
    </main>
  </div>
</div>
