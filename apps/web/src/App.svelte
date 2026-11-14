<script lang="ts">
  const phase = "F1 — инженерный фундамент";
</script>

<svelte:head>
  <meta name="description" content="Cookie: инженерный стенд внутреннего этапа F1." />
</svelte:head>

<main>
  <div class="surface">
    <p class="eyebrow">Cookie / Kuki</p>
    <h1>{phase}</h1>
    <p>
      Приложение находится в разработке. Бронирование, регистрация салонов и
      коммерческие операции ещё недоступны.
    </p>
    <p class="secondary">Используются только синтетические данные.</p>
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f5f6f8;
    color: #172333;
    font-family: system-ui, sans-serif;
  }
  main {
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 1.5rem;
    box-sizing: border-box;
  }
  .surface {
    max-width: 40rem;
    border: 1px solid #e1e5ea;
    border-radius: 1rem;
    background: white;
    padding: 2rem;
  }
  .eyebrow {
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  h1 {
    font-size: clamp(1.5rem, 4vw, 2.4rem);
  }
  .secondary {
    color: #556477;
    font-size: 0.9rem;
  }
</style>
