<script lang="ts">
  import {
    AccountMenu, ActionButton, BookingLayout, BookingTicket, ChoiceList,
    DateStrip, PublicHeader, ResourceDay, SalonPage, ScheduleRow, Segment,
    SlotGrid, type BookingStep, type ChoiceItem, type DayOption,
    type ResourceGroup, type SegmentOption,
  } from "$lib/components/rhythm/index.js";

  let { section }: { section: "public" | "calendar" | "account" } = $props();

  const services: readonly ChoiceItem[] = [
    { id: "cut", title: "Стрижка", description: "60 минут", detail: "2 400 ₽" },
    { id: "style", title: "Укладка", description: "45 минут", detail: "1 800 ₽" },
    { id: "color", title: "Окрашивание", description: "Нет доступных мастеров", detail: "от 4 500 ₽", disabled: true },
  ];
  const staff: readonly ChoiceItem[] = [
    { id: "a", title: "Анна", description: "Стилист", initials: "А", detail: "2 400 ₽" },
    { id: "m", title: "Мария", description: "Старший стилист", initials: "М", detail: "2 800 ₽" },
  ];
  const days: readonly DayOption[] = [
    { id: "23", label: "23 ноября, понедельник", weekday: "Пн", day: "23" },
    { id: "24", label: "24 ноября, вторник", weekday: "Вт", day: "24" },
    { id: "25", label: "25 ноября, среда", weekday: "Ср", day: "25", disabled: true },
    { id: "26", label: "26 ноября, четверг", weekday: "Чт", day: "26" },
    { id: "27", label: "27 ноября, пятница", weekday: "Пт", day: "27" },
    { id: "28", label: "28 ноября, суббота", weekday: "Сб", day: "28" },
    { id: "29", label: "29 ноября, воскресенье", weekday: "Вс", day: "29" },
  ];
  const slots: readonly SegmentOption[] = [
    { id: "10", label: "10:00" },
    { id: "11", label: "11:00", disabled: true },
    { id: "12", label: "12:00" },
    { id: "15", label: "15:00" },
  ];
  const resources: readonly ResourceGroup[] = [
    { id: "a", label: "Анна", shiftLabel: "09:00–18:00", visits: [{ id: "v1", time: "10:00", title: "Стрижка", subtitle: "60 минут", status: "Подтверждена", amountLabel: "2 400 ₽" }] },
    { id: "m", label: "Мария", shiftLabel: "12:00–20:00", visits: [{ id: "v2", time: "14:00", title: "Укладка", subtitle: "45 минут", status: "Подтверждена", amountLabel: "1 800 ₽" }] },
    { id: "o", label: "Ольга", shiftLabel: "Выходной", visits: [] },
  ];
  const accounts = [
    { id: "personal", title: "Личный профиль", subtitle: "Мои записи", initials: "Л" },
    { id: "owner", title: "Студия S.", subtitle: "Владелец", initials: "S" },
    { id: "staff", title: "Студия M.", subtitle: "Мастер", initials: "M" },
  ];
  const channels = [
    { id: "web", label: "Сайт" }, { id: "embed", label: "Виджет" },
    { id: "telegram", label: "Mini App" }, { id: "manual", label: "Ручная запись" },
  ] as const;
  const stepLabels = [
    { id: "service", label: "Услуга" },
    { id: "staff", label: "Мастер" },
    { id: "time", label: "Время" },
    { id: "review", label: "Проверка" },
  ];
  let channel = $state<"web" | "embed" | "telegram" | "manual">("web");
  let surface = $state<"salon" | "booking">("salon");
  let step = $state(0);
  let service = $state<string>();
  let member = $state<string>();
  let date = $state<string>();
  let slot = $state<string>();
  let account = $state("owner");
  let calendarDay = $state("23");
  let status = $state("");
  let staffFirst = $state(false);
  let compact = $state(false);
  const current = $derived(stepLabels[step]?.id ?? "service");
  const steps = $derived<BookingStep[]>(stepLabels.map((item, index) => ({
    ...item, reachable: index <= step, complete: index < step,
  })));
  const selection = $derived(services.find((item) => item.id === service));
  const master = $derived(staff.find((item) => item.id === member));
  const selectedSlot = $derived(slots.find((item) => item.id === slot));
  const nextDisabled = $derived(
    step === 0 ? !service : step === 1 ? !member : step === 2 ? !date || !slot : false,
  );

  function start(id?: string) {
    service = id;
    member = undefined;
    date = undefined;
    slot = undefined;
    step = id ? 1 : 0;
    status = "";
    surface = "booking";
  }

  function selectChannel(id: string) {
    const match = channels.find((item) => item.id === id);
    if (match) channel = match.id;
  }

  function next() {
    if (nextDisabled) return;
    if (step < 3) step += 1;
    else status = "Учебная проверка завершена. Реальная запись не создана.";
  }
</script>

