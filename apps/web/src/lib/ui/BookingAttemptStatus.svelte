<script lang="ts">
  import { AlertCircle, CheckCircle2, LoaderCircle } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { bookingFeedback, type ClientBookingState } from "../booking-attempt-view";

  export let state: ClientBookingState;
  /** Caller must use BookingAttempt.retry(), never create a fresh request key. */
  export let onRetry: () => void;
  /** Caller maps the refreshed slot to the next selected booking draft. */
  export let onChooseSlot: (time: string) => void;
  export let onEditSelection: () => void;

  $: feedback = bookingFeedback(state);
</script>

{#if feedback}
  <Card.Root
    class="booking-attempt-status"
    role={feedback.announce}
    aria-live={feedback.announce === "status" ? "polite" : "assertive"}
    aria-atomic="true"
  >
    <div class="booking-attempt-status-heading">
      {#if state.phase === "submitting"}
        <LoaderCircle size={25} aria-hidden="true" />
      {:else if state.phase === "confirmed"}
        <CheckCircle2 size={25} aria-hidden="true" />
      {:else}
        <AlertCircle size={25} aria-hidden="true" />
      {/if}
      <h2>{feedback.title}</h2>
    </div>
    <p>{feedback.description}</p>

    {#if state.phase === "confirmed"}
      <dl class="booking-attempt-receipt">
        <div><dt>Номер записи</dt><dd>{state.receipt.bookingId}</dd></div>
        <div><dt>Дата и время</dt><dd>{state.receipt.dateTimeText}</dd></div>
        <div><dt>Фактическая стоимость</dt><dd>{state.receipt.finalPriceText}</dd></div>
      </dl>
    {:else if state.phase === "conflict"}
      {#if !state.refreshFailed && state.slots.length > 0}
        <div class="booking-attempt-slot-options" aria-label="Обновлённые интервалы">
          {#each state.slots as slot (slot.time)}
            <Button type="button" variant="outline" onclick={() => onChooseSlot(slot.time)}>{slot.label}</Button>
          {/each}
        </div>
      {/if}
      <Button type="button" variant="outline" onclick={onEditSelection}>Изменить дату или мастера</Button>
    {:else if state.phase === "error" && feedback.canRetry}
      <Button type="button" onclick={onRetry}>Повторить проверку записи</Button>
    {/if}
  </Card.Root>
{/if}
