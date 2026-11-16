<script lang="ts">
  import { Unplug } from "@lucide/svelte";
  import * as Card from "../components/ui/card/index.js";
</script>

<Card.Root class="state-card feedback-state" role="status">
  <div class="feedback-icon" aria-hidden="true"><Unplug size={27} /></div>
  <span class="feedback-overline">COOKIE / API MODE</span>
  <h1>API пока не подключён</h1>
  <p>Серверные контракты и авторизация ещё не утверждены для публичного Web-клиента. Записи и данные календаря не загружаются, запросы к серверу не отправляются.</p>
  <p>Для отдельной демонстрации с синтетическими данными используется режим <code>VITE_COOKIE_DATA_MODE=mock</code>.</p>
</Card.Root>
