<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { money } from "../dates";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import {
    createRealService,
    readRealServices,
    ServiceApiFailure,
    type RealService,
  } from "../services-api";
  import ServiceForm from "./ServiceForm.svelte";
  import RealOwnerStaffSection from "./RealOwnerStaffSection.svelte";

  export let session: VerifiedOwnerSession;
  export let onLogout: () => void;

  let services: RealService[] = [];
  let loading = true;
  let loaded = false;
  let saving = false;
  let readError = "";
  let saveError = "";
  let notice = "";
  let serviceName = "";
  let serviceDuration = 60;
  let servicePrice = 0;
  // Keep the same key when an uncertain HTTP response is retried.
  let pendingKey = "";

  function description(reason: unknown): string {
    if (reason instanceof ServiceApiFailure) {
      if (reason.reason === "unauthorized")
        return "Сеанс или права изменились. Выполните вход заново.";
      if (reason.reason === "conflict")
        return "Этот ключ уже использован с другими параметрами. Измените форму.";
      if (reason.reason === "invalid-response")
        return "Сервер вернул неподтверждённый формат ответа.";
    }
    return "Сервер недоступен. Данные не подтверждены; повторите запрос.";
  }

  function editName(value: string): void {
    serviceName = value;
    pendingKey = "";
    saveError = "";
  }
  function editDuration(value: number): void {
    serviceDuration = value;
    pendingKey = "";
    saveError = "";
  }
  function editPrice(value: number): void {
    servicePrice = value;
    pendingKey = "";
    saveError = "";
  }

  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    try {
      services = await readRealServices(session);
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
    if (saving || loading || !loaded) return;
    if (
      !serviceName.trim() ||
      !Number.isInteger(serviceDuration) || serviceDuration < 1 ||
      serviceDuration > 1440 ||
      !Number.isSafeInteger(servicePrice) ||
      servicePrice < 0 || servicePrice > 9_999_999_999
    ) {
      saveError = "Проверьте название, длительность и целую цену в рублях.";
      return;
    }

    saving = true;
    saveError = "";
    notice = "";
    const key = pendingKey || crypto.randomUUID();
    pendingKey = key;
    try {
      const saved = await createRealService(
        session,
        {
          displayName: serviceName.trim().normalize("NFC"),
          durationMinutes: serviceDuration,
          basePriceKopecks: servicePrice * 100,
        },
        key,
      );
      // POST response is an actual persisted server record, not a UI estimate.
      services = [...services.filter((item) => item.id !== saved.id), saved];
      pendingKey = "";
      serviceName = "";
      servicePrice = 0;
      notice = "Черновик услуги сохранён на сервере. Для записи клиентов он пока недоступен.";
      // Read-after-write confirms the same record is still visible to the owner.
      await refresh();
    } catch (reason) {
      saveError = description(reason);
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
    <span class="eyebrow">COOKIE / ЗАЩИЩЁННЫЙ КАБИНЕТ</span>
    <h1>Услуги салона</h1>
    <p>Изменения сохраняются в PostgreSQL. Новые услуги — черновики до публикации.</p>
  </div>
  <Button type="button" variant="outline" onclick={onLogout}>Выйти</Button>
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
    {#if loading}
      <p role="status">Загружаем услуги с сервера…</p>
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
            <strong class="price-label">{money(service.basePriceKopecks / 100)}</strong>
          </div>
        {/each}
      </div>
    {/if}
  </section>
  {#if loaded}
    <ServiceForm
      {serviceName}
      {serviceDuration}
      {servicePrice}
      onNameChange={editName}
      onDurationChange={editDuration}
      onPriceChange={editPrice}
      onSubmit={() => void save()}
      apiMode={true}
      busy={saving || loading}
    />
  {/if}
</div>

<RealOwnerStaffSection {session} />
