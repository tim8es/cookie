<script lang="ts">
  import { onMount } from "svelte";
  import OwnerBookingDetail from "./OwnerBookingDetail.svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import { readRealLocations, type RealLocation } from "../locations-api";
  import { CalendarReadError, readOwnerCalendar, type CalendarDays, type CalendarStatus, type OwnerCalendar } from "../owner-calendar-api";

  export let session: VerifiedOwnerSession;

  let branches: RealLocation[] = [];
  let branchId = "";
  let date = "";
  let days: CalendarDays = 1;
  let data: OwnerCalendar | null = null;
  let loading = true;
  let error = "";
  let request: AbortController | null = null;
  let mounted = false;
  let expired = false;

  const statusNames: Record<CalendarStatus, string> = {
    Confirmed: "Подтверждена",
    CancelledByClient: "Отменена клиентом",
    CancelledByBusiness: "Отменена салоном",
    Completed: "Завершена",
    NoShow: "Неявка",
  };
  const prices = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 });

  function branchToday(zone: string): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const part = (kind: string) => parts.find((p) => p.type === kind)?.value ?? "";
    return part("year") + "-" + part("month") + "-" + part("day");
  }

  function describe(reason: unknown): string {
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
    request?.abort();
    request = null;
    data = null;
    branches = [];
    loading = false;
    error = "Срок сеанса истёк. Войдите заново.";
  }

  async function load(): Promise<void> {
    if (!mounted || expired || Date.now() / 1000 >= session.expiresAtUnixSeconds) {
      if (mounted && !expired) expire();
      return;
    }
    request?.abort();
    const current = new AbortController();
    request = current;
    loading = true;
    data = null;
    error = "";
    try {
      if (!branches.length) {
        const loaded = await readRealLocations(session);
        if (request !== current || !mounted) return;
        branches = loaded.filter((branch) => branch.timeZone !== null);
      }
      if (!branches.some((branch) => branch.id === branchId)) {
        branchId = branches[0]?.id ?? "";
        date = branches[0]?.timeZone ? branchToday(branches[0].timeZone) : "";
      }
      if (!branchId) return;
      const result = await readOwnerCalendar(session, branchId, date, days, globalThis.fetch, current.signal);
      if (request === current && mounted && !current.signal.aborted) data = result;
    } catch (reason) {
      if (request === current && mounted && !current.signal.aborted) error = describe(reason);
    } finally {
      if (request === current) {
        request = null;
        loading = false;
      }
    }
  }

  function changeBranch(value: string): void {
    branchId = value;
    const branch = branches.find((item) => item.id === value);
    if (branch?.timeZone) date = branchToday(branch.timeZone);
    void load();
  }

  function move(delta: number): void {
    const next = new Date(Date.parse(date + "T00:00:00Z") + delta * days * 86400000);
    if (!Number.isFinite(next.getTime())) return;
    date = next.toISOString().slice(0, 10);
    void load();
  }

  function today(): void {
    const branch = branches.find((item) => item.id === branchId);
    if (branch?.timeZone) {
      date = branchToday(branch.timeZone);
      void load();
    }
  }

  function formatTime(value: string, timeZone: string): string {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone, dateStyle: "short", timeStyle: "short",
    }).format(new Date(value));
  }

  onMount(() => {
    mounted = true;
    const timer = window.setTimeout(expire, Math.max(0, session.expiresAtUnixSeconds * 1000 - Date.now()));
    void load();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
      request?.abort();
      request = null;
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
        <select value={branchId} onchange={(event) => changeBranch(event.currentTarget.value)} disabled={loading || expired}>
          {#each branches as branch (branch.id)}<option value={branch.id}>{branch.displayName}</option>{/each}
        </select>
      </label>
      <label class="field">Начало периода
        <Input type="date" value={date} min="2000-01-01" max="2099-12-24" onchange={(event) => { date = event.currentTarget.value; void load(); }} disabled={loading || expired} required />
      </label>
      <div class="segmented" role="group" aria-label="Период календаря">
        <Button type="button" variant={days === 1 ? "default" : "outline"} aria-pressed={days === 1} onclick={() => { days = 1; void load(); }} disabled={loading || expired}>День</Button>
        <Button type="button" variant={days === 7 ? "default" : "outline"} aria-pressed={days === 7} onclick={() => { days = 7; void load(); }} disabled={loading || expired}>Неделя</Button>
      </div>
      <div class="calendar-move" role="group" aria-label="Навигация по датам">
        <Button type="button" variant="outline" aria-label="Предыдущий период" onclick={() => move(-1)} disabled={loading || expired}>Назад</Button>
        <Button type="button" variant="outline" onclick={today} disabled={loading || expired}>Сегодня</Button>
        <Button type="button" variant="outline" aria-label="Следующий период" onclick={() => move(1)} disabled={loading || expired}>Вперёд</Button>
      </div>
    </div>
  {/if}
  {#if loading}
    <p role="status">Загружаем календарь…</p>
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
              <p>{formatTime(item.startAt, data.timeZone)} — {formatTime(item.endAt, data.timeZone)}</p>
              <p>{prices.format(Number(item.priceKopecks) / 100)}</p>
              <span class="status-pill">{statusNames[item.status]}</span>
              {#key session}
                {#key data.locationId + "/" + data.localDate + "/" + data.days}
                  <OwnerBookingDetail {session} locationId={data.locationId} bookingId={item.id} disabled={loading || expired} />
                {/key}
              {/key}
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
