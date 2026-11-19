<script lang="ts">
  import { onMount } from "svelte";
  import { branchToday, type OwnerReads } from "../owner-reads";
  import OwnerReadPlaceholder from "./OwnerReadPlaceholder.svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { LocationApiFailure, type RealLocation } from "../locations-api";
  import { CalendarReadError, type CalendarDays, type CalendarStatus, type OwnerCalendar } from "../owner-calendar-api";

  export let session: VerifiedOwnerSession;
  export let reads: OwnerReads;

  let branches: Pick<RealLocation, "id" | "displayName" | "timeZone">[] = [];
  let branchId = "";
  let date = "";
  let days: CalendarDays = 1;
  let data: OwnerCalendar | null = null;
  let loading = true;
  let error = "";
  let requestNumber = 0;
  let mounted = false;
  let expired = false;
  $: calendarClock = data && new Intl.DateTimeFormat("ru-RU", {
    timeZone: data.timeZone, dateStyle: "short", timeStyle: "short",
  });

  const statusNames: Record<CalendarStatus, string> = {
    Confirmed: "Подтверждена",
    CancelledByClient: "Отменена клиентом",
    CancelledByBusiness: "Отменена салоном",
    Completed: "Завершена",
    NoShow: "Неявка",
  };
  const prices = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 });

  function describe(reason: unknown): string {
    if (reason instanceof LocationApiFailure && reason.reason === "unauthorized") {
      return "Сеанс завершился или права отозваны. Войдите заново.";
    }
    if (reason instanceof CalendarReadError) {
      if (reason.reason === "unauthorized") return "Сеанс завершился или права отозваны. Войдите заново.";
      if (reason.reason === "invalid-period") return "Не удалось определить этот период в часовом поясе филиала.";
      if (reason.reason === "branch-unavailable") return "Филиал или его часовой пояс недоступен.";
      if (reason.reason === "period-too-dense") return "Слишком много записей. Выберите один день или другой филиал.";
      if (reason.reason === "invalid-response") return "Не удалось подтвердить ответ календаря.";
    }
    return "Календарь недоступен. Повторите загрузку.";
  }

  function expire(): void {
    expired = true;
    requestNumber++;
    data = null;
    branches = [];
    loading = false;
    error = "Срок сеанса истёк. Войдите заново.";
  }

  async function load(fromNavigation = false): Promise<void> {
    if (!mounted || expired || Date.now() / 1000 >= session.expiresAtUnixSeconds) {
      if (mounted && !expired) expire();
      return;
    }
    const current = ++requestNumber;
    data = null;
    loading = true;
    error = "";
    try {
      if (!branches.length) {
        const loaded = await reads.calendarBranches();
        if (requestNumber !== current) return;
        branches = loaded.filter((branch) => branch.timeZone !== null);
      }
      if (!branches.some((branch) => branch.id === branchId)) {
        branchId = branches[0]?.id ?? "";
        date = branches[0]?.timeZone ? branchToday(branches[0].timeZone) : "";
      }
      if (!branchId) return;
      const calendar = reads.calendar(branchId, date, days);
      if (fromNavigation) {
        // Coalesce rapid date changes before sending a new database read.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
        if (requestNumber !== current) return;
      }
      const result = await calendar.load();
      if (requestNumber === current) data = result;
    } catch (reason) {
      if (requestNumber === current) {
        data = null;
        error = describe(reason);
      }
    } finally {
      if (requestNumber === current) loading = false;
    }
  }

  function changeBranch(value: string): void {
    branchId = value;
    const branch = branches.find((item) => item.id === value);
    if (branch?.timeZone) date = branchToday(branch.timeZone);
    void load(true);
  }

  function move(delta: number): void {
    const next = new Date(Date.parse(date + "T00:00:00Z") + delta * days * 86400000);
    if (!Number.isFinite(next.getTime())) return;
    date = next.toISOString().slice(0, 10);
    void load(true);
  }

  function today(): void {
    const branch = branches.find((item) => item.id === branchId);
    if (branch?.timeZone) {
      date = branchToday(branch.timeZone);
      void load(true);
    }
  }

  onMount(() => {
    mounted = true;
    const timer = window.setTimeout(expire, Math.max(0, session.expiresAtUnixSeconds * 1000 - Date.now()));
    void load();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
      requestNumber++;
    };
  });
