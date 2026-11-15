<script lang="ts">
  import { onMount } from "svelte";
  import { longDate } from "../dates";
  import type { BookingView } from "../model";

  export let booking: BookingView;
  export let serviceName: (id: string) => string;
  export let staffName: (id: string) => string;
  export let locationName: (id: string) => string;
  export let onClose: () => void;

  let closeButton: HTMLButtonElement;
  let doneButton: HTMLButtonElement;

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
  <div
    class="booking-detail card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="demo-booking-title"
  >
    <div class="card-title">
      <div>
        <span class="eyebrow">КАРТОЧКА ЗАПИСИ</span>
        <h2 id="demo-booking-title">{serviceName(booking.serviceId)}</h2>
      </div>
      <button
        bind:this={closeButton}
        type="button"
        class="close-button"
        onclick={onClose}
        aria-label="Закрыть детали"
      >×</button>
    </div>
    <div class="detail-table">
      <div><span>Дата</span><strong>{longDate(booking.date)}</strong></div>
      <div><span>Время</span><strong>{booking.time}</strong></div>
      <div><span>Мастер</span><strong>{staffName(booking.staffId)}</strong></div>
      <div><span>Филиал</span><strong>{locationName(booking.locationId)}</strong></div>
      <div><span>Псевдоним</span><strong>{booking.clientAlias}</strong></div>
      <div><span>Статус</span><strong>Демо-подтверждена</strong></div>
    </div>
    <div class="inline-note">
      Изменение, перенос и отмена станут доступны только после согласования
      серверных команд и прав.
    </div>
    <button
      bind:this={doneButton}
      type="button"
      class="btn btn-secondary btn-wide"
      onclick={onClose}
    >Закрыть</button>
  </div>
</div>
