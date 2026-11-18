<script lang="ts">
  import { onMount } from "svelte";
  import StagingCustomerOffers from "./StagingCustomerOffers.svelte";
  import StagingCustomerHistory from "./StagingCustomerHistory.svelte";
  import type { OwnBookingHistory } from "../staging-customer-history-api";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { authenticateTelegramCustomer, loadTelegramInitData, revokeTelegramOwnerSession, watchOwnerSessionExpiry, type VerifiedCustomerSession } from "../owner-auth";
  type SessionClearReason = "expired" | "signed-out" | "logout-failed";
  export let initialSession: VerifiedCustomerSession | null = null;
  export let onSwitchAccount: (() => void) | undefined = undefined;
  export let onSessionCleared: (reason: SessionClearReason) => void = () => {};
  let session: VerifiedCustomerSession | null = initialSession;
  let phase: "loading" | "unavailable" | "verified" | "error" | "signing-out" | "signed-out" | "logout-failed" = "loading";
  let stopExpiry: (() => void) | null = null;
  let mounted = true;
  let historyVersion = 0;
  let historySnapshot: OwnBookingHistory | null = null;
  function created(): void {
    historySnapshot = null;
    historyVersion++;
  }
  function expire(): void {
    session = null;
    phase = "error";
    stopExpiry?.(); stopExpiry = null;
    onSessionCleared("expired");
  }
  async function signIn(): Promise<void> {
    try {
      const proof = await loadTelegramInitData(window, document);
      if (!proof) { phase = "unavailable"; return; }
      const verified = await authenticateTelegramCustomer(proof);
      if (!mounted) { void revokeTelegramOwnerSession(verified).catch(() => undefined); return; }
      session = verified;
      phase = "verified";
      stopExpiry = watchOwnerSessionExpiry(verified.expiresAtUnixSeconds, expire, window, document);
    } catch {
      session = null;
      phase = "error";
    }
  }
  async function logout(): Promise<void> {
    const current = session;
    if (!current) return;
    session = null;
    stopExpiry?.(); stopExpiry = null;
    phase = "signing-out";
    try { await revokeTelegramOwnerSession(current); phase = "signed-out"; }
    catch { phase = "logout-failed"; }
    onSessionCleared(phase === "signed-out" ? "signed-out" : "logout-failed");
  }
  onMount(() => {
    if (initialSession) {
      phase = "verified";
      stopExpiry = watchOwnerSessionExpiry(initialSession.expiresAtUnixSeconds, expire, window, document);
    } else void signIn();
    return () => { mounted = false; stopExpiry?.(); stopExpiry = null; };
  });
</script>

<Card.Root class="state-card feedback-state" aria-label="Клиентский вход staging">
  <span class="feedback-overline">kuki / КЛИЕНТСКИЙ ВХОД STAGING</span>
  {#if phase === "verified" && session}
    <h1>Вход клиента подтверждён</h1>
    <p>Сервер подтвердил вашу клиентскую учётную запись в тестовой организации. Это не даёт доступа к кабинету владельца.</p>
    <p>Доступные операции определяет сервер. Реальные клиентские данные не используются.</p>
    {#if onSwitchAccount}
      <Button type="button" variant="outline" onclick={onSwitchAccount}>Сменить кабинет</Button>
    {/if}
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

{#if phase === "verified" && session}
  <StagingCustomerOffers {session} {historySnapshot} onUnauthorized={expire} onConfirmed={created} />
  {#key historyVersion}
    <StagingCustomerHistory {session} onUnauthorized={expire} onHistory={value => historySnapshot = value} />
  {/key}
{/if}
