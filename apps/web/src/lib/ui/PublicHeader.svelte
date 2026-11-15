<script lang="ts">
  import { ArrowLeft, LockKeyhole } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";

  export let onBack: () => void;
</script>

<header class="public-header">
  <div class="public-brand">
    <span class="brand-seal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <div class="public-brand-type">
      <strong>cookie<span>.</span></strong>
      <small>студия красивого времени</small>
    </div>
  </div>
  <div class="public-header-actions">
    <span class="preview-stamp">Предпросмотр</span>
    <Button type="button" variant="outline" class="public-back" onclick={onBack}>
      <ArrowLeft size={16} aria-hidden="true" />
      <span>В кабинет</span>
    </Button>
  </div>
</header>
<div class="public-demo-notice" role="note">
  <LockKeyhole size={14} aria-hidden="true" />
  Тестовая запись — без передачи данных на сервер
</div>
