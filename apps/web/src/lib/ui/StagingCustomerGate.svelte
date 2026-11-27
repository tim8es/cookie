<script lang="ts">
  import { onMount } from "svelte";
  import StagingCustomerOffers from "./StagingCustomerOffers.svelte";
  import StagingCustomerHistory from "./StagingCustomerHistory.svelte";
  import type { OwnBookingHistory } from "../staging-customer-history-api";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { authenticateTelegramCustomer, loadTelegramInitData, revokeTelegramOwnerSession, watchOwnerSessionExpiry, type VerifiedCustomerSession } from "../owner-auth";
  import { writeLogoutPending } from "../workspace-hint";
  type SessionClearReason = "expired" | "signed-out" | "logout-failed";
  export let initialSession: VerifiedCustomerSession | null = null;
  export let onSwitchAccount: (() => void) | undefined = undefined;
  export let onSessionCleared: (reason: SessionClearReason) => void = () => {};
  export let onContextDenied: (() => void) | undefined = undefined;
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
    if (!mounted || phase !== "verified") return;
    session = null;
    phase = "error";
    stopExpiry?.(); stopExpiry = null;
    onSessionCleared("expired");
  }
  function denyContext(): void {
    if (!mounted || phase !== "verified" || !session) return;
    if (!session.accessToken.startsWith("is_") || !onContextDenied ||
        session.expiresAtUnixSeconds <= Math.floor(Date.now() / 1000)) {
      expire();
      return;
    }
    session = null;
    historySnapshot = null;
    stopExpiry?.(); stopExpiry = null;
    phase = "loading";
    onContextDenied();
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
    if (!current || !mounted || phase !== "verified") return;
    if (current.accessToken.startsWith("is_")) writeLogoutPending(window.history, true);
    session = null;
    stopExpiry?.(); stopExpiry = null;
    phase = "signing-out";
    try {
      await revokeTelegramOwnerSession(current);
      if (mounted && current.accessToken.startsWith("is_")) writeLogoutPending(window.history, false);
      phase = "signed-out";
    }
    catch { phase = "logout-failed"; }
    if (mounted) onSessionCleared(phase === "signed-out" ? "signed-out" : "logout-failed");
  }
  onMount(() => {
    if (initialSession) {
      phase = "verified";
      stopExpiry = watchOwnerSessionExpiry(initialSession.expiresAtUnixSeconds, expire, window, document);
    } else void signIn();
    return () => { mounted = false; stopExpiry?.(); stopExpiry = null; };
  });
</script>

<Card.Root class={phase === "verified" ? "customer-session" : "state-card feedback-state"} aria-label="Клиентский вход staging">
  {#if phase !== "verified"}<span class="feedback-overline">kuki / КЛИЕНТСКИЙ ВХОД STAGING</span>{/if}
  {#if phase === "verified" && session}
    <div class="customer-session-content">
      <div><h1>Вход клиента подтверждён</h1><p>Вы вошли в тестовый клиентский кабинет.</p></div>
      <div class="customer-session-actions">
        {#if onSwitchAccount}
          <Button type="button" variant="outline" onclick={onSwitchAccount}>Сменить кабинет</Button>
        {/if}
        <Button type="button" variant="outline" onclick={() => void logout()}>Выйти</Button>
      </div>
    </div>
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
  <StagingCustomerOffers {session} {historySnapshot} onUnauthorized={denyContext} onConfirmed={created} />
  {#key historyVersion}
    <StagingCustomerHistory {session} onUnauthorized={denyContext} onHistory={value => historySnapshot = value} />
  {/key}
{/if}

<style>
  .customer-session-content {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
  }
  .customer-session-content h1 { font-size: 16px; margin: 0; }
  .customer-session-content p { color: var(--muted-foreground); font-size: 13px; margin: 4px 0 0; }
  .customer-session-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .customer-session-actions :global(button) { min-height: 44px; }
</style>
