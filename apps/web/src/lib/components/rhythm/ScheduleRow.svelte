<script lang="ts">
  import RecordRow from "./RecordRow.svelte";
  import ActionButton from "./ActionButton.svelte";
  import type { ScheduleDisplay } from "./contracts.js";

  let {
    schedule,
    onEdit,
  }: {
    schedule: ScheduleDisplay;
    onEdit?: () => void;
  } = $props();
</script>

<div data-component="ScheduleRow">
  <RecordRow record={{ title: schedule.label, subtitle: schedule.period, detail: schedule.status }}>
    {#snippet action()}
      {#if onEdit}<ActionButton label={"Изменить смену: " + schedule.label} onclick={onEdit}>Изменить</ActionButton>{/if}
    {/snippet}
  </RecordRow>
</div>
