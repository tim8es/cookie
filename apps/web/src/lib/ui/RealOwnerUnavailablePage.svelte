<script lang="ts">
  import { Button } from "../components/ui/button/index.js";
  export let screen: "appearance" | "booking";
  export let onReturn: () => void;
</script>

<div class="section-head">
  <div>
    <span class="eyebrow">COOKIE / КАБИНЕТ</span>
    <h1>{screen === "appearance" ? "Оформление" : "Онлайн-запись"}</h1>
  </div>
</div>
<section class="card" role="status">
  {#if screen === "appearance"}
    <h2>Редактор оформления пока недоступен</h2>
    <p>Серверное хранилище существует, но защищённый редактор ещё не подключён. Изменения не сохраняются локально вместо сервера.</p>
  {:else}
    <h2>Клиентская запись — отдельный вход</h2>
    <p>Для тестирования клиентской записи используйте отдельный проверенный клиентский запуск Telegram Mini App в staging. Кабинет владельца не получает права клиента автоматически. Создание записи от имени владельца пока не подключено.</p>
    <p>Клиентский маршрут: <code>/?surface=customer-staging</code></p>
  {/if}
  <Button type="button" variant="outline" onclick={onReturn}>Вернуться в обзор</Button>
</section>