</script>

<div class="section-head calendar-page-head owner-calendar-header">
  <div>
    <span class="eyebrow">kuki / ЗАПИСИ</span>
    <h1>Календарь записей</h1>
    <p>Сохранённые записи филиала. Просмотр не открывает новую запись.</p>
  </div>
  <Button type="button" variant="outline" onclick={() => void load()} disabled={loading || expired}>Обновить</Button>
</div>

<section class="card owner-calendar" aria-label="Календарь записей владельца">
  {#if branches.length}
    <div class="owner-form-fields">
      <label class="field">Филиал
        <select value={branchId} onchange={(event) => changeBranch(event.currentTarget.value)} disabled={expired}>
          {#each branches as branch (branch.id)}<option value={branch.id}>{branch.displayName}</option>{/each}
        </select>
      </label>
      <label class="field">Начало периода
        <Input type="date" value={date} min="2000-01-01" max="2099-12-24" onchange={(event) => { date = event.currentTarget.value; void load(true); }} disabled={expired} required />
      </label>
      <div class="segmented" role="group" aria-label="Период календаря">
        <Button type="button" variant={days === 1 ? "default" : "outline"} aria-pressed={days === 1} onclick={() => { days = 1; void load(true); }} disabled={expired}>День</Button>
        <Button type="button" variant={days === 7 ? "default" : "outline"} aria-pressed={days === 7} onclick={() => { days = 7; void load(true); }} disabled={expired}>Неделя</Button>
      </div>
      <div class="calendar-move" role="group" aria-label="Навигация по датам">
        <Button type="button" variant="outline" aria-label="Предыдущий период" onclick={() => move(-1)} disabled={expired}>Назад</Button>
        <Button type="button" variant="outline" onclick={today} disabled={expired}>Сегодня</Button>
        <Button type="button" variant="outline" aria-label="Следующий период" onclick={() => move(1)} disabled={expired}>Вперёд</Button>
      </div>
    </div>
  {/if}
  {#if loading && !data}
    <OwnerReadPlaceholder label="Загружаем календарь…" />
  {:else if error}
    <div class="alert-error" role="alert"><p>{error}</p></div>
  {:else if !branches.length}
    <div class="empty-mini"><strong>Нет филиалов с часовым поясом</strong></div>
  {:else if data}
    <p>Часовой пояс: {data.timeZone}. Записей: {data.entries.length}.</p>
    {#if !data.entries.length}
      <div class="empty-mini"><strong>За выбранный период записей нет</strong><p>Это не означает, что всё время доступно для бронирования.</p></div>
    {:else}
      <div class="list-items" aria-label="Записи за выбранный период">
        {#each data.entries as item (item.id)}
          <div class="schedule-summary">
            <div>
              <strong>{item.serviceName}</strong>
              <p>{item.staffName}</p>
              <p>{calendarClock?.format(new Date(item.startAt))} — {calendarClock?.format(new Date(item.endAt))}</p>
              <p>{prices.format(Number(item.priceKopecks) / 100)}</p>
              <span class="status-pill">{statusNames[item.status]}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <p class="owner-form-note">Стоимость сохранена при бронировании. Названия услуг и мастеров — из текущего справочника.</p>
  {/if}
</section>

<style>
  .owner-calendar-header {
    flex-wrap: wrap;
    min-width: 0;
  }
  .owner-calendar-header > div,
  .owner-calendar {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .owner-calendar .field {
    min-width: 0;
    width: 100%;
  }
  .owner-calendar .field select,
  .owner-calendar .field :global(input) {
    min-width: 0;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  .owner-calendar .calendar-move,
  .owner-calendar .segmented {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
  }
  .owner-calendar .calendar-move :global(button),
  .owner-calendar .segmented :global(button) {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
  }
  .owner-calendar .schedule-summary > div {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
