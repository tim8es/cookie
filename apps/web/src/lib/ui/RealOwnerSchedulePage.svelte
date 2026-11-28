<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import ActionButton from "../components/rhythm/ActionButton.svelte";
  import PageHeader from "../components/rhythm/PageHeader.svelte";
  import { onMount } from "svelte";
  import EmptyState from "../components/rhythm/EmptyState.svelte";
  import RecordRow from "../components/rhythm/RecordRow.svelte";
  import ScheduleRow from "../components/rhythm/ScheduleRow.svelte";
  import ThemeScope from "../components/rhythm/ThemeScope.svelte";
  import type { OwnerReads } from "../owner-reads";
  import OwnerReadPlaceholder from "./OwnerReadPlaceholder.svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import * as Card from "../components/ui/card/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { StaffApiFailure, type RealStaff } from "../staff-api";
  import { LocationApiFailure, type RealLocation } from "../locations-api";
  import { createShiftPlan, ShiftPlanError, type ShiftPlan } from "../shift-plans-api";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";
  import StagingAvailabilityPanel from "./StagingAvailabilityPanel.svelte";
  import { readStagingPublicationCapacity } from "../staging-publication-api";
  import { publishStagingShift, readPublishedShifts, type PublishedShift } from "../staging-shift-publication-api";

  export let session: VerifiedOwnerSession;
  export let reads: OwnerReads;
  export let onOpenStaff: () => void;

  let staff: readonly RealStaff[] = [];
  let locations: RealLocation[] = [];
  let plans: ShiftPlan[] = [];
  let published: PublishedShift[] = [];
  let publishedHasMore = false;
  let publicationReady = false;
  let publicationError = "";
  let selectedPublication: ShiftPlan | null = null;
  let publicationKey = "";
  let publishing = false;
  $: canPublish = publicationReady && !loading && !saving && !publishing;

  let hasMore = false;
  let staffInput: HTMLSelectElement | undefined;
  let staffId = "";
  let locationId = "";
  let startLocal = "";
  let endLocal = "";
  let pendingKey = "";
  let loading = true;
  let loaded = false;
  let saving = false;
  let readError = "";
  let saveError = "";
  let notice = "";
  let filterStaffId = "";
  let filterLocationId = "";
  $: staffById = new Map(staff.map(member => [member.id, member]));
  $: locationById = new Map(locations.map(location => [location.id, location]));
  $: visiblePlans = plans.filter(plan => (!filterStaffId || plan.staffId === filterStaffId) &&
    (!filterLocationId || plan.locationId === filterLocationId));
  $: visiblePublished = published.filter(shift => (!filterStaffId || shift.staffId === filterStaffId) &&
    (!filterLocationId || shift.locationId === filterLocationId));
  const clocks = new Map<string, Intl.DateTimeFormat>();
  $: eligibleStaff = staff.filter((member) => member.active && member.assignments.some((assignment) =>
    locations.some((location) => location.id === assignment.locationId && location.timeZone)));
  $: assignedBranches = locations.filter((location) => location.timeZone &&
    staff.find((member) => member.id === staffId)?.assignments.some((assignment) => assignment.locationId === location.id));
  $: selectedLocation = assignedBranches.find((location) => location.id === locationId);

  function message(reason: unknown): string {
    if ((reason instanceof StaffApiFailure || reason instanceof LocationApiFailure) && reason.reason === "unauthorized") {
      return "Сеанс или права изменились. Войдите заново.";
    }
    if (reason instanceof ShiftPlanError) {
      if (reason.reason === "unauthorized") return "Сеанс или права изменились. Войдите заново.";
      if (reason.reason === "invalid-time") return "Проверьте дату и время. Смена должна быть в будущем, не более 48 часов; неоднозначное местное время не принимается.";
      if (reason.reason === "target-unavailable") return "Мастер, назначение или часовой пояс недоступны. Проверьте данные и обновите список.";
      if (reason.reason === "conflict") return "Повторный ключ использован с другими значениями.";
      if (reason.reason === "invalid-response") return "Сервер вернул неподтверждённый формат.";
    }
    return "Нет подтверждения от сервера. Повторите запрос.";
  }

  function chooseStaff(value: string): void {
    staffId = value;
    locationId = locations.find((location) => location.timeZone && staff.find((member) =>
      member.id === value)?.assignments.some((assignment) => assignment.locationId === location.id))?.id ?? "";
    pendingKey = "";
    saveError = "";
  }
  function editLocation(value: string): void {
    locationId = value;
    pendingKey = "";
    saveError = "";
  }
  function editStart(value: string): void {
    startLocal = value;
    pendingKey = "";
    saveError = "";
  }
  function editEnd(value: string): void {
    endLocal = value;
    pendingKey = "";
    saveError = "";
  }

  function choosePublication(plan: ShiftPlan): void {
    if (!canPublish) return;
    selectedPublication = plan;
    publicationKey = "";
    publicationError = "";
  }

  async function confirmPublication(): Promise<void> {
    if (!canPublish || !selectedPublication) return;
    const selected = selectedPublication;
    publishing = true;
    publicationError = "";
    notice = "";
    try {
      publicationKey ||= crypto.randomUUID();
      await publishStagingShift(session, selected, publicationKey, reads.fetch);
      selectedPublication = null;
      publicationKey = "";
      notice = "Смена опубликована в тестовом контуре. Публичная запись клиентов ещё недоступна.";
      reads.shifts.invalidate();
      await refresh();
    } catch (reason) {
      reads.shifts.invalidate();
      const code = reason instanceof Error ? reason.message : "";
      publicationError =
        code === "SHIFT_CROSS_LOCATION_CONFLICT" ? "Смена пересекается со сменой в другом филиале." :
        code === "SHIFT_STALE_REVISION" ? "Черновик изменился. Обновите расписание." :
        code === "grant-unavailable" || code === "SHIFT_POLICY_DENIED" ? "Нет действующего тестового разрешения." :
        code === "SHIFT_TARGET_UNAVAILABLE" ? "Сначала активируйте мастера и его назначение." :
        code === "unauthorized" ? "Сеанс или права изменились. Войдите заново." :
        "Публикация не подтверждена. Повторите запрос или обновите расписание.";
    } finally {
      publishing = false;
    }
  }

  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    publicationReady = false;
    publicationError = "";
    const publicationRead = Promise.all([
      readStagingPublicationCapacity(session, reads.fetch),
      readPublishedShifts(session, reads.fetch),
    ]).catch(() => null);
    try {
      const [directory, branches, result] = await Promise.all([
        reads.staff.load(), reads.locations.load(), reads.shifts.load(),
      ]);
      staff = directory.staff;
      locations = branches;
      if (!staff.some(member => member.id === filterStaffId)) filterStaffId = "";
      if (!locations.some(location => location.id === filterLocationId)) filterLocationId = "";
      plans = result.plans;
      hasMore = result.hasMore;
      const available = staff.filter((member) => member.active && member.assignments.some((assignment) =>
        locations.some((location) => location.id === assignment.locationId && location.timeZone)));
      if (!available.some((member) => member.id === staffId)) chooseStaff(available[0]?.id ?? "");
      else if (!locations.some((location) => location.id === locationId && location.timeZone &&
        staff.find((member) => member.id === staffId)?.assignments.some((assignment) => assignment.locationId === locationId))) {
        chooseStaff(staffId);
      }
      loaded = true;
      const publication = await publicationRead;
      if (publication) {
        const [capacity, result] = publication;
        publicationReady = capacity.state === "active";
        published = result.published;
        publishedHasMore = result.hasMore;
      } else {
        published = [];
        publishedHasMore = false;
        publicationError = "Состояние публикации не подтверждено сервером.";
      }
    } catch (reason) {
      loaded = false;
      readError = message(reason);
      plans = [];
      published = [];
      publicationReady = false;
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    if (saving || publishing || loading || !loaded) return;
    if (!staffId || !selectedLocation || !startLocal || !endLocal) {
      saveError = "Выберите мастера, филиал и время.";
      return;
    }
    saving = true;
    saveError = "";
    notice = "";
    try {
      pendingKey ||= crypto.randomUUID();
      const plan = await createShiftPlan(session, { staffId, locationId, startLocal, endLocal }, pendingKey, reads.fetch);
      plans = [...plans.filter((item) => item.shiftId !== plan.shiftId), plan];
      pendingKey = "";
      startLocal = "";
      endLocal = "";
      notice = "Черновик сохранён. Доступность для записи клиентов не изменилась.";
      reads.shifts.invalidate();
      await refresh();
    } catch (reason) {
      reads.shifts.invalidate();
      saveError = message(reason);
    } finally {
      saving = false;
    }
  }

  function displayTime(value: string, location: RealLocation | undefined): string {
    try {
      const zone = location?.timeZone ?? "UTC";
      let clock = clocks.get(zone);
      if (!clock) {
        clock = new Intl.DateTimeFormat("ru-RU", {
          timeZone: zone, dateStyle: "short", timeStyle: "short",
        });
        if (clocks.size >= 100) clocks.clear();
        clocks.set(zone, clock);
      }
      return clock.format(new Date(value)) + " (" + zone + ")";
    } catch {
      return value + " (UTC)";
    }
  }

  onMount(() => { void refresh(); });
