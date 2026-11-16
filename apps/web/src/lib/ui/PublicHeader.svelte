<script lang="ts">
  import { ArrowLeft, LockKeyhole } from "@lucide/svelte";

  export let organizationName: string;
  export let telegramPreview = false;
  export let demoMode = false;
  export let onBack: () => void;

  $: salonMonogram = organizationName.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "С";
</script>

<header class="public-header">
  <div class="public-brand">
    <span class="salon-monogram" aria-hidden="true">{salonMonogram}</span>
    <div class="public-brand-type">
      <strong class="salon-name">{organizationName}</strong>
      <small>Онлайн-запись в салон</small>
    </div>
  </div>
  <div class="public-header-actions">
    <span class="public-service-label">Запись онлайн</span>
  </div>
</header>

{#if demoMode}
  <div class="public-demo-notice" role="note">
    <LockKeyhole size={14} aria-hidden="true" />
    <span class="public-demo-copy">
      {telegramPreview
        ? "Предпросмотр Mini App: Telegram-авторизация не подключена"
        : "Демо: запись не передаётся на сервер"}
    </span>
    <button class="public-demo-back" type="button" onclick={onBack}>
      <ArrowLeft size={15} aria-hidden="true" />
      Вернуться в тестовый кабинет
    </button>
  </div>
{/if}
