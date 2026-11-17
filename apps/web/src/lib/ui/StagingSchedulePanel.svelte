<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import type { ShiftPlan } from "../shift-plans-api";
  import type { RealStaff } from "../staff-api";
  import type { RealLocation } from "../locations-api";
  import { readRealServices, type RealService } from "../services-api";
  import { readStagingSchedule, publishStagingShift, previewStagingSlots, StagingScheduleError,
    type ScheduleStatus, type SlotPreview } from "../staging-schedule-api";

  export let session: VerifiedOwnerSession;
  export let plans: ShiftPlan[];
  export let staff: readonly RealStaff[];
  export let locations: RealLocation[];
  export let disabled = false;
  export let pending = false;
  export let onPublished: () => Promise<void>;
  let status: ScheduleStatus | null = null;
  let services: readonly RealService[] = [];
  let selected = "";
  let confirmation = false;
  let retry: { plan: ShiftPlan; key: string } | null = null;
  let error = "";
  let notice = "";
  let loading = true;
  let previewLoading = false;
  let target = "";
  let localDate = "";
  let slots: SlotPreview | null = null;
  let previewError = "";
  $: drafts = plans.filter(plan => staff.some(member => member.id === plan.staffId && member.active && member.bookable));
  $: options = staff.filter(member => member.active && member.bookable).flatMap(member =>
    member.assignments.flatMap(assignment => {
      const branch = locations.find(location => location.id === assignment.locationId);
      return assignment.serviceIds.flatMap(serviceId => {
        const service = services.find(s => s.id === serviceId && s.active);
        return branch && service ? [{
          id: member.id + ":" + branch.id + ":" + service.id,
          label: member.displayName + " · " + branch.displayName + " · " + service.displayName,
          staffId: member.id, locationId: branch.id, serviceId: service.id,
        }] : [];
      });
    }));
  function describe(reason: unknown): string {
    if (reason instanceof StagingScheduleError) {
      switch (reason.reason) {
        case "unauthorized": return "Сеанс или права изменились. Войдите заново.";
        case "grant-unavailable": return "Тестовое разрешение недействительно.";
        case "SHIFT_CROSS_LOCATION_CONFLICT": return "Смена пересекается с опубликованной сменой мастера в другом филиале.";
        case "SHIFT_STALE_REVISION": return "Черновик изменился. Обновите данные.";
        case "SHIFT_NOT_FUTURE": return "Смена уже началась.";
        case "SHIFT_ALREADY_ACTIVE": return "Смена уже опубликована.";
        case "SHIFT_TARGET_UNAVAILABLE":
        case "target-unavailable": return "Назначение мастера или действующий тестовый доступ отсутствует.";
        case "shift-unavailable": return "Смена недоступна.";
        case "SHIFT_REACTIVATION_REQUIRES_REVIEW": return "Повторная публикация отключённой смены требует отдельной проверки.";
      }
    }
    return "Сервер не подтвердил запрос. Проверьте данные и повторите.";
  }
  function format(value: string, zone: string): string {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: zone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  }
  function zoneFor(locationId: string): string { return locations.find(l => l.id === locationId)?.timeZone ?? "UTC"; }
  function label(plan: Pick<ShiftPlan, "staffId" | "locationId" | "startAt" | "endAt">): string {
    return (staff.find(s => s.id === plan.staffId)?.displayName ?? "Мастер") + " · " +
      (locations.find(l => l.id === plan.locationId)?.displayName ?? "Филиал") + " · " +
      format(plan.startAt, zoneFor(plan.locationId)) + " – " + format(plan.endAt, zoneFor(plan.locationId));
  }
  async function refresh(): Promise<void> {
    loading = true;
    error = "";
    slots = null;
    try {
      [status, services] = await Promise.all([readStagingSchedule(session), readRealServices(session)]);
    } catch (reason) { status = null; services = []; error = describe(reason); }
    finally { loading = false; }
  }
  async function publish(): Promise<void> {
    if (pending || loading || disabled) return;
    if (!retry) {
      const plan = drafts.find(p => p.shiftId === selected);
      if (!status?.canPublish || !plan || !confirmation) return;
      retry = {plan: {...plan}, key: crypto.randomUUID()};
    }
    pending = true;
    error = "";
    notice = "";
    const current = retry;
    try {
      await publishStagingShift(session, current.plan, current.key);
      retry = null; selected = ""; confirmation = false;
      await onPublished();
      await refresh();
      notice = "Смена опубликована для staging. Публичная запись клиентов не включена.";
    } catch (reason) {
      if (reason instanceof StagingScheduleError && !["unavailable","invalid-response"].includes(reason.reason)) {
        retry = null; selected = ""; confirmation = false;
        await onPublished();
        await refresh();
      }
      error = describe(reason);
    } finally { pending = false; }
  }
  async function preview(): Promise<void> {
    const option = options.find(item => item.id === target);
    if (!status?.canPublish || !option || !localDate || pending || loading || previewLoading || disabled) return;
    previewLoading = true; slots = null; previewError = "";
    try {
      slots = await previewStagingSlots(session, {staffId:option.staffId, locationId:option.locationId, serviceId:option.serviceId, localDate});
    } catch (reason) {previewError = describe(reason);}
    finally { previewLoading = false; }
  }
  onMount(() => { void refresh(); });
