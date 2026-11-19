<script lang="ts">
  import { onDestroy } from "svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import {
    ActionButton,
    Avatar,
    CheckGroup,
    ImageAssetField,
    Notice,
    Modal,
    Navigation,
    BookingTicket,
    ChoiceRow,
    EmptyState,
    EntityEditor,
    RecordRow,
    Segment,
    TextField,
    ThemeScope,
    VisitRow,
    type RhythmPreviewTheme,
    type SegmentOption,
  } from "$lib/components/rhythm/index.js";

  const themes: readonly { id: RhythmPreviewTheme; label: string }[] = [
    { id: "workspace", label: "Кабинет" },
    { id: "studio", label: "Студия" },
    { id: "linen", label: "Лён" },
    { id: "graphite", label: "Графит" },
    { id: "sage", label: "Шалфей" },
  ];
  const sections: readonly SegmentOption[] = [
    { id: "controls", label: "Контролы" },
    { id: "catalog", label: "Каталог" },
    { id: "visits", label: "Записи" },
    { id: "forms", label: "Редакторы" },
    { id: "feedback", label: "Состояния" },
  ];

  let theme = $state<RhythmPreviewTheme>("workspace");
  let section = $state("controls");
  let service = $state("haircut");
  let specialist = $state("anna");
  let filter = $state("upcoming");
  let name = $state("Студия S.");
  let formName = $state("Стрижка");
  let showError = $state(false);
  let busy = $state(false);
  let message = $state("");
  let showDetails = $state(false);
  let activeNav = $state("calendar");
  let dialogOpen = $state(false);
  let sheetOpen = $state(false);
  let drawerOpen = $state(false);
  const navOptions = [
    { id: "calendar", label: "Календарь" },
    { id: "visits", label: "Записи" },
    { id: "account", label: "Профиль" },
  ];
  let assignments = $state<string[]>(["haircut"]);
  let imageSrc = $state<string | undefined>();
  let imageError = $state<string | undefined>();

  function removeImage() {
    if (imageSrc) URL.revokeObjectURL(imageSrc);
    imageSrc = undefined;
  }

  function previewFile(file: File) {
    imageError = undefined;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      imageError = "Для учебного примера выберите PNG, JPEG или WebP до 2 МБ.";
      return;
    }
    removeImage();
    imageSrc = URL.createObjectURL(file);
  }

  onDestroy(removeImage);

  function reset() {
    service = "haircut";
    specialist = "anna";
    filter = "upcoming";
    name = "Студия S.";
    formName = "Стрижка";
    showError = false;
    busy = false;
    message = "";
    showDetails = false;
    activeNav = "calendar";
    dialogOpen = false;
    sheetOpen = false;
    drawerOpen = false;
    assignments = ["haircut"];
    removeImage();
    imageError = undefined;
  }
</script>