{#snippet publicHeader()}
  <PublicHeader title="Студия S." subtitle="Санкт-Петербург" initials="S">
    {#snippet actions()}
      {#if surface === "booking"}<ActionButton onclick={() => { surface = "salon"; status = ""; }}>Страница салона</ActionButton>{/if}
      <AccountMenu label="Аккаунт" accounts={accounts} current={account} onSelect={(id) => (account = id)} />
    {/snippet}
  </PublicHeader>
{/snippet}

{#snippet ticket()}
  <BookingTicket
    title="Ваша запись"
    lines={[
      { label: "Услуга", value: selection?.title ?? "Не выбрана" },
      { label: "Мастер", value: master?.title ?? "Не выбран" },
      { label: "Дата", value: date ? date + " ноября" : "Не выбрана" },
      { label: "Время", value: selectedSlot?.label ?? "Не выбрано" },
    ]}
    priceLabel={master && service === "cut" ? master.detail : selection?.detail}
    priceNote="Учебное отображение, не серверная котировка."
  />
{/snippet}

{#if section === "public"}
  <h2 class="text-xl font-semibold">Публичные поверхности</h2>
  <Segment label="Канал" options={channels} selected={channel} onSelect={selectChannel} />
  <div class="rhythm-actions">
    <ActionButton onclick={() => { surface = "salon"; status = ""; }}>Салон</ActionButton>
    <ActionButton onclick={() => start()}>Запись</ActionButton>
    <ActionButton onclick={() => (staffFirst = !staffFirst)}>Порядок каталога</ActionButton>
    <ActionButton onclick={() => (compact = !compact)}>Композиция</ActionButton>
  </div>
  <div class="composition-preview" data-channel={channel}>
    {#if surface === "salon"}
      <SalonPage
        heading="Время для себя."
        intro="Стрижки, укладки и уход. Выберите услугу, мастера и удобное время."
        layout={compact ? "compact" : "cover"}
        primaryLabel="Выбрать услугу"
        {services}
        staff={staff.map((item) => ({ title: item.title, subtitle: item.description, initials: item.initials }))}
        {staffFirst}
        header={publicHeader}
        onStart={() => start()}
        onService={start}
      />
    {:else}
      <BookingLayout
        title={["Выберите услугу", "Выберите мастера", "Дата и время", "Проверьте запись"][step] ?? "Запись"}
        description="Один набор компонентов для всех каналов."
        {steps} {current} {channel}
        header={publicHeader}
        nextLabel={step === 3 ? "Подтвердить пример" : "Продолжить"}
        {nextDisabled}
        onNext={next}
        onStep={(id) => { const index = stepLabels.findIndex((item) => item.id === id); if (index >= 0 && index <= step) step = index; }}
      >
        {#if step === 0}
          <ChoiceList title="Услуги" items={services} selected={service} onSelect={(id) => { service = id; member = undefined; date = undefined; slot = undefined; }} />
        {:else if step === 1}
          <ChoiceList title="Мастера" items={staff.map((item) => ({ ...item, detail: service === "cut" ? item.detail : selection?.detail }))} selected={member} variant="option" onSelect={(id) => { member = id; date = undefined; slot = undefined; }} />
        {:else if step === 2}
          <DateStrip label="Дата визита" {days} selected={date} onSelect={(id) => { date = id; slot = undefined; }} />
          <SlotGrid label="Время визита" options={date ? slots : []} selected={slot} onSelect={(id) => (slot = id)} />
        {:else}
          <p>Перед подтверждением проверяются доступность и цена. В каталоге это только учебное состояние.</p>
        {/if}
        {#snippet summary()}{@render ticket()}{/snippet}
      </BookingLayout>
    {/if}
  </div>
{:else if section === "calendar"}
  <h2 class="text-xl font-semibold">Календарь и смены</h2>
  <DateStrip label="День календаря" {days} selected={calendarDay} onSelect={(id) => (calendarDay = id)} />
  <ResourceDay title={calendarDay + " ноября"} resources={calendarDay === "23" ? resources : resources.map((resource) => ({ ...resource, visits: [] }))} onOpen={(id) => (status = "Детали записи " + id)} />
  <h3 class="rhythm-subhead">Рабочий график</h3>
  <ScheduleRow schedule={{ label: "Анна", period: "09:00–18:00 · перерыв 13:00–14:00", status: "Смена" }} onEdit={() => (status = "Редактирование смены — учебный пример")} />
  <ScheduleRow schedule={{ label: "Ольга", period: "23 ноября", status: "Выходной" }} />
{:else}
  <h2 class="text-xl font-semibold">Единое меню аккаунта</h2>
  <AccountMenu label="Аккаунт" {accounts} current={account} onSelect={(id) => (account = id)} onProfile={() => (status = "Настройки профиля")} onLogout={() => (status = "Выход — учебный пример")} />
  <p class="rhythm-muted">Выбрано: {accounts.find((item) => item.id === account)?.title} · {accounts.find((item) => item.id === account)?.subtitle}</p>
{/if}
<p role="status" class="rhythm-muted">{status}</p>

<style>
  .composition-preview {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--rhythm-line);
    border-radius: var(--rhythm-panel-radius);
    background: var(--rhythm-canvas);
  }
  .composition-preview[data-channel="embed"],
  .composition-preview[data-channel="telegram"] {
    width: min(100%, 440px);
    margin: 0 auto;
  }
</style>
