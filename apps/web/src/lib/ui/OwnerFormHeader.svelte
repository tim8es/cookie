<script lang="ts">
  import { CalendarClock, MapPin, Scissors, UserRound } from "@lucide/svelte";

  /** Shared header for owner forms. Presentation only; no adapter calls. */
  export let kind: "service" | "staff" | "schedule" | "location";
  export let title: string;
  export let description: string;
  export let eyebrow: string;
</script>

<div class="owner-form-heading">
  <div class="owner-form-heading-row">
    <div class="owner-form-icon" aria-hidden="true">
      {#if kind === "service"}<Scissors size={20} strokeWidth={1.8} />
      {:else if kind === "staff"}<UserRound size={20} strokeWidth={1.8} />
      {:else if kind === "schedule"}<CalendarClock size={20} strokeWidth={1.8} />
      {:else}<MapPin size={20} strokeWidth={1.8} />{/if}
    </div>
    <span class="owner-form-eyebrow">{eyebrow}</span>
  </div>
  <h2>{title}</h2>
  <p>{description}</p>
</div>
