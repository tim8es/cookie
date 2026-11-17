<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import type { RealStaff } from "../staff-api";
  import type { RealLocation } from "../locations-api";
  import { readRealServices, type RealService } from "../services-api";
  import { previewStagingSlots, StagingAvailabilityError, type SlotPreview } from "../staging-availability-api";

  export let session: VerifiedOwnerSession;
  export let staff: readonly RealStaff[];
  export let locations: RealLocation[];
  export let disabled = false;
  let services: readonly RealService[] = [];
  let loading = true;
  let previewLoading = false;
  let target = "";
  let localDate = "";
  let slots: SlotPreview | null = null;
  let readError = "";
  let previewError = "";
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
    if (reason instanceof StagingAvailabilityError) {
      if (reason.reason === "unauthorized") return "Сеанс или права изменились. Войдите заново.";
      if (reason.reason === "target-unavailable") return "Назначение или действующее тестовое разрешение отсутствует.";
      if (reason.reason === "invalid-request") return "Проверьте дату и выбранное назначение.";
    }
    return "Не удалось подтвердить доступность. Повторите запрос.";
  }
  function format(value: string, zone: string): string {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset" }).format(new Date(value));
  }
  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    slots = null;
    try { services = await readRealServices(session); }
    catch (reason) { services = []; readError = describe(reason); }
    finally { loading = false; }
  }
  async function preview(): Promise<void> {
    const option = options.find(item => item.id === target);
    if (!option || !localDate || loading || previewLoading || disabled) return;
    previewLoading = true; slots = null; previewError = "";
    try {
      slots = await previewStagingSlots(session, {staffId:option.staffId, locationId:option.locationId, serviceId:option.serviceId, localDate});
    } catch (reason) {previewError = describe(reason);}
    finally { previewLoading = false; }
  }
  onMount(() => { void refresh(); });
</script>

<section class="card" aria-label="Предпросмотр записи staging">
  <div class="card-title">
    <div><span class="eyebrow">STAGING / ДОСТУПНОСТЬ</span><h2>Предпросмотр записи</h2></div>
    <Button variant="outline" type="button" disabled={disabled || loading || previewLoading} onclick={() => void refresh()}>Обновить услуги</Button>
  </div>
  {#if loading}<p role="status">Загружаем услуги…</p>
  {:else if readError}<p role="alert" class="alert-error">{readError}</p>
  {:else if options.length}
    <label class="field">Мастер, филиал и услуга
      <select value={target} disabled={previewLoading || disabled} onchange={event => {target = event.currentTarget.value; slots = null; previewError = "";}}>
        <option value="">Выберите назначение</option>
        {#each options as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
      </select>
    </label>
    <label class="field">Дата филиала
      <Input type="date" value={localDate} disabled={previewLoading || disabled} onchange={event => {localDate = event.currentTarget.value; slots = null; previewError = "";}} />
    </label>
    <Button type="button" variant="outline" disabled={!target || !localDate || previewLoading || disabled} onclick={() => void preview()}>Проверить слоты</Button>
  {:else}<p>Сначала активируйте мастера и услугу в staging.</p>{/if}
  {#if previewError}<p class="alert-error" role="alert">{previewError}</p>{/if}
  {#if previewLoading}<p role="status">Рассчитываем слоты…</p>{/if}
  {#if slots}
    <p role="status">Найдено слотов: {slots.slots.length}. Часовой пояс: {slots.timeZone}.</p>
    <div class="list-items">
      {#each slots.slots.slice(0,100) as slot (slot.startAt)}
        <p>{format(slot.startAt, slots.timeZone)} – {format(slot.endAt, slots.timeZone)}</p>
      {/each}
      {#if slots.slots.length>100}<p>Показаны первые 100 вариантов.</p>{/if}
    </div>
  {/if}
  <p class="owner-form-note">Слоты — снимок доступности, не резервирование. Шаг предпросмотра 15 минут. Финальная запись потребует отдельной атомарной проверки.</p>
</section>
