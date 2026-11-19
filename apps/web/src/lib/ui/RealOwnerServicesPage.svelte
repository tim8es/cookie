<script lang="ts">
  import { onMount } from "svelte";
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

  let services: RealService[] = [];
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

  function catalogPrice(kopecks: number): string {
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(kopecks / 100);
  }

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

  function startEdit(service: RealService): void {
    if (saving || loading || uncertain || service.active) return;
    editing = service;
    form = {
      serviceName: service.displayName,
      serviceDuration: service.durationMinutes,
      servicePrice: service.basePriceKopecks / 100,
    };
    pendingKey = "";
    stale = false;
    saveError = "";
    notice = "";
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
      saveError = "Укажите название, длительность и цену с точностью до копеек. Для бесплатной услуги явно введите 0.";
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

<div class="section-head">
  <div>
    <span class="eyebrow">kuki / ЗАЩИЩЁННЫЙ КАБИНЕТ</span>
    <h1>Услуги салона</h1>
    <p>Изменения сохраняются в PostgreSQL. Новые услуги — черновики до публикации.</p>
  </div>
</div>

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
      <div><span class="eyebrow">КАТАЛОГ</span><h2>Сохранённые услуги</h2></div>
      <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading || saving}>Обновить</Button>
    </div>
    {#if loading && !loaded}
      <OwnerReadPlaceholder label="Загружаем услуги с сервера…" />
    {:else if loaded && services.length === 0}
      <div class="empty-mini"><strong>Услуг пока нет</strong><p>Создайте первый черновик.</p></div>
    {:else if loaded}
      <div class="list-items">
        {#each services as service (service.id)}
          <div class="entity-row">
            <span class="service-tile" aria-hidden="true">✳</span>
            <div class="entity-text">
              <strong>{service.displayName}</strong>
              <small>{service.durationMinutes} мин · {service.active ? "Активна" : "Черновик"}</small>
            </div>
            <strong class="price-label">{catalogPrice(service.basePriceKopecks)}</strong>
            {#if !service.active}
              <Button type="button" variant="outline" size="sm" disabled={saving || uncertain || loading} onclick={() => startEdit(service)}>Изменить</Button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
  {#if loaded}
    <ServiceForm
      serviceName={form.serviceName}
      serviceDuration={form.serviceDuration}
      servicePrice={form.servicePrice}
      onNameChange={editName}
      onDurationChange={editDuration}
      onPriceChange={editPrice}
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
