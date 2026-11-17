<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import type { RealStaff, RealStaffLocation } from "../staff-api";
  import type { RealService } from "../services-api";
  import {
    publishStagingStaff, readStagingPublicationCapacity, StagingPublicationError,
    type StagingCapacity, type StagingPublicationInput,
  } from "../staging-publication-api";

  export let session: VerifiedOwnerSession;
  export let staff: readonly RealStaff[];
  export let locations: readonly RealStaffLocation[];
  export let services: readonly RealService[];
  export let disabled = false;
  export let pending = false;
  export let onPublished: () => Promise<void>;

  let capacity: StagingCapacity | null = null;
  let loading = true;
  let readError = "";
  let writeError = "";
  let notice = "";
  let selection = "";
  let confirmed = false;
  let retry: { input: StagingPublicationInput; key: string; label: string } | null = null;
  $: options = staff.filter((member) => member.active && !member.bookable).flatMap((member) =>
    member.assignments.flatMap((assignment) => {
      const location = locations.find((item) => item.id === assignment.locationId);
      return assignment.serviceIds.flatMap((serviceId) => {
        const service = services.find((item) => item.id === serviceId);
        if (!location || !service) return [];
        return [{
          id: member.id + ":" + location.id + ":" + service.id,
          label: member.displayName + " · " + location.displayName + " · " + service.displayName + " (" + service.durationMinutes + " мин.)",
          input: { staffId: member.id, locationId: location.id, serviceId: service.id,
            expectedServiceRevision: service.revision },
        }];
      });
    }));
  $: selected = options.find((option) => option.id === selection);
  $: canPublish = capacity?.state === "active" && capacity.seatLimit !== null &&
    capacity.usedSeats < capacity.seatLimit;

  const descriptions: Record<StagingCapacity["state"], string> = {
    disabled: "Режим тестовой активации выключен.",
    unconfigured: "Оператор ещё не выдал тестовое разрешение.",
    active: "Разрешение активно; лимит проверяется сервером.",
    expired: "Срок тестового разрешения истёк.",
    revoked: "Тестовое разрешение отозвано.",
  };
  function describe(reason: unknown): string {
    if (reason instanceof StagingPublicationError) {
      if (reason.reason === "unauthorized") return "Сеанс или права изменились. Войдите заново.";
      if (reason.reason === "grant-unavailable") return "Разрешение отсутствует, истекло или отозвано.";
      if (reason.reason === "seat-limit") return "Лимит мастеров исчерпан. Черновики по-прежнему доступны.";
      if (reason.reason === "already-bookable") return "Мастер уже активирован.";
      if (reason.reason === "stale-revision") return "Услуга изменилась. Обновите данные перед активацией.";
      if (reason.reason === "target-unavailable") return "Мастер, услуга или назначение недоступны.";
      if (reason.reason === "idempotency-conflict") return "Ключ операции уже использован.";
    }
    return "Сервер не подтвердил операцию. Повторите тот же запрос.";
  }

  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    capacity = null;
    try { capacity = await readStagingPublicationCapacity(session); }
    catch (reason) { readError = describe(reason); }
    finally { loading = false; }
  }
  async function publish(): Promise<void> {
    if (pending || disabled || loading) return;
    if (!retry) {
      if (!canPublish || !selected || !confirmed) return;
      retry = { input: { ...selected.input }, key: crypto.randomUUID(), label: selected.label };
    }
    pending = true;
    writeError = "";
    notice = "";
    try {
      await publishStagingStaff(session, retry.input, retry.key);
      retry = null;
      selection = "";
      confirmed = false;
      notice = "Тестовая активация подтверждена сервером. Смены не опубликованы; запись клиентов не включена.";
      await onPublished();
      await refresh();
    } catch (reason) {
      writeError = describe(reason);
      if (reason instanceof StagingPublicationError &&
          reason.reason !== "unavailable" && reason.reason !== "invalid-response") {
        retry = null;
        confirmed = false;
        selection = "";
        await onPublished();
        await refresh();
      }
    } finally { pending = false; }
  }

  onMount(() => { void refresh(); });
</script>

<section class="card" aria-label="Тестовая активация мастеров">
  <div class="card-title">
    <div><span class="eyebrow">STAGING / ЛИМИТ МАСТЕРОВ</span><h2>Тестовая активация</h2></div>
    <Button type="button" variant="outline" disabled={loading || pending || disabled} onclick={() => void refresh()}>Обновить лимит</Button>
  </div>
  {#if loading}
    <p role="status">Проверяем разрешение…</p>
  {:else if readError}
    <p class="alert-error" role="alert">{readError}</p>
  {:else if capacity}
    <p>{descriptions[capacity.state]}</p>
    <p><strong>Активных мастеров: {capacity.usedSeats}{capacity.seatLimit !== null ? " / " + capacity.seatLimit : ""}</strong></p>
    {#if capacity.expiresAt}<p>Действует до {new Date(capacity.expiresAt).toLocaleString("ru-RU")} (местное время устройства).</p>{/if}
    {#if capacity.state === "active" && !canPublish}<p>Лимит достигнут. Создание черновиков не ограничивается этим разрешением.</p>{/if}
  {/if}
  {#if writeError}<p class="alert-error" role="alert">{writeError}</p>{/if}
  {#if notice}<p class="alert-ok" role="status">{notice}</p>{/if}
  {#if retry}
    <p>Ответ не подтверждён. Повторите запрос для: {retry.label}</p>
    <Button type="button" disabled={pending || loading || disabled} onclick={() => void publish()}>{pending ? "Проверяем…" : "Повторить активацию"}</Button>
  {:else if canPublish}
    {#if options.length === 0}
      <p>Нет черновиков мастеров с назначенной услугой.</p>
    {:else}
      <label class="field">Мастер, филиал и услуга
        <select value={selection} disabled={pending || disabled || loading}
          onchange={(event) => { selection = event.currentTarget.value; confirmed = false; writeError = ""; }}>
          <option value="">Выберите назначение</option>
          {#each options as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
        </select>
      </label>
      <label class="field">
        <span><input type="checkbox" bind:checked={confirmed} disabled={!selected || pending || disabled || loading} />
          Активировать выбранного мастера, филиальное назначение и услугу только в тестовой среде.</span>
      </label>
      <Button type="button" disabled={!selected || !confirmed || pending || disabled || loading} onclick={() => void publish()}>Активировать для staging</Button>
    {/if}
  {/if}
  <p class="owner-form-note">Не является платной подпиской, не включает оплату, смены или публичную запись. Только синтетические тестовые данные.</p>
</section>