<ThemeScope {theme}>
  <main class="catalog-shell">
    <header class="catalog-header">
      <div>
        <p class="catalog-brand">kuki</p>
        <h1>Rhythm UI Kit</h1>
        <p class="rhythm-muted">Внутренний каталог компонентов · RC7.1 · учебные данные</p>
      </div>
      <ActionButton onclick={reset}>Сбросить примеры</ActionButton>
    </header>

    <div class="catalog-nav rhythm-stack">
      <Segment
        label="Разделы каталога"
        options={sections}
        selected={section}
        onSelect={(id) => {
          section = id;
          message = "";
        }}
      />
      <div class="theme-picker rhythm-field">
        <label for="theme">Пресет оформления</label>
        <select id="theme" bind:value={theme}>
          {#each themes as item (item.id)}
            <option value={item.id}>{item.label}</option>
          {/each}
        </select>
      </div>
    </div>

    <section class="catalog-content rhythm-stack" aria-label="Примеры компонентов">
      {#if section === "controls"}
        <h2>Контролы и состояния</h2>
        <div class="rhythm-panel rhythm-stack">
          <h3>ActionButton · существующий shadcn-svelte Button</h3>
          <div class="catalog-actions">
            <ActionButton tone="primary" onclick={() => (message = "Основное действие")}>Продолжить</ActionButton>
            <ActionButton onclick={() => (message = "Вторичное действие")}>Отмена</ActionButton>
            <ActionButton tone="danger" onclick={() => (message = "Опасное действие — пример")}>Удалить</ActionButton>
            <ActionButton tone="primary" disabled>Недоступно</ActionButton>
          </div>
        </div>
        <div class="rhythm-panel rhythm-stack">
          <h3>TextField · Input + label</h3>
          <TextField id="catalog-name" label="Название салона" bind:value={name} required hint="Только учебные данные." error={showError ? "Проверьте значение." : undefined} />
          <ActionButton onclick={() => (showError = !showError)}>Переключить ошибку</ActionButton>
          <TextField id="catalog-disabled" label="Недоступное поле" value="Сохранено" disabled />
        </div>
        <div class="rhythm-panel rhythm-stack">
          <h3>Segment · фильтр</h3>
          <Segment label="Состояние записей" options={[{ id: "upcoming", label: "Предстоящие" }, { id: "past", label: "Прошедшие" }, { id: "archive", label: "Архив", disabled: true }]} selected={filter} onSelect={(id) => (filter = id)} />
          <p class="rhythm-muted">Текущий фильтр: {filter === "upcoming" ? "Предстоящие" : "Прошедшие"}</p>
        </div>
        <div class="rhythm-panel rhythm-stack">
          <h3>Navigation · общие пункты меню</h3>
          <Navigation label="Боковое меню" items={navOptions} current={activeNav} onNavigate={(id) => (activeNav = id)} />
          <Navigation label="Компактное меню" layout="bar" items={navOptions} current={activeNav} onNavigate={(id) => (activeNav = id)} />
        </div>
      {:else if section === "catalog"}
        <h2>Выбор услуги и мастера</h2>
        <div class="rhythm-stack">
          <h3>Услуги</h3>
          <div>
            <ChoiceRow title="Стрижка" description="60 минут" trailing="2 400 ₽" selected={service === "haircut"} onSelect={() => (service = "haircut")} />
            <ChoiceRow title="Укладка" description="45 минут" trailing="1 800 ₽" selected={service === "style"} onSelect={() => (service = "style")} />
            <ChoiceRow title="Окрашивание" description="Нет доступных специалистов" trailing="от 4 500 ₽" disabled onSelect={() => {}} />
          </div>
          <h3>Мастера</h3>
          <ChoiceRow title="Анна" description="Стилист · 60 минут" trailing="2 400 ₽" variant="option" selected={specialist === "anna"} onSelect={() => (specialist = "anna")}>
            {#snippet leading()}<Avatar initials="А" />{/snippet}
          </ChoiceRow>
          <ChoiceRow title="Мария" description="Старший стилист · 60 минут" trailing="2 800 ₽" variant="option" selected={specialist === "maria"} onSelect={() => (specialist = "maria")}>
            {#snippet leading()}<Avatar initials="М" />{/snippet}
          </ChoiceRow>
        </div>
      {:else if section === "visits"}
        <h2>Записи и справочники</h2>
        <div class="rhythm-stack">
          <h3>VisitRow · общий вид</h3>
          <VisitRow visit={{ time: "12:00", title: "Стрижка", subtitle: "Анна · 60 минут", status: "Подтверждена", amountLabel: "2 400 ₽" }} onOpen={() => (showDetails = !showDetails)} />
          <VisitRow visit={{ time: "14:30", title: "Укладка", subtitle: "Мария · 45 минут", status: "Отменена", amountLabel: "1 800 ₽" }} />
          {#if showDetails}
            <BookingTicket lines={[{ label: "Услуга", value: "Стрижка" }, { label: "Мастер", value: "Анна" }, { label: "Время", value: "12:00" }]} priceLabel="2 400 ₽" priceNote="Учебный снимок цены, не серверное подтверждение." />
          {/if}
          <h3>RecordRow · справочник</h3>
          <RecordRow record={{ title: "Анна", subtitle: "Стилист", initials: "А", detail: "Активна" }}>
            {#snippet action()}
              <ActionButton onclick={() => (message = "Редактирование — учебный пример")}>Изменить</ActionButton>
            {/snippet}
          </RecordRow>
          <RecordRow record={{ title: "Укладка", subtitle: "45 минут", detail: "1 800 ₽" }} />
        </div>
      {:else if section === "forms"}
        <h2>Общая форма редактирования</h2>
        <EntityEditor
          title="Услуга"
          description="Контейнер формы не знает бизнес-правил."
          {busy}
          onSubmit={() => (message = "Значение сохранено в учебном состоянии")}
          onCancel={() => {
            formName = "Стрижка";
            message = "Изменения сброшены";
          }}
        >
          <TextField id="catalog-service" label="Название" bind:value={formName} required disabled={busy} />
          <CheckGroup label="Назначенные услуги" options={[{ id: "haircut", label: "Стрижка" }, { id: "style", label: "Укладка" }, { id: "color", label: "Окрашивание", disabled: true }]} selected={assignments} disabled={busy} onChange={(ids) => (assignments = ids)} />
        </EntityEditor>
        <ActionButton onclick={() => (busy = !busy)}>Переключить состояние сохранения</ActionButton>
        <div class="rhythm-panel rhythm-stack">
          <h3>ImageAssetField</h3>
          <ImageAssetField id="catalog-image" label="Фотография мастера" {imageSrc} error={imageError} hint="Только локальный предпросмотр. Файл не покидает браузер." onFile={previewFile} onRemove={removeImage} />
        </div>
      {:else}
        <h2>Обратная связь</h2>
        <div class="rhythm-panel rhythm-stack">
          <h3>Modal · единый компонент</h3>
          <div class="catalog-actions">
            <Modal bind:open={dialogOpen} title="Подтверждение" description="Пример действия без обращения к серверу." triggerLabel="Открыть диалог">
              <p>Проверьте сведения перед продолжением.</p>
              {#snippet actions()}
                <ActionButton tone="primary" onclick={() => { dialogOpen = false; message = "Подтверждено в учебном примере"; }}>Подтвердить</ActionButton>
              {/snippet}
            </Modal>
            <Modal bind:open={sheetOpen} layout="sheet" title="Детали записи" description="Боковая панель." triggerLabel="Открыть панель">
              <BookingTicket lines={[{ label: "Услуга", value: "Стрижка" }, { label: "Время", value: "12:00" }]} />
            </Modal>
            <Modal bind:open={drawerOpen} layout="drawer" title="Выбор времени" description="Нижняя панель." triggerLabel="Открыть нижнюю панель">
              <ChoiceRow title="12:00" description="60 минут" selected onSelect={() => (drawerOpen = false)} />
            </Modal>
          </div>
        </div>
        <Notice title="Загрузка данных" description="Учебный пример ожидания." tone="loading" />
        <Notice title="Изменения сохранены" description="Учебное состояние." tone="success" />
        <Notice title="Не удалось загрузить данные" description="Повторите попытку." tone="error">
          {#snippet action()}<ActionButton onclick={() => (message = "Повторная попытка — учебный пример")}>Повторить</ActionButton>{/snippet}
        </Notice>
        <div class="rhythm-panel rhythm-stack">
          <h3>Badge · существующий shadcn-svelte</h3>
          <div class="catalog-actions">
            <Badge variant="secondary">Подтверждена</Badge>
            <Badge variant="outline">Отменена</Badge>
          </div>
        </div>
        <div class="rhythm-panel">
          <EmptyState title="Нет записей" description="Новые визиты появятся здесь." actionLabel="Сбросить фильтр" onAction={() => (message = "Фильтр сброшен")} />
        </div>
      {/if}
      <p role="status" class="rhythm-muted">{message}</p>
    </section>
  </main>
</ThemeScope>

<style>
  .catalog-shell {
    width: min(100%, 920px);
    margin: 0 auto;
    min-height: 100dvh;
    padding: 32px 24px;
  }
  .catalog-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 24px;
  }
  .catalog-brand {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.05em;
    margin-bottom: 8px;
  }
  h1 {
    font-family: Georgia, serif;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.15;
    margin-bottom: 8px;
  }
  h2 {
    font-size: 22px;
    font-weight: 650;
  }
  h3 {
    font-size: 15px;
    font-weight: 650;
  }
  .catalog-content {
    margin-top: 24px;
    gap: 16px;
  }
  .catalog-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .theme-picker select {
    width: 100%;
    min-height: 42px;
    border: 1px solid var(--rhythm-line);
    border-radius: var(--rhythm-radius);
    background: var(--rhythm-canvas);
    color: var(--rhythm-ink);
    padding: 8px 12px;
    font-size: 16px;
  }
  @media (max-width: 440px) {
    .catalog-shell {
      padding: 20px 12px;
    }
  }
</style>
