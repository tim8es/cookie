<script lang="ts">
  import { ArrowLeft, CalendarCheck2, ShieldCheck } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Badge } from "../components/ui/badge/index.js";

  export let onBack: () => void;
</script>

<header class="public-header">
  <div class="public-brand">
    <span class="public-brand-icon" aria-hidden="true">
      <CalendarCheck2 size={19} strokeWidth={2} />
    </span>
    <div>
      <strong>cookie<span>.</span></strong>
      <small>онлайн-запись</small>
    </div>
  </div>
  <div class="public-header-actions">
    <Badge variant="outline" class="public-demo-status">Предпросмотр</Badge>
    <Button type="button" variant="outline" size="lg" class="public-back" onclick={onBack}>
      <ArrowLeft size={16} aria-hidden="true" />
      В кабинет
    </Button>
  </div>
</header>
<div class="public-demo-notice" role="note">
  <ShieldCheck size={15} aria-hidden="true" />
  Демо-режим · запись не отправляется на сервер
</div>
