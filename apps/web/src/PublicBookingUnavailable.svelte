<script lang="ts">
  // No tenant context or session lookup: public publication is not implemented.
  import "./styles.css";
  import "./visual-system.css";
</script>

<svelte:head>
  <title>kuki — онлайн-запись недоступна</title>
  <meta name="description" content="Публичная онлайн-запись пока не подключена." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<main class="public-booking-entry" data-kuki-public-booking="unavailable">
  <section class="state-card feedback-state public-booking-message" aria-labelledby="public-booking-title">
    <p class="public-booking-brand">kuki</p>
    <h1 id="public-booking-title">Публичная запись ещё не подключена</h1>
    <p role="status">По этой ссылке пока нельзя выбрать услугу или подтвердить запись.</p>
    <p>Уточните у салона доступный способ записи.</p>
  </section>
</main>

<style>
  .public-booking-entry {
    display: grid;
    min-height: 100dvh;
    place-items: center;
    padding: 1.5rem;
  }

  .public-booking-message {
    width: min(100%, 34rem);
  }

  .public-booking-brand {
    font-weight: 700;
    letter-spacing: 0.04em;
  }
</style>