</script>

<section class="card" aria-label="Публикация смен staging">
  <div class="card-title">
    <div><span class="eyebrow">STAGING / РАСПИСАНИЕ</span><h2>Опубликованные смены</h2></div>
    <Button type="button" variant="outline" disabled={loading || disabled || pending || previewLoading} onclick={() => void refresh()}>Обновить публикацию</Button>
  </div>
  {#if error}<p role="alert" class="alert-error">{error}</p>{/if}
  {#if notice}<p role="status" class="alert-ok">{notice}</p>{/if}
  {#if loading}<p role="status">Проверяем опубликованные смены…</p>
  {:else if status}
    {#if status.shifts.length === 0}<p>Опубликованных смен пока нет.</p>{/if}
    <div class="list-items">
      {#each status.shifts as shift (shift.shiftId)}
        <div class="schedule-summary"><strong>{label(shift)}</strong><span class="status-pill">Опубликовано для staging</span></div>
      {/each}
    </div>
    {#if status.hasMore}<p>Показаны ближайшие 200 смен.</p>{/if}
    {#if retry}
      <p>Ответ не подтверждён: {label(retry.plan)}</p>
      <Button type="button" disabled={pending || disabled || loading} onclick={() => void publish()}>Повторить публикацию</Button>
    {:else if status.canPublish}
      {#if drafts.length}
        <label class="field">Черновик смены
          <select value={selected} disabled={disabled || pending || previewLoading} onchange={event => {selected = event.currentTarget.value; confirmation = false;}}>
            <option value="">Выберите смену</option>
            {#each drafts as plan (plan.shiftId)}<option value={plan.shiftId}>{label(plan)}</option>{/each}
          </select>
        </label>
        <label class="field"><span><input type="checkbox" bind:checked={confirmation} disabled={!selected || disabled || pending || previewLoading} /> Опубликовать выбранную смену в тестовой среде.</span></label>
        <Button type="button" disabled={!selected || !confirmation || pending || disabled || previewLoading} onclick={() => void publish()}>Опубликовать смену</Button>
      {:else}<p>Нет черновиков активированных мастеров.</p>{/if}
      <div class="card-title"><h2>Предпросмотр записи</h2></div>
      {#if options.length}
        <label class="field">Мастер, филиал и услуга
          <select value={target} disabled={previewLoading || pending || disabled} onchange={event => {target = event.currentTarget.value; slots = null; previewError = "";}}>
            <option value="">Выберите назначение</option>
            {#each options as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
          </select>
        </label>
        <label class="field">Дата филиала
          <Input type="date" value={localDate} disabled={previewLoading || pending || disabled} onchange={event => {localDate = event.currentTarget.value; slots = null; previewError = "";}} />
        </label>
        <Button type="button" variant="outline" disabled={!target || !localDate || previewLoading || pending || disabled} onclick={() => void preview()}>Проверить слоты</Button>
      {:else}<p>Сначала активируйте мастера и услугу в staging.</p>{/if}
      {#if previewError}<p class="alert-error" role="alert">{previewError}</p>{/if}
      {#if previewLoading}<p role="status">Рассчитываем слоты…</p>{/if}
      {#if slots}
        <p role="status">Найдено слотов: {slots.slots.length}. Часовой пояс: {slots.timeZone}.</p>
        <div class="list-items">
          {#each slots.slots.slice(0, 100) as slot (slot.startAt)}
            <p>{format(slot.startAt, slots.timeZone)} – {format(slot.endAt, slots.timeZone)}</p>
          {/each}
          {#if slots.slots.length > 100}<p>Показаны первые 100 вариантов.</p>{/if}
        </div>
      {/if}
    {:else}<p>Тестовая публикация и предпросмотр недоступны без действующего разрешения.</p>{/if}
  {/if}
  <p class="owner-form-note">Слоты — снимок доступности, не резервирование. Шаг предпросмотра 15 минут. Финальная запись потребует отдельной атомарной проверки.</p>
</section>
