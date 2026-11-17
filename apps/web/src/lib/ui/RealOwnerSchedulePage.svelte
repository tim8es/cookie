<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import * as Card from "../components/ui/card/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { readRealStaff, type RealStaff } from "../staff-api";
  import { readRealLocations, type RealLocation } from "../locations-api";
  import { createShiftPlan, readShiftPlans, ShiftPlanError, type ShiftPlan } from "../shift-plans-api";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";
  import StagingAvailabilityPanel from "./StagingAvailabilityPanel.svelte";
  import { readStagingPublicationCapacity } from "../staging-publication-api";
  import { publishStagingShift, readPublishedShifts, type PublishedShift } from "../staging-shift-publication-api";

  export let session: VerifiedOwnerSession;
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
  $: eligibleStaff = staff.filter((member) => member.active && member.assignments.some((assignment) =>
    locations.some((location) => location.id === assignment.locationId && location.timeZone)));
  $: assignedBranches = locations.filter((location) => location.timeZone &&
    staff.find((member) => member.id === staffId)?.assignments.some((assignment) => assignment.locationId === location.id));
  $: selectedLocation = assignedBranches.find((location) => location.id === locationId);

  function message(reason: unknown): string {
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

  async function refreshPublication(): Promise<void> {
    publicationReady = false;
    publicationError = "";
    try {
      const [capacity, result] = await Promise.all([
        readStagingPublicationCapacity(session), readPublishedShifts(session),
      ]);
      publicationReady = capacity.state === "active";
      published = result.published;
      publishedHasMore = result.hasMore;
    } catch {
      published = [];
      publishedHasMore = false;
      publicationError = "Состояние публикации не подтверждено сервером.";
    }
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
      await publishStagingShift(session, selected, publicationKey);
      selectedPublication = null;
      publicationKey = "";
      notice = "Смена опубликована в тестовом контуре. Публичная запись клиентов ещё недоступна.";
      await refresh();
    } catch (reason) {
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
    try {
      const [directory, branches, result] = await Promise.all([
        readRealStaff(session), readRealLocations(session), readShiftPlans(session),
      ]);
      staff = directory.staff;
      locations = branches;
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
      await refreshPublication();
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
      const plan = await createShiftPlan(session, { staffId, locationId, startLocal, endLocal }, pendingKey);
      plans = [...plans.filter((item) => item.shiftId !== plan.shiftId), plan];
      pendingKey = "";
      startLocal = "";
      endLocal = "";
      notice = "Черновик сохранён. Доступность для записи клиентов не изменилась.";
      await refresh();
    } catch (reason) {
      saveError = message(reason);
    } finally {
      saving = false;
    }
  }

  function displayTime(value: string, location: RealLocation | undefined): string {
    try {
      return new Intl.DateTimeFormat("ru-RU", {
        timeZone: location?.timeZone ?? "UTC", dateStyle: "short", timeStyle: "short",
      }).format(new Date(value)) + " (" + (location?.timeZone ?? "UTC") + ")";
    } catch {
      return value + " (UTC)";
    }
  }

  onMount(() => { void refresh(); });
</script>

<div class="section-head">
  <div>
    <span class="eyebrow">COOKIE / РАБОЧЕЕ ВРЕМЯ</span>
    <h1>Расписание</h1>
    <p>Планирование будущих смен в часовом поясе филиала. Черновики не открывают запись клиентам.</p>
  </div>
</div>
{#if readError}
  <div class="alert-error" role="alert">
    <p>{readError}</p>
    <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading}>Повторить загрузку</Button>
  </div>
{/if}
{#if saveError}<div class="alert-error" role="alert"><p>{saveError}</p></div>{/if}
{#if notice}<div class="alert-ok" role="status"><p>{notice}</p></div>{/if}
<div class="workspace-grid">
  <section class="card">
    <div class="card-title">
      <div><span class="eyebrow">РАСПИСАНИЕ</span><h2>Будущие черновики</h2></div>
      <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading || saving || publishing}>Обновить</Button>
    </div>
    {#if loading}
      <p role="status">Загружаем смены…</p>
    {:else if loaded && plans.length === 0}
      <div class="empty-mini"><strong>Смен пока нет</strong><p>Запланируйте первую смену.</p></div>
    {:else if loaded}
      <div class="list-items">
        {#each plans as plan (plan.shiftId)}
          <div class="schedule-summary">
            <div class="schedule-icon" aria-hidden="true">◷</div>
            <div>
              <strong>{staff.find((item) => item.id === plan.staffId)?.displayName ?? "Мастер"}</strong>
              <p>{locations.find((item) => item.id === plan.locationId)?.displayName ?? "Филиал"}</p>
              <p>{displayTime(plan.startAt, locations.find((item) => item.id === plan.locationId))} – {displayTime(plan.endAt, locations.find((item) => item.id === plan.locationId))}</p>
              <span class="status-pill">Черновик</span>
              {#if canPublish}
                <Button type="button" variant="outline" onclick={() => choosePublication(plan)}>Подготовить публикацию</Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
      {#if hasMore}<p role="status">Показаны ближайшие 200 смен. Более поздние черновики не входят в текущую выдачу.</p>{/if}
    {/if}
    {#if loaded}
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
      {#each published as shift (shift.shiftId)}
        <div class="schedule-summary">
          <div>
            <strong>{staff.find((item) => item.id === shift.staffId)?.displayName ?? "Мастер"}</strong>
            <p>{locations.find((item) => item.id === shift.locationId)?.displayName ?? "Филиал"}</p>
            <p>{displayTime(shift.startAt, locations.find((item) => item.id === shift.locationId))} – {displayTime(shift.endAt, locations.find((item) => item.id === shift.locationId))}</p>
            <span class="status-pill">Опубликована в тестовом контуре</span>
          </div>
        </div>
      {/each}
      {#if publishedHasMore}<p role="status">Показаны ближайшие 200 опубликованных смен.</p>{/if}
    {/if}
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
              <select value={staffId} onchange={(event) => chooseStaff(event.currentTarget.value)} disabled={saving} required>
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
  <StagingAvailabilityPanel {session} {staff} {locations} disabled={loading || saving || publishing} />
{/if}
