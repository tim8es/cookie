<script lang="ts">
  /** Studio identity only. Booking state and slot availability belong to App. */
  export let organizationName: string;
</script>

<section class="booking-head booking-hero" aria-label="Онлайн-запись">
  <div class="booking-hero-copy">
    <span class="booking-hero-section">Cookie / запись к мастеру</span>
    <h1>Выберите время.<br /><em>Мы вас ждём.</em></h1>
    <p>Услуга, специалист и подходящее время — всё для записи в одном месте.</p>
  </div>
  <div class="booking-hero-studio">
    <div class="hero-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <span>Ваша студия</span>
    <strong>{organizationName}</strong>
    <small>Демонстрационная запись</small>
  </div>
</section>
