<script lang="ts">
  import { onMount } from "svelte";
  import ActionButton from "../components/rhythm/ActionButton.svelte";
  import MetricStrip from "../components/rhythm/MetricStrip.svelte";
  import VisitRow from "../components/rhythm/VisitRow.svelte";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { branchToday, type OwnerReads } from "../owner-reads";
  import { CalendarReadError, type CalendarStatus, type OwnerCalendar } from "../owner-calendar-api";
  import { summarizeOwnerDay } from "../owner-overview-day";
  import type { WorkspaceLocation } from "../workspace-overview-api";
  import OwnerReadPlaceholder from "./OwnerReadPlaceholder.svelte";

  export let session: VerifiedOwnerSession;
  export let reads: OwnerReads;
  export let locations: readonly WorkspaceLocation[];
  export let selectedId = "";
  export let onOpenCalendar: (locationId: string) => void;

  let data: OwnerCalendar | null = null;
  let loading = false;
  let error = "";
  let generation = 0;
  const limit = 10;
  const currency = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
  const statusNames: Record<CalendarStatus, string> = {
    Confirmed: "Подтверждена",
    CancelledByClient: "Отменена клиентом",
    CancelledByBusiness: "Отменена салоном",
    Completed: "Завершена",
    NoShow: "Неявка",
  };

  $: branches = locations.filter((location) => location.timeZone !== null);
  $: summary = data ? summarizeOwnerDay(data.entries) : null;
  $: clock = data ? new Intl.DateTimeFormat("ru-RU", {
    timeZone: data.timeZone, dateStyle: "short", timeStyle: "short",
  }) : null;

  async function load(id: string): Promise<void> {
    const current = ++generation;
    selectedId = id;
    data = null;
    error = "";
    loading = false;
    const branch = locations.find((location) => location.locationId === id);
    if (!branch?.timeZone) return;
    loading = true;
    try {
      const date = branchToday(branch.timeZone);
      const result = await reads.calendar(id, date, 1).load();
      if (generation !== current) return;
      if (result.localDate !== branchToday(result.timeZone)) {
        error = "Дата филиала изменилась. Обновите ленту.";
        return;
      }
      data = result;
    } catch (reason) {
      if (generation !== current) return;
      error = reason instanceof CalendarReadError && reason.reason === "period-too-dense"
        ? "Слишком много записей для обзора. Откройте календарь."
        : reason instanceof CalendarReadError && reason.reason === "unauthorized"
          ? "Сеанс завершился или права изменились. Войдите заново."
          : "Не удалось загрузить записи филиала.";
    } finally {
      if (generation === current) loading = false;
    }
  }

  onMount(() => {
    const initial = branches.find((branch) => branch.locationId === selectedId) ?? branches[0];
    void load(initial?.locationId ?? "");
    return () => { generation++; };
  });
</script>

<section class="card owner-day-overview" aria-label="Лента дня">
  <h2>Лента дня</h2>
  {#if branches.length}
    <label class="field">Филиал ленты
      <select value={selectedId} onchange={(event) => void load(event.currentTarget.value)}>
        {#each branches as branch (branch.locationId)}
          <option value={branch.locationId}>{branch.displayName}</option>
        {/each}
      </select>
    </label>
    {#if loading}
      <OwnerReadPlaceholder label="Загружаем записи филиала…" />
    {:else if error}
      <p class="alert-error" role="alert">{error}</p>
      <ActionButton onclick={() => void load(selectedId)}>Повторить загрузку</ActionButton>
    {:else if data && summary && clock}
      <p class="owner-form-note">Дата: {data.localDate}. Часовой пояс: {data.timeZone}.</p>
      <MetricStrip label="Показатели дня филиала" storageKey={"kuki:owner:overview:metrics:" + session.tenantId}
        items={[
          { id: "visits", label: "Записи за день", value: String(summary.entries) },
          { id: "cost", label: "Стоимость подтверждённых", value: currency.format(summary.confirmedPriceKopecks / 100) },
          { id: "staff", label: "Мастеров с подтверждёнными", value: summary.confirmedStaff === null ? "—" : String(summary.confirmedStaff) },
        ]} />
      <p class="owner-form-note">Стоимость записей не означает полученную оплату. Учитываются записи, пересекающие день филиала.</p>
      {#if data.entries.length}
        {#each data.entries.slice(0, limit) as entry (entry.id)}
          <VisitRow visit={{
            time: clock.format(new Date(entry.startAt)),
            title: entry.serviceName,
            subtitle: entry.staffName,
            status: statusNames[entry.status],
            amountLabel: currency.format(Number(entry.priceKopecks) / 100),
          }} />
        {/each}
        {#if data.entries.length > limit}
          <p>Первые {limit} из {data.entries.length} записей. Остальные — в календаре.</p>
        {/if}
      {:else}
        <p class="empty-mini">На сегодня записей нет.</p>
      {/if}
    {/if}
    <ActionButton onclick={() => onOpenCalendar(selectedId)}>Весь календарь</ActionButton>
  {:else}
    <p class="empty-mini">Нет филиалов с настроенным часовым поясом.</p>
  {/if}
</section>

<style>
  .owner-day-overview {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    margin-bottom: 16px;
  }
  .owner-day-overview select {
    min-width: 0;
    max-width: 100%;
    width: 100%;
  }
</style>
