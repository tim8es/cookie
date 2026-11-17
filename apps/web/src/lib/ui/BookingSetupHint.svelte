<script lang="ts">
  import { CalendarX2 } from "@lucide/svelte";
</script>

<section class="booking-unavailable" role="status" aria-labelledby="booking-unavailable-title">
  <span class="booking-unavailable-icon" aria-hidden="true">
    <CalendarX2 size={25} strokeWidth={1.7} />
  </span>
  <h2 id="booking-unavailable-title">Онлайн-запись пока недоступна</h2>
  <p>У салона пока нет полного расписания доступных услуг и специалистов. Попробуйте позже.</p>
</section>