</script>

<PageHeader title="Расписание" organization={session.organizationName}
  description="Смены планируются в часовом поясе филиала. Черновики не открывают запись клиентам.">
  {#snippet secondaryActions()}
    <ActionButton onclick={() => void refresh()} disabled={loading || saving || publishing}>Обновить</ActionButton>
  {/snippet}
  {#snippet primaryAction()}
    {#if loaded && eligibleStaff.length > 0 && !pendingKey}
      <ActionButton tone="primary" onclick={() => staffInput?.focus()} disabled={loading || saving || publishing}>
        <Plus size={17} aria-hidden="true" />Новая смена
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
{#if saveError}<div class="alert-error" role="alert"><p>{saveError}</p></div>{/if}
{#if notice}<div class="alert-ok" role="status"><p>{notice}</p></div>{/if}
<div class="workspace-grid">
  <section class="card schedule-directory-panel">
    <ThemeScope>
      {#if loaded && !loading}
        <div class="rhythm-stack schedule-directory" aria-label="Фильтры расписания">
          <label class="field">Мастер
            <select bind:value={filterStaffId}>
              <option value="">Все мастера</option>
              {#each staff as member (member.id)}<option value={member.id}>{member.displayName}</option>{/each}
            </select>
          </label>
          <label class="field">Филиал
            <select bind:value={filterLocationId}>
              <option value="">Все филиалы</option>
              {#each locations as location (location.id)}<option value={location.id}>{location.displayName}</option>{/each}
            </select>
          </label>
          {#if filterStaffId || filterLocationId}
            <ActionButton onclick={() => { filterStaffId = ""; filterLocationId = ""; }}>Сбросить фильтры</ActionButton>
          {/if}
          <p class="rhythm-muted" role="status">Черновики: {visiblePlans.length} из {plans.length}{#if !publicationError}. Опубликованные: {visiblePublished.length} из {published.length}{/if}</p>
        </div>
      {/if}
      <div class="card-title"><h2>Будущие черновики</h2></div>
      {#if loading}
        <OwnerReadPlaceholder label="Загружаем смены…" />
      {:else if loaded && plans.length === 0}
        <EmptyState title="Смен пока нет" description="Запланируйте первую смену." />
      {:else if loaded}
        {#if visiblePlans.length === 0}
          <EmptyState title="Черновики не найдены" description="Измените фильтры." />
        {:else}
          <div class="list-items">
            {#each visiblePlans as plan (plan.shiftId)}
              <div class="schedule-summary">
                <div class="schedule-record-content">
                  <RecordRow record={{
                    title: staffById.get(plan.staffId)?.displayName ?? "Мастер",
                    subtitle: (locationById.get(plan.locationId)?.displayName ?? "Филиал") + " · " + displayTime(plan.startAt, locationById.get(plan.locationId)) + " – " + displayTime(plan.endAt, locationById.get(plan.locationId)),
                    detail: "Черновик",
                  }}>
                    {#snippet action()}
                      {#if canPublish}
                        <ActionButton onclick={() => choosePublication(plan)}>Подготовить публикацию</ActionButton>
                      {/if}
                    {/snippet}
                  </RecordRow>
                </div>
              </div>
            {/each}
          </div>
        {/if}
        {#if hasMore}<p role="status">Показаны ближайшие 200 смен. Более поздние черновики не входят в текущую выдачу.</p>{/if}
      {/if}
    {#if loaded && !loading}
      <p class="owner-form-note">Публикация возможна только в разрешённом тестовом контуре для активированного мастера.</p>
      {#if publicationError}<div class="alert-error" role="alert"><p>{publicationError}</p></div>{/if}
      {#if selectedPublication}
        <div class="card" role="group" aria-label="Подтверждение публикации смены">
          <strong>Опубликовать смену в тестовом контуре?</strong>
          <p>{staff.find((item) => item.id === selectedPublication?.staffId)?.displayName ?? "Мастер"}</p>
          <p>{locations.find((item) => item.id === selectedPublication?.locationId)?.displayName ?? "Филиал"}</p>
          <p>{displayTime(selectedPublication.startAt, locations.find((item) => item.id === selectedPublication?.locationId))} – {displayTime(selectedPublication.endAt, locations.find((item) => item.id === selectedPublication?.locationId))}</p>
          <Button type="button" onclick={() => void confirmPublication()} disabled={!canPublish}>Подтвердить публикацию</Button>
          <Button type="button" variant="outline" onclick={() => { selectedPublication = null; publicationKey = ""; }} disabled={publishing}>Отмена</Button>
        </div>
      {/if}
      <h2>Опубликованные смены</h2>
      {#if published.length === 0 && !publicationError}
        <p>Нет опубликованных смен.</p>
      {/if}
      {#if published.length > 0 && visiblePublished.length === 0}
        <EmptyState title="Опубликованные смены не найдены" description="Измените фильтры." />
      {/if}
      {#each visiblePublished as shift (shift.shiftId)}
        <div class="schedule-summary">
          <div class="schedule-record-content">
            <ScheduleRow schedule={{
              label: staffById.get(shift.staffId)?.displayName ?? "Мастер",
              period: (locationById.get(shift.locationId)?.displayName ?? "Филиал") + " · " + displayTime(shift.startAt, locationById.get(shift.locationId)) + " – " + displayTime(shift.endAt, locationById.get(shift.locationId)),
              status: "Опубликована в тестовом контуре",
            }} />
          </div>
        </div>
      {/each}
      {#if publishedHasMore}<p role="status">Показаны ближайшие 200 опубликованных смен.</p>{/if}
    {/if}
    </ThemeScope>
  </section>
  {#if loaded}
    <Card.Root class="owner-form-panel">
      <form class="owner-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <OwnerFormHeader kind="schedule" eyebrow="РАСПИСАНИЕ / 03" title="Новая смена" description="Укажите дату и локальное время филиала." />
        {#if eligibleStaff.length === 0}
          <p>Сначала нужен мастер с назначением в филиал.</p>
          <Button type="button" variant="outline" class="owner-submit" onclick={onOpenStaff}>Перейти к мастерам</Button>
        {:else}
          <div class="owner-form-fields">
            <label class="field">Мастер
              <select bind:this={staffInput} value={staffId} onchange={(event) => chooseStaff(event.currentTarget.value)} disabled={saving} required>
                <option value="" disabled>Выберите мастера</option>
                {#each eligibleStaff as member (member.id)}<option value={member.id}>{member.displayName}</option>{/each}
              </select>
            </label>
            <label class="field">Филиал
              <select value={locationId} onchange={(event) => editLocation(event.currentTarget.value)} disabled={saving} required>
                <option value="" disabled>Выберите филиал</option>
                {#each assignedBranches as location (location.id)}<option value={location.id}>{location.displayName}</option>{/each}
              </select>
            </label>
            <p class="owner-form-note">Часовой пояс: {selectedLocation?.timeZone ?? "не выбран"}</p>
            <label class="field">Начало смены
              <Input type="datetime-local" value={startLocal} onchange={(event) => editStart(event.currentTarget.value)} required disabled={saving} />
            </label>
            <label class="field">Окончание смены
              <Input type="datetime-local" value={endLocal} onchange={(event) => editEnd(event.currentTarget.value)} required disabled={saving} />
            </label>
          </div>
          <p class="owner-form-note">Проверка конфликтов и активация доступны на отдельном этапе публикации. Смена остаётся черновиком.</p>
          <Button class="owner-submit" type="submit" disabled={saving || publishing || loading || !selectedLocation}>{saving ? "Сохраняем…" : "Сохранить черновик смены"}</Button>
        {/if}
      </form>
    </Card.Root>
  {/if}
</div>
{#if loaded && publicationReady}
  <StagingAvailabilityPanel {session} fetcher={reads.fetch} {staff} {locations} disabled={loading || saving || publishing} />
{/if}

<style>
  .schedule-directory-panel,
  .schedule-record-content,
  .schedule-directory,
  .schedule-directory .field {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .schedule-record-content { width: 100%; }
  .schedule-directory { grid-template-columns: minmax(0, 1fr); }
  .schedule-directory select {
    min-width: 0;
    max-width: 100%;
    width: 100%;
    box-sizing: border-box;
  }
  .schedule-directory-panel :global(button) {
    min-width: 0;
    max-width: 100%;
    height: auto;
    white-space: normal;
    overflow-wrap: anywhere;
  }
</style>
