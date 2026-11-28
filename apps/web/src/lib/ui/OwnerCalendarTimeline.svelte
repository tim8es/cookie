<script lang="ts">
  import ScrollArea from "../components/rhythm/ScrollArea.svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { CalendarStatus, OwnerCalendar } from "../owner-calendar-api";
  import { buildDayTimeline } from "../owner-calendar-timeline";

  export let data: OwnerCalendar;
  export let onOpen: (bookingId: string) => void;

  const statusNames: Record<CalendarStatus, string> = {
    Confirmed: "Подтверждена",
    CancelledByClient: "Отменена клиентом",
    CancelledByBusiness: "Отменена салоном",
    Completed: "Завершена",
    NoShow: "Неявка",
  };
  $: timeline = buildDayTimeline(data);
  $: template = timeline
    ? "108px " + timeline.columns.map((c) => "minmax(" + c.lanes * 156 + "px, 1fr)").join(" ")
    : "";
</script>

{#if timeline}
  <section class="owner-day-timeline" aria-label="Временная сетка записей">
    <p class="owner-form-note">Показан период с записями. Пустое место не означает доступное время или рабочую смену.</p>
    <ScrollArea label="Прокрутка временной сетки" axis="x" maxSize="100%">
      <div class="owner-timeline-grid" style:grid-template-columns={template}>
        <div class="owner-timeline-heading">{data.timeZone}</div>
        {#each timeline.columns as column (column.id)}
          <h3 class="owner-timeline-heading">{column.label}</h3>
        {/each}
        <div class="owner-timeline-axis" style:height={timeline.height + "px"}>
          {#each timeline.ticks as tick (tick.top)}
            <span style:top={tick.top + "px"}>{tick.label}</span>
          {/each}
        </div>
        {#each timeline.columns as column (column.id)}
          <div class="owner-timeline-lane" style:height={timeline.height + "px"}>
            {#each column.events as event (event.entry.id)}
              <div class="owner-timeline-event" style:top={event.top + "px"}
                style:height={event.targetHeight + "px"}
                style:left={event.lane / column.lanes * 100 + "%"}
                style:width={100 / column.lanes + "%"}>
                <span class="owner-timeline-duration" style:height={event.height + "px"} aria-hidden="true"></span>
                <Button type="button" variant="outline" class="owner-timeline-button"
                  aria-label={event.time + " — " + event.endTime + ", " + event.entry.serviceName + ", " + event.entry.staffName + ", " + statusNames[event.entry.status]}
                  onclick={() => onOpen(event.entry.id)}>
                  <span>{event.carryIn ? "← " : ""}{event.time}{event.carryOut ? " →" : ""}</span>
                  <strong>{event.entry.serviceName}</strong>
                  <span class="owner-timeline-status">{statusNames[event.entry.status]}</span>
                </Button>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </ScrollArea>
  </section>
{/if}
