<script lang="ts">
  import { ArrowLeft, LockKeyhole } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";

  export let organizationName: string;
  export let telegramPreview = false;
  export let onBack: () => void;
</script>

<header class="public-header">
  <div class="public-brand">
    <span class="brand-seal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <div class="public-brand-type">
      <strong class="salon-name">{organizationName}</strong>
      <small>Онлайн-запись в салон</small>
    </div>
  </div>
  <div class="public-header-actions">
    <span class="preview-stamp">{telegramPreview ? "Mini App · демо" : "Демо"} <span class="powered-by">· на платформе Cookie</span></span>
    <Button type="button" variant="outline" class="public-back" aria-label="Вернуться в демонстрационный кабинет" onclick={onBack}>
      <ArrowLeft size={16} aria-hidden="true" />
      <span>В кабинет</span>
    </Button>
  </div>
</header>
<div class="public-demo-notice" role="note">
  <LockKeyhole size={14} aria-hidden="true" />
  {telegramPreview ? "Визуальный предпросмотр Mini App: Telegram-авторизация и нативные кнопки не подключены" : "Тестовая запись — без передачи данных на сервер"}
</div>
