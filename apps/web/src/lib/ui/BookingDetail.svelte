<script lang="ts">
  import { onMount } from "svelte";
  import { CalendarDays, Clock3, Info, MapPin, UserRound, X } from "@lucide/svelte";
  import { Badge } from "../components/ui/badge/index.js";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { longDate } from "../dates";
  import type { BookingView, SlotView } from "../model";

  export let booking: BookingView;
  export let serviceName: (id: string) => string;
  export let staffName: (id: string) => string;
  export let locationName: (id: string) => string;
  export let onReadMoveSlots: (date: string) => Promise<SlotView[]>;
  export let onReschedule: (date: string, time: string) => Promise<void>;
  export let onCancel: () => Promise<void>;
  export let onClose: () => void;

  let closeButton: HTMLButtonElement | null = null;
  let doneButton: HTMLButtonElement | null = null;
  let mode: "view" | "move" | "cancel" = "view";
  let movingDate = booking.date;
  let movingTime = "";
  let availableSlots: SlotView[] = [];
  let loadingSlots = false;
  let busy = false;
  let actionError = "";
  let slotVersion = 0;

  // The X is first and "Закрыть" is last in each state, so Tab is free to
  // traverse any intermediate action/form controls. Both ends stay trapped.
  onMount(() => {
    const previousFocus = document.activeElement;
    closeButton?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  });

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (busy) return;
      if (mode !== "view") {
        mode = "view";
        actionError = "";
        slotVersion += 1;
      } else {
        onClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    if (event.shiftKey && document.activeElement === closeButton) {
      event.preventDefault();
      doneButton?.focus();
    } else if (!event.shiftKey && document.activeElement === doneButton) {
      event.preventDefault();
      closeButton?.focus();
    }
  }

  async function loadMoveSlots(date: string): Promise<void> {
    const version = ++slotVersion;
    movingDate = date;
    movingTime = "";
    availableSlots = [];
    actionError = "";
    loadingSlots = true;
    try {
      const slots = await onReadMoveSlots(date);
      if (version === slotVersion) availableSlots = slots;
    } catch (reason) {
      if (version === slotVersion) {
        actionError = reason instanceof Error ? reason.message : "Не удалось получить демо-слоты.";
      }
    } finally {
      if (version === slotVersion) loadingSlots = false;
    }
  }

  function startMove(): void {
    mode = "move";
    void loadMoveSlots(booking.date);
  }

  async function applyMove(): Promise<void> {
    if (!movingDate || !movingTime || busy || loadingSlots) return;
    busy = true;
    actionError = "";
    try {
      await onReschedule(movingDate, movingTime);
      onClose();
    } catch (reason) {
      actionError = reason instanceof Error ? reason.message : "Не удалось перенести демо-запись.";
    } finally {
      busy = false;
    }
  }

  async function applyCancel(): Promise<void> {
    if (busy) return;
    busy = true;
    actionError = "";
    try {
      await onCancel();
      onClose();
    } catch (reason) {
      actionError = reason instanceof Error ? reason.message : "Не удалось отменить демо-запись.";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="modal-backdrop" role="presentation">
  <Card.Root class="booking-detail calendar-detail-sheet"
    role="dialog" aria-modal="true"
    aria-labelledby="demo-booking-title"
    aria-describedby="demo-booking-subtitle">
    <div class="calendar-detail-header">
      <div class="calendar-detail-heading">
        <span class="calendar-detail-kicker">kuki / ДЕТАЛИ ВИЗИТА</span>
        <Badge variant="secondary" class="calendar-detail-status">
          {booking.status === "demo-cancelled" ? "Отменена локально" : "Демо-подтверждена"}
        </Badge>
      </div>
      <Button bind:ref={closeButton} variant="ghost" size="icon"
        type="button" class="close-button" onclick={onClose}
        disabled={busy} aria-label="Закрыть детали">
        <X size={19} aria-hidden="true" />
      </Button>
    </div>

    <div class="calendar-detail-hero">
      <div class="calendar-detail-icon" aria-hidden="true"><CalendarDays size={24}/></div>
      <h2 id="demo-booking-title">{serviceName(booking.serviceId)}</h2>
      <p id="demo-booking-subtitle">Локальная тестовая запись. Время на сервере не резервировалось.</p>
    </div>

    <dl class="detail-table calendar-detail-table">
      <div>
        <dt><CalendarDays size={16} aria-hidden="true"/> Дата</dt>
        <dd>{longDate(booking.date)}</dd>
      </div>
      <div>
        <dt><Clock3 size={16} aria-hidden="true"/> Время</dt>
        <dd>{booking.time}</dd>
      </div>
      <div>
        <dt><UserRound size={16} aria-hidden="true"/> Мастер</dt>
        <dd>{staffName(booking.staffId)}</dd>
      </div>
      <div>
        <dt><MapPin size={16} aria-hidden="true"/> Филиал</dt>
        <dd>{locationName(booking.locationId)}</dd>
      </div>
      <div>
        <dt><UserRound size={16} aria-hidden="true"/> Псевдоним</dt>
        <dd>{booking.clientAlias}</dd>
      </div>
    </dl>

    <div class="calendar-detail-note">
      <Info size={16} aria-hidden="true"/>
      <p>
        {booking.status === "demo-cancelled"
          ? "Запись отменена в этой вкладке. Реальный сервер и мастер не уведомлены."
          : "Действия ниже меняют только локальные демо-данные. Настоящие перенос и отмена требуют подтверждения сервера."}
      </p>
    </div>

    {#if booking.status === "demo-confirmed" && mode === "view"}
      <div class="calendar-demo-actions" aria-label="Локальное управление записью">
        <Button type="button" variant="outline" class="calendar-demo-reschedule"
          onclick={startMove} disabled={busy}>Перенести демо-запись</Button>
        <Button type="button" variant="outline" class="calendar-demo-cancel"
          onclick={() => mode = "cancel"} disabled={busy}>Отменить демо-запись</Button>
      </div>
    {:else if booking.status === "demo-confirmed" && mode === "move"}
      <form class="calendar-move-form" onsubmit={(event) => { event.preventDefault(); void applyMove(); }}>
        <h3>Перенос демо-записи</h3>
        <label>
          Новая дата
          <input type="date" value={movingDate}
            onchange={(event) => void loadMoveSlots(event.currentTarget.value)} required />
        </label>
        <label>
          Доступное тестовое время
          <select value={movingTime}
            onchange={(event) => movingTime = event.currentTarget.value}
            disabled={loadingSlots || !availableSlots.length} required>
            <option value="">Выберите время</option>
            {#each availableSlots as slot (slot.time)}
              <option value={slot.time}>{slot.label}</option>
            {/each}
          </select>
        </label>
        {#if loadingSlots}
          <p role="status">Проверяем демонстрационные интервалы…</p>
        {:else if !availableSlots.length}
          <p role="status">На выбранную дату демонстрационных интервалов нет.</p>
        {/if}
        <div class="calendar-demo-actions">
          <Button type="submit" disabled={!movingTime || busy || loadingSlots} class="calendar-move-save">
            Сохранить локальный перенос
          </Button>
          <Button type="button" variant="outline" disabled={busy}
            onclick={() => { mode = "view"; actionError = ""; slotVersion += 1; }}>
            Назад
          </Button>
        </div>
      </form>
    {:else if booking.status === "demo-confirmed" && mode === "cancel"}
      <div class="calendar-cancel-confirm">
        <p>Отменить эту тестовую запись? Она останется в истории, а выбранный демо-слот можно будет использовать снова.</p>
        <div class="calendar-demo-actions">
          <Button type="button" class="calendar-confirm-cancel"
            disabled={busy} onclick={() => void applyCancel()}>
            Подтвердить локальную отмену
          </Button>
          <Button type="button" variant="outline" disabled={busy}
            onclick={() => { mode = "view"; actionError = ""; }}>Назад</Button>
        </div>
      </div>
    {/if}

    {#if actionError}
      <p class="calendar-demo-error" role="alert">{actionError}</p>
    {/if}

    <Button bind:ref={doneButton} variant="outline" size="lg"
      type="button" class="btn-wide calendar-detail-close"
      onclick={onClose} disabled={busy}>Закрыть</Button>
  </Card.Root>
</div>
