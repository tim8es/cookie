<script lang="ts">
  import { onMount } from "svelte";
  import { CalendarDays, Clock3, Info, MapPin, UserRound, X } from "@lucide/svelte";
  import { Badge } from "../components/ui/badge/index.js";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { longDate } from "../dates";
  import type { BookingView } from "../model";

  export let booking: BookingView;
  export let serviceName: (id: string) => string;
  export let staffName: (id: string) => string;
  export let locationName: (id: string) => string;
  export let onClose: () => void;

  // shadcn Button exposes a $bindable ref whose default is null, not undefined.
  let closeButton: HTMLButtonElement | null = null;
  let doneButton: HTMLButtonElement | null = null;

  // Preserve the existing verified two-action keyboard focus loop and restore
  // focus to the calendar event that opened this synthetic details sheet.
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
      onClose();
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
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="modal-backdrop" role="presentation">
  <Card.Root class="booking-detail calendar-detail-sheet"
    role="dialog" aria-modal="true"
    aria-labelledby="demo-booking-title"
    aria-describedby="demo-booking-subtitle">
    <div class="calendar-detail-header">
      <div class="calendar-detail-heading">
        <span class="calendar-detail-kicker">COOKIE / ДЕТАЛИ ВИЗИТА</span>
        <Badge variant="secondary" class="calendar-detail-status">Демо-подтверждена</Badge>
      </div>
      <Button bind:ref={closeButton} variant="ghost" size="icon"
        type="button" class="close-button" onclick={onClose} aria-label="Закрыть детали">
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
      <p>Изменение, перенос и отмена потребуют согласованных серверных команд и проверки прав.</p>
    </div>

    <Button bind:ref={doneButton} variant="outline" size="lg"
      type="button" class="btn-wide calendar-detail-close" onclick={onClose}>
      Закрыть
    </Button>
  </Card.Root>
</div>
