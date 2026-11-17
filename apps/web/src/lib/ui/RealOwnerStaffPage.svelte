<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { readRealServices, type RealService } from "../services-api";
  import {
    createRealStaff,
    readRealStaff,
    StaffApiFailure,
    type RealStaff,
    type RealStaffLocation,
  } from "../staff-api";
  import StaffForm from "./StaffForm.svelte";
  import StagingPublicationPanel from "./StagingPublicationPanel.svelte";

  export let session: VerifiedOwnerSession;
  export let onOpenServices: () => void;

  let staff: readonly RealStaff[] = [];
  let locations: readonly RealStaffLocation[] = [];
  let services: readonly RealService[] = [];
  let loaded = false;
  let loading = true;
  let saving = false;
  let readError = "";
  let writeError = "";
  let notice = "";
  let staffName = "";
  let staffTitle = "";
  let staffService = "";
  let staffLocation = "";
  // A failed/unknown response must reuse its key with unchanged request values.
  let pendingKey = "";
  let publicationPending = false;

  function message(error: unknown): string {
    if (error instanceof StaffApiFailure) {
      if (error.reason === "unauthorized") return "Сеанс или права изменились. Выполните вход заново.";
      if (error.reason === "missing-reference") return "Филиал или услуга больше не существуют. Обновите страницу.";
      if (error.reason === "capacity") return "Достигнут технический предел F1 (100 профилей мастеров).";
      if (error.reason === "conflict") return "Ключ уже использован для другого профиля. Измените форму.";
      if (error.reason === "invalid-response") return "Сервер вернул неподтверждённые данные.";
    }
    return "Не удалось подтвердить ответ сервера. Повторите запрос.";
  }

  function editName(value: string): void {
    staffName = value;
    pendingKey = "";
    writeError = "";
  }
  function editTitle(value: string): void {
    staffTitle = value;
    pendingKey = "";
    writeError = "";
  }
  function editLocation(value: string): void {
    staffLocation = value;
    pendingKey = "";
    writeError = "";
  }
  function editService(value: string): void {
    staffService = value;
    pendingKey = "";
    writeError = "";
  }

  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    try {
      const [directory, catalog] = await Promise.all([
        readRealStaff(session),
        readRealServices(session),
      ]);
      staff = directory.staff;
      locations = directory.locations;
      services = catalog;
      if (!locations.some((item) => item.id === staffLocation)) {
        staffLocation = locations[0]?.id ?? "";
      }
      if (!services.some((item) => item.id === staffService)) {
        staffService = services[0]?.id ?? "";
      }
      loaded = true;
    } catch (reason) {
      loaded = false;
      staff = [];
      locations = [];
      services = [];
      readError = message(reason);
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    if (!loaded || loading || saving || publicationPending) return;
    if (
      !staffName.trim() ||
      [...staffName.trim()].length > 200 ||
      [...staffTitle.trim()].length > 80 ||
      !locations.some((item) => item.id === staffLocation) ||
      !services.some((item) => item.id === staffService)
    ) {
      writeError = "Заполните имя мастера, филиал и существующую услугу.";
      return;
    }
    saving = true;
    writeError = "";
    notice = "";
    pendingKey ||= crypto.randomUUID();
    try {
      const created = await createRealStaff(
        session,
        {
          displayName: staffName.trim().normalize("NFC"),
          positionTitle: staffTitle.trim().normalize("NFC"),
          locationId: staffLocation,
          serviceId: staffService,
        },
        pendingKey,
      );
      staff = [...staff.filter((member) => member.id !== created.id), created];
      pendingKey = "";
      staffName = "";
      staffTitle = "";
      notice = "Профиль и назначения сохранены. Для записи клиентов мастер пока недоступен.";
      await refresh();
    } catch (reason) {
      writeError = message(reason);
    } finally {
      saving = false;
    }
  }

  function namesFor(member: RealStaff): string {
    const refs = member.assignments.flatMap((assignment) => {
      const branch = locations.find((item) => item.id === assignment.locationId);
      return assignment.serviceIds.map((id) => {
        const service = services.find((item) => item.id === id);
        return (branch?.displayName ?? "Филиал") + " · " + (service?.displayName ?? "Услуга");
      });
    });
    return refs.join(", ") || "Назначений пока нет";
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="section-head">
  <div>
    <span class="eyebrow">COOKIE / КОМАНДА</span>
    <h1>Мастера</h1>
    <p>Один профиль на организацию. Услуги и филиалы привязываются как черновики.</p>
  </div>
</div>

{#if readError}
  <div class="alert-error" role="alert">
    <p>{readError}</p>
    <Button variant="outline" type="button" onclick={() => void refresh()} disabled={loading}>Повторить загрузку</Button>
  </div>
{/if}
{#if writeError}
  <div class="alert-error" role="alert"><p>{writeError}</p></div>
{/if}
{#if notice}
  <div class="alert-ok" role="status"><p>{notice}</p></div>
{/if}

<div class="workspace-grid">
  <section class="card">
    <div class="card-title">
      <div><span class="eyebrow">КОМАНДА</span><h2>Профили мастеров</h2></div>
      <Button variant="outline" type="button" onclick={() => void refresh()} disabled={loading || saving || publicationPending}>Обновить</Button>
    </div>
    {#if loading}
      <p role="status">Загружаем профили…</p>
    {:else if loaded && staff.length === 0}
      <div class="empty-mini"><strong>Профилей пока нет</strong><p>Добавьте первого мастера.</p></div>
    {:else if loaded}
      <div class="list-items">
        {#each staff as member (member.id)}
          <div class="entity-row">
            <span class="staff-avatar">{member.displayName.slice(0, 1)}</span>
            <div class="entity-text">
              <strong>{member.displayName}</strong>
              <small>{member.positionTitle || "Специалист"} · {namesFor(member)}</small>
            </div>
            <span class="status-pill">{member.bookable ? "Активирован" : "Черновик"}</span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
  {#if loaded}
    <StaffForm
      services={services.map((service) => ({ id: service.id, name: service.displayName }))}
      {locations}
      {staffName}
      {staffTitle}
      {staffService}
      {staffLocation}
      onNameChange={editName}
      onTitleChange={editTitle}
      onServiceChange={editService}
      onLocationChange={editLocation}
      onOpenServices={onOpenServices}
      onSubmit={() => void save()}
      apiMode={true}
      busy={saving || loading || publicationPending}
    />
  {/if}
</div>

{#if loaded}
  <StagingPublicationPanel {session} {staff} {locations} {services}
    disabled={loading || saving} bind:pending={publicationPending}
    onPublished={refresh} />
{/if}
