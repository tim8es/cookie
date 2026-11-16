<script lang="ts">
  /** The salon is the primary brand; Cookie attribution belongs in the footer. */
  export let organizationName: string;
</script>

<section class="booking-head booking-hero" aria-label="Онлайн-запись">
  <div class="booking-hero-copy">
    <span class="booking-hero-section">Запись в салон</span>
    <h1>Выберите время.<br /><em>Мы вас ждём.</em></h1>
    <p>Выберите услугу, специалиста и удобное время для визита.</p>
  </div>
  <div class="booking-hero-studio">
    <span>Вы записываетесь в</span>
    <strong>{organizationName}</strong>
    <small>Бронирование в несколько шагов</small>
  </div>
</section>
