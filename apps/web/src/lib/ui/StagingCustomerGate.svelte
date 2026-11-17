<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { authenticateTelegramCustomer, loadTelegramInitData, revokeTelegramOwnerSession, type VerifiedCustomerSession } from "../owner-auth";
  let session: VerifiedCustomerSession | null = null;
  let phase: "loading" | "unavailable" | "verified" | "error" | "signing-out" | "signed-out" | "logout-failed" = "loading";
  async function signIn(): Promise<void> {
    try {
      const proof = await loadTelegramInitData(window, document);
      if (!proof) { phase = "unavailable"; return; }
      session = await authenticateTelegramCustomer(proof);
      phase = "verified";
    } catch {
      session = null;
      phase = "error";
    }
  }
  async function logout(): Promise<void> {
    const current = session;
    if (!current) return;
    session = null;
    phase = "signing-out";
    try { await revokeTelegramOwnerSession(current); phase = "signed-out"; }
    catch { phase = "logout-failed"; }
  }
  onMount(() => { void signIn(); });
</script>

<Card.Root class="state-card feedback-state" aria-label="Клиентский вход staging">
  <span class="feedback-overline">COOKIE / КЛИЕНТСКИЙ ВХОД STAGING</span>
  {#if phase === "verified" && session}
    <h1>Вход клиента подтверждён</h1>
    <p>Сервер подтвердил вашу клиентскую учётную запись в тестовой организации. Это не даёт доступа к кабинету владельца.</p>
    <p>Создание и изменение записей пока недоступны. Реальные клиентские данные не используются.</p>
    <Button type="button" onclick={() => void logout()}>Выйти</Button>
  {:else if phase === "loading"}
    <h1>Проверяем вход клиента</h1>
    <p role="status">Подтверждаем серверную сессию и принадлежность клиентской записи.</p>
  {:else if phase === "signing-out"}
    <h1>Завершаем сеанс</h1>
  {:else if phase === "signed-out"}
    <h1>Вы вышли</h1>
    <p>Серверный токен отозван. Откройте Mini App заново для входа.</p>
  {:else if phase === "logout-failed"}
    <h1>Локальный доступ закрыт</h1>
    <p>Отзыв на сервере не подтверждён. Не используйте прежний сеанс.</p>
  {:else}
    <h1>Вход клиента не подтверждён</h1>
    <p>Требуется свежая проверенная Telegram-подпись и заранее подтверждённая оператором тестовая привязка. Этот экран не создаёт аккаунт автоматически.</p>
  {/if}
</Card.Root>
