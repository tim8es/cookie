<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import ActionButton from "../components/rhythm/ActionButton.svelte";
  import PageHeader from "../components/rhythm/PageHeader.svelte";
  import { onMount } from "svelte";
  import type { OwnerReads } from "../owner-reads";
  import OwnerReadPlaceholder from "./OwnerReadPlaceholder.svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { ServiceApiFailure, type RealService } from "../services-api";
  import {
    createRealStaff,
    retainStaffCreateKey,
    StaffApiFailure,
    type RealStaff,
    type RealStaffLocation,
  } from "../staff-api";
  import StaffForm from "./StaffForm.svelte";
  import StagingPublicationPanel from "./StagingPublicationPanel.svelte";

  export let session: VerifiedOwnerSession;
  export let reads: OwnerReads;
  export let onOpenServices: () => void;

  let staffNameInput: HTMLInputElement | null = null;
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
    if (error instanceof ServiceApiFailure && error.reason === "unauthorized") {
      return "Сеанс или права изменились. Выполните вход заново.";
    }
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
    if (pendingKey) return;
    staffName = value;
    writeError = "";
  }
  function editTitle(value: string): void {
    if (pendingKey) return;
    staffTitle = value;
    writeError = "";
  }
  function editLocation(value: string): void {
    if (pendingKey) return;
    staffLocation = value;
    writeError = "";
  }
  function editService(value: string): void {
    if (pendingKey) return;
    staffService = value;
    writeError = "";
  }

  async function refresh(): Promise<void> {
    if (pendingKey) return;
    loading = true;
    readError = "";
    try {
      const [directory, catalog] = await Promise.all([
        reads.staff.load(),
        reads.services.load(),
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
    const retrying = Boolean(pendingKey);
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
        reads.fetch,
      );
      staff = [...staff.filter((member) => member.id !== created.id), created];
      pendingKey = "";
      staffName = "";
      staffTitle = "";
      notice = created.bookable
        ? "Профиль и назначения подтверждены. Мастер доступен для записи."
        : "Профиль и назначения сохранены. Для записи клиентов мастер пока недоступен.";
      reads.staff.invalidate();
      reads.invalidateCalendars();
      await refresh();
    } catch (reason) {
      if (!retainStaffCreateKey(retrying, reason)) pendingKey = "";
      reads.staff.invalidate();
      reads.invalidateCalendars();
      writeError = pendingKey
        ? "Сервер не подтвердил результат создания профиля."
        : message(reason);
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

<PageHeader title="Мастера" organization={session.organizationName}
  description="Настройте профили мастеров, их услуги и филиалы.">
  {#snippet secondaryActions()}
    <ActionButton onclick={() => void refresh()} disabled={loading || saving || publicationPending || !!pendingKey}>Обновить</ActionButton>
  {/snippet}
  {#snippet primaryAction()}
    {#if loaded && !pendingKey && locations.length > 0 && services.length > 0}
      <ActionButton tone="primary" onclick={() => staffNameInput?.focus()} disabled={loading || saving || publicationPending}>
        <Plus size={17} aria-hidden="true" />Добавить мастера
      </ActionButton>
    {/if}
  {/snippet}
</PageHeader>

{#if readError}
  <div class="alert-error" role="alert">
    <p>{readError}</p>
    <Button variant="outline" type="button" onclick={() => void refresh()} disabled={loading}>Повторить загрузку</Button>
  </div>
{/if}
{#if writeError}
  <div class="alert-error" role="alert"><p>{writeError}</p>
    {#if pendingKey}<p>Результат создания неизвестен. Повторите сохранение с теми же данными и не покидайте страницу до подтверждения.</p>{/if}
  </div>
{/if}
{#if notice}
  <div class="alert-ok" role="status"><p>{notice}</p></div>
{/if}

<div class="workspace-grid">
  <section class="card">
    <div class="card-title">
      <div><span class="eyebrow">КОМАНДА</span><h2>Профили мастеров</h2></div>
    </div>
    {#if loading && !loaded}
      <OwnerReadPlaceholder label="Загружаем профили…" />
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
      bind:nameInput={staffNameInput}
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
      locked={!!pendingKey}
    />
  {/if}
</div>

{#if loaded}
  <StagingPublicationPanel {session} {staff} {locations} {services} fetcher={reads.fetch}
    disabled={loading || saving || !!pendingKey} bind:pending={publicationPending}
    onPublished={async () => {
      reads.staff.invalidate();
      reads.services.invalidate();
      reads.shifts.invalidate();
      reads.invalidateCalendars();
      await refresh();
    }} />
{/if}
