<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import ActionButton from "../components/rhythm/ActionButton.svelte";
  import PageHeader from "../components/rhythm/PageHeader.svelte";
  import { onMount, tick } from "svelte";
  import RecordRow from "../components/rhythm/RecordRow.svelte";
  import EmptyState from "../components/rhythm/EmptyState.svelte";
  import Segment from "../components/rhythm/Segment.svelte";
  import ThemeScope from "../components/rhythm/ThemeScope.svelte";
  import { Input } from "../components/ui/input/index.js";
  import type { OwnerReads } from "../owner-reads";
  import OwnerReadPlaceholder from "./OwnerReadPlaceholder.svelte";
  import { Button } from "../components/ui/button/index.js";

  import type { VerifiedOwnerSession } from "../owner-auth";
  import {
    createRealService,
    editRealService,
    ServiceApiFailure,
    type RealService,
  } from "../services-api";
  import ServiceForm from "./ServiceForm.svelte";
  import { emptyRealServiceForm, realServiceDraftFromForm } from "../real-service-form";

  export let session: VerifiedOwnerSession;
  export let reads: OwnerReads;

  let editor: ServiceForm | undefined;

  let services: RealService[] = [];
  let query = "";
  let status: "all" | "active" | "draft" = "all";
  const statusOptions = [
    { id: "all", label: "Все" },
    { id: "active", label: "Активные" },
    { id: "draft", label: "Черновики" },
  ];
  $: normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
  $: visibleServices = services.filter(service =>
    (status === "all" || service.active === (status === "active")) &&
    service.displayName.toLocaleLowerCase("ru-RU").includes(normalizedQuery));
  function selectStatus(id: string): void {
    if (id === "all" || id === "active" || id === "draft") status = id;
  }
  function clearFilters(): void {
    query = "";
    status = "all";
  }
  let loading = true;
  let loaded = false;
  let saving = false;
  let readError = "";
  let saveError = "";
  let notice = "";
  let form = emptyRealServiceForm();
  // Keep the same key when an uncertain HTTP response is retried.
  let pendingKey = "";
  let editing: RealService | null = null;
  let stale = false;
  let uncertain = false;

  const priceFormatter = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  function description(reason: unknown): string {
    if (reason instanceof ServiceApiFailure) {
      if (reason.reason === "unauthorized")
        return "Сеанс или права изменились. Выполните вход заново.";
      if (reason.reason === "capacity")
        return "Достигнут предельный размер каталога (100 услуг в F1).";
      if (reason.reason === "conflict")
        return "Этот ключ уже использован с другими параметрами. Измените форму.";
      if (reason.reason === "stale-revision")
        return "Черновик уже изменён. Обновите список и заново откройте его, чтобы не затереть чужие изменения.";
      if (reason.reason === "draft-unavailable")
        return "Услуга не является доступным для изменения черновиком.";
      if (reason.reason === "invalid-response")
        return "Сервер вернул неподтверждённый формат ответа.";
    }
    return "Сервер недоступен. Данные не подтверждены; повторите запрос.";
  }

  function editName(value: string): void {
    if (saving || uncertain || stale) return;
    form.serviceName = value;
    pendingKey = "";
    saveError = "";
  }
  function editDuration(value: number): void {
    if (saving || uncertain || stale) return;
    form.serviceDuration = Number.isNaN(value) ? undefined : value;
    pendingKey = "";
    saveError = "";
  }
  function editPrice(value: number): void {
    if (saving || uncertain || stale) return;
    form.servicePrice = Number.isNaN(value) ? undefined : value;
    pendingKey = "";
    saveError = "";
  }

  function editBuffer(value: number): void {
    if (saving || uncertain || stale) return;
    form.serviceBuffer = Number.isNaN(value) ? undefined : value;
    pendingKey = "";
    saveError = "";
  }

  function startEdit(service: RealService): void {
    if (saving || loading || uncertain || service.active) return;
    editing = service;
    form = {
      serviceName: service.displayName,
      serviceDuration: service.durationMinutes,
      servicePrice: service.basePriceKopecks / 100,
      serviceBuffer: service.postServiceBufferMinutes,
    };
    pendingKey = "";
    stale = false;
    saveError = "";
    notice = "";
    void tick().then(() => editor?.focusName());
  }

  function resetForm(): void {
    editing = null;
    form = emptyRealServiceForm();
    pendingKey = "";
    stale = false;
    uncertain = false;
    saveError = "";
  }

  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    try {
      services = await reads.services.load();
      loaded = true;
    } catch (reason) {
      loaded = false;
      services = [];
      readError = description(reason);
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    if (saving || loading || !loaded || stale) return;
    const draft = realServiceDraftFromForm(form);
    if (!draft) {
      saveError = "Укажите название, длительность, цену и буфер. Введите 0, если услуга бесплатная или не требует буфера.";
      return;
    }

    saving = true;
    saveError = "";
    notice = "";
    const key = pendingKey || crypto.randomUUID();
    pendingKey = key;
    try {
      const wasEditing = editing !== null;
      if (editing) await editRealService(session, editing.id,
        { ...draft, expectedRevision: editing.revision }, key, reads.fetch);
      else await createRealService(session, draft, key, reads.fetch);
      // Receipt proves the command committed, not that its snapshot is
      // still current. Always re-read after both initial write and replay.
      resetForm();
      notice = wasEditing ? "Изменения черновика сохранены." : "Черновик услуги сохранён на сервере. Для записи клиентов он пока недоступен.";
      reads.services.invalidate();
      reads.staff.invalidate();
      reads.invalidateCalendars();
      reads.shifts.invalidate();
      await refresh();
    } catch (reason) {
      reads.services.invalidate();
      reads.staff.invalidate();
      reads.invalidateCalendars();
      reads.shifts.invalidate();
      saveError = description(reason);
      stale = reason instanceof ServiceApiFailure &&
        (reason.reason === "stale-revision" || reason.reason === "draft-unavailable");
      uncertain = !(reason instanceof ServiceApiFailure) ||
        reason.reason === "unavailable" || reason.reason === "invalid-response";
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<PageHeader title="Услуги салона" organization={session.organizationName}
  description="Новые услуги доступны клиентам после публикации.">
  {#snippet secondaryActions()}
    <ActionButton onclick={() => void refresh()} disabled={loading || saving}>Обновить</ActionButton>
  {/snippet}
  {#snippet primaryAction()}
    {#if loaded && !editing && !uncertain && !stale}
      <ActionButton tone="primary" onclick={() => editor?.focusName()} disabled={loading || saving}>
        <Plus size={17} aria-hidden="true" />Новая услуга
      </ActionButton>
    {/if}
  {/snippet}
</PageHeader>

{#if readError}
  <div class="alert-error" role="alert">
    <p>{readError}</p>
    <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading}>Повторить загрузку</Button>
  </div>
{/if}
{#if saveError}
  <div class="alert-error" role="alert"><p>{saveError}</p></div>
{/if}
{#if notice}
  <div class="alert-ok" role="status"><p>{notice}</p></div>
{/if}

<div class="workspace-grid">
  <section class="card">
    <div class="card-title">
      <h2>Сохранённые услуги</h2>
      {#if loaded && !loading}<span class="counter-pill">{services.length}</span>{/if}
    </div>
    <ThemeScope>
      {#if loading}
        <OwnerReadPlaceholder label="Загружаем услуги с сервера…" />
      {:else if loaded && services.length === 0}
        <EmptyState title="Услуг пока нет" description="Создайте первый черновик."
          actionLabel={!saving && !uncertain && !stale && !editing ? "Добавить услугу" : undefined}
          onAction={() => editor?.focusName()} />
      {:else if loaded}
        <div class="rhythm-stack service-directory" aria-label="Фильтры услуг">
          <label class="field">Поиск услуг
            <Input type="search" bind:value={query} placeholder="Название услуги" />
          </label>
          <Segment label="Статус услуги" options={statusOptions} selected={status} onSelect={selectStatus} />
          <p class="rhythm-muted" role="status">Найдено: {visibleServices.length} из {services.length}</p>
        </div>
        {#if visibleServices.length === 0}
          <EmptyState title="Услуги не найдены" description="Измените поиск или статус."
            actionLabel="Сбросить фильтры" onAction={clearFilters} />
        {:else}
          <div class="list-items" aria-label="Сохранённые услуги">
            {#each visibleServices as service (service.id)}
              <RecordRow record={{
                title: service.displayName,
                subtitle: service.durationMinutes + " мин · " + (service.active ? "Активна" : "Черновик") + " · Буфер: " + service.postServiceBufferMinutes + " мин",
                detail: priceFormatter.format(service.basePriceKopecks / 100),
              }}>
                {#snippet action()}
                  {#if !service.active}
                    <ActionButton disabled={saving || uncertain || loading}
                      label={"Изменить услугу: " + service.displayName}
                      onclick={() => startEdit(service)}>Изменить</ActionButton>
                  {/if}
                {/snippet}
              </RecordRow>
            {/each}
          </div>
        {/if}
      {/if}
    </ThemeScope>
  </section>
  {#if loaded}
    <ServiceForm
      bind:this={editor}
      serviceName={form.serviceName}
      serviceDuration={form.serviceDuration}
      servicePrice={form.servicePrice}
      serviceBuffer={form.serviceBuffer}
      onNameChange={editName}
      onDurationChange={editDuration}
      onPriceChange={editPrice}
      onBufferChange={editBuffer}
      onSubmit={() => void save()}
      apiMode={true}
      busy={saving || loading || stale}
      editing={editing !== null}
      onCancelEdit={resetForm}
      frozen={uncertain}
    />
    {#if stale}
      <p class="owner-form-note">Обновите список и выберите актуальный черновик или отмените редактирование.</p>
      <Button type="button" variant="outline" onclick={resetForm}>Сбросить форму</Button>
    {/if}
    {#if uncertain}
      <p class="owner-form-note">Ответ не подтверждён. Повторите сохранение с теми же параметрами; не создавайте новый черновик до подтверждения.</p>
    {/if}
  {/if}
</div>
