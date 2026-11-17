<script lang="ts">
  import { CheckCircle2, LockKeyhole, LoaderCircle, LogOut, ShieldAlert } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";

  type Phase =
    | "unavailable"
    | "loading"
    | "verified"
    | "error"
    | "signing-out"
    | "signed-out"
    | "logout-failed"
    | "expired";
  export let phase: Phase;
  export let onLogout: () => void;
</script>

<Card.Root class="state-card feedback-state" role="status" aria-live="polite">
  <div class="feedback-icon" aria-hidden="true">
    {#if phase === "verified"}
      <CheckCircle2 size={27} />
    {:else if phase === "loading" || phase === "signing-out"}
      <LoaderCircle size={27} />
    {:else if phase === "error" || phase === "logout-failed"}
      <ShieldAlert size={27} />
    {:else}
      <LockKeyhole size={27} />
    {/if}
  </div>
  <span class="feedback-overline">kuki / ПРОВЕРЕННЫЙ ВХОД</span>
  {#if phase === "verified"}
    <h1>Вход владельца подтверждён</h1>
    <p>Сервер проверил Telegram-подпись, действующую сессию и доступ к организации. Данные календаря и формы управления пока закрыты до подключения защищённого API.</p>
    <Button class="feedback-action" type="button" onclick={onLogout}><LogOut size={16} /> Выйти</Button>
  {:else if phase === "loading"}
    <h1>Проверяем доступ</h1>
    <p>Подтверждаем вход и доступ к салону на сервере. До завершения проверки управление недоступно.</p>
  {:else if phase === "signing-out"}
    <h1>Завершаем сеанс</h1>
    <p>Отзываем серверный токен доступа.</p>
  {:else if phase === "error"}
    <h1>Вход не подтверждён</h1>
    <p>Проверка сервером не завершилась успешно. Откройте Mini App заново из Telegram после подтверждённой привязки владельца. Повторное использование прежнего одноразового доказательства не допускается.</p>
  {:else if phase === "logout-failed"}
    <h1>Локальный доступ закрыт</h1>
    <p>Токен удалён из памяти вкладки, но отзыв на сервере не подтверждён. Действие старой сессии может сохраниться до истечения её срока (не более 15 минут). Не используйте этот сеанс повторно.</p>
  {:else if phase === "expired"}
    <h1>Срок действия сеанса истёк</h1>
    <p>Кабинет закрыт, локальный токен удалён. Для нового входа откройте Mini App заново через Telegram.</p>
  {:else if phase === "signed-out"}
    <h1>Вы вышли</h1>
    <p>Серверная сессия отозвана, локальный токен удалён. Для нового входа откройте Mini App заново через Telegram.</p>
  {:else}
    <h1>Откройте kuki через Telegram</h1>
    <p>Для входа требуется проверенное Telegram Mini App с привязкой владельца на сервере. Прямой переход на сайт не предоставляет авторизацию. Демо-данные не подменяют настоящую сессию.</p>
  {/if}
</Card.Root>
