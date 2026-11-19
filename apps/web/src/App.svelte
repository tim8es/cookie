<script lang="ts">
  import { onMount } from "svelte";
  import type { ViewState } from "./lib/model";
  import type { Screen } from "./lib/navigation";
  import Sidebar from "./lib/ui/Sidebar.svelte";
  import Topbar from "./lib/ui/Topbar.svelte";
  import OnboardingHeader from "./lib/ui/OnboardingHeader.svelte";
  import IdentityAuthGate from "./lib/ui/IdentityAuthGate.svelte";
  import StagingCustomerGate from "./lib/ui/StagingCustomerGate.svelte";
  import RealOwnerWorkspace from "./lib/ui/RealOwnerWorkspace.svelte";
  import {
    revokeTelegramOwnerSession,
    watchOwnerSessionExpiry,
    type VerifiedCustomerSession,
    type VerifiedOwnerSession,
  } from "./lib/owner-auth";
  import { watchBrowserIdentitySession, type IdentityAuthSession } from "./lib/identity-auth";
  import { writeWorkspaceHint } from "./lib/workspace-hint";
  import "./styles.css";
  import "./visual-system.css";

  // URL selects a customer presentation only; all access is checked by the API.
  let customerSurface = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("surface") === "customer-staging";
  let customerTenantId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tenantId") ?? "" : "";
  let screen: Screen = "services";
  let preview: ViewState = "normal";
  let ownerSession: VerifiedOwnerSession | null = null;
  let customerSession: VerifiedCustomerSession | null = null;
  let customerAuthNotice = "";
  let ownerAuthPhase: "unavailable" | "verified" | "signing-out" | "signed-out" | "logout-failed" | "expired" = "unavailable";
  let stopOwnerExpiry: (() => void) | null = null;
  let stopBrowserWatch: (() => void) | null = null;
  let identityForSwitch: IdentityAuthSession | null = null;
  let restoreAllowed = true;

  $: customerMode = customerSurface || customerSession !== null;
  $: verifiedOwner = !customerMode && ownerAuthPhase === "verified" && ownerSession !== null;
  $: ownerAuthNotice = ownerAuthPhase === "signed-out"
    ? "Вы вышли. Серверная сессия отозвана."
    : ownerAuthPhase === "logout-failed"
      ? "Локальный вход закрыт, но сервер не подтвердил отзыв. Старая сессия может действовать до истечения срока."
      : ownerAuthPhase === "expired"
        ? "Срок действия сеанса истёк. Войдите снова."
        : "";

  onMount(() => () => {
    stopOwnerExpiry?.();
    stopBrowserWatch?.();
    ownerSession = null;
    customerSession = null;
  });

  function watchWorkspace(session: VerifiedOwnerSession): void {
    stopBrowserWatch?.();
    stopBrowserWatch = watchBrowserIdentitySession(session, () => {
      if (ownerSession !== session && customerSession !== session) return;
      stopOwnerExpiry?.();
      stopOwnerExpiry = null;
      identityForSwitch = null;
      writeWorkspaceHint(window.history, null);
      restoreAllowed = false;
      ownerSession = null;
      customerSession = null;
      ownerAuthPhase = "unavailable";
      customerAuthNotice = "Сессия в браузере изменилась или завершилась. Войдите снова.";
    }, window, document);
  }

  function acceptOwnerSession(session: VerifiedOwnerSession): void {
    identityForSwitch = null;
    customerSession = null;
    customerAuthNotice = "";
    stopOwnerExpiry?.();
    ownerSession = session;
    ownerAuthPhase = "verified";
    writeWorkspaceHint(window.history, session.browserBound ? { role: "business", tenantId: session.tenantId } : null);
    watchWorkspace(session);
    stopOwnerExpiry = watchOwnerSessionExpiry(
      session.expiresAtUnixSeconds,
      () => {
        if (ownerSession !== session) return;
        ownerSession = null;
        writeWorkspaceHint(window.history, null);
        stopBrowserWatch?.();
        restoreAllowed = false;
        ownerAuthPhase = "expired";
      },
      window,
      document,
    );
  }

  function acceptCustomerSession(session: VerifiedCustomerSession): void {
    identityForSwitch = null;
    stopOwnerExpiry?.();
    stopOwnerExpiry = null;
    ownerSession = null;
    ownerAuthPhase = "unavailable";
    customerAuthNotice = "";
    customerSession = session;
    writeWorkspaceHint(window.history, session.browserBound ? { role: "customer", tenantId: session.tenantId } : null);
    watchWorkspace(session);
  }

  function clearCustomerSession(reason: "expired" | "signed-out" | "logout-failed"): void {
    stopBrowserWatch?.();
    writeWorkspaceHint(window.history, null);
    restoreAllowed = false;
    identityForSwitch = null;
    customerSession = null;
    customerAuthNotice = reason === "signed-out"
      ? "Вы вышли. Серверная сессия отозвана."
      : reason === "logout-failed"
        ? "Локальный клиентский вход закрыт, но сервер не подтвердил отзыв. Не используйте эту сессию."
        : "Клиентская сессия завершена или отозвана. Войдите снова.";
  }

  function switchAccountContext(): void {
    const current = customerSession ?? ownerSession;
    if (!current?.accessToken.startsWith("is_")) return;
    if (current.expiresAtUnixSeconds <= Math.floor(Date.now() / 1000)) return;
    identityForSwitch = {
      accessToken: current.accessToken,
      expiresAtUnixSeconds: current.expiresAtUnixSeconds,
      browserBound: current.browserBound,
    };
    writeWorkspaceHint(window.history, null);
    restoreAllowed = true;
    stopBrowserWatch?.();
    stopOwnerExpiry?.();
    stopOwnerExpiry = null;
    ownerSession = null;
    customerSession = null;
    ownerAuthPhase = "unavailable";
    customerAuthNotice = "";
    screen = "services";
    // Explicitly leave the customer-only presentation, not its permissions.
    customerSurface = false;
    customerTenantId = "";
    const url = new URL(window.location.href);
    url.searchParams.delete("surface");
    url.searchParams.delete("tenantId");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }

  async function logoutOwner(): Promise<void> {
    const session = ownerSession;
    if (!session || ownerAuthPhase !== "verified") return;
    writeWorkspaceHint(window.history, null);
    stopBrowserWatch?.();
    stopOwnerExpiry?.();
    stopOwnerExpiry = null;
    restoreAllowed = false;
    identityForSwitch = null;
    ownerSession = null;
    ownerAuthPhase = "signing-out";
    try {
      await revokeTelegramOwnerSession(session);
      ownerAuthPhase = "signed-out";
    } catch {
      ownerAuthPhase = "logout-failed";
    }
  }
</script>

<svelte:head>
  <title>{customerMode ? "kuki — вход клиента (staging)" : verifiedOwner ? "kuki — кабинет салона" : "kuki — вход и регистрация"}</title>
  <meta name="description" content="kuki: защищённый кабинет услуг и мастеров." />
</svelte:head>

<div class="app-shell real-owner-shell" data-cookie-mode="api" class:verified-owner-shell={verifiedOwner}>
  {#if verifiedOwner}
    <Sidebar {screen} stepCount={0} realOwner={true} onNavigate={(next) => screen = next} />
  {/if}
  <div class="main-area">
    {#if verifiedOwner}
      <Topbar {screen} bind:preview canCreateBooking={false} demoMode={false} onNavigate={(next) => screen = next} onLogout={() => void logoutOwner()} onSwitchAccount={ownerSession?.accessToken.startsWith("is_") ? switchAccountContext : undefined} />
    {:else}
      <OnboardingHeader apiMode={true} label={customerMode ? "Клиентский staging" : "Вход и регистрация"} />
    {/if}
    <main class="content">
      {#if customerSession}
        <StagingCustomerGate initialSession={customerSession} onSessionCleared={clearCustomerSession} onSwitchAccount={customerSession.accessToken.startsWith("is_") ? switchAccountContext : undefined} />
      {:else if verifiedOwner && ownerSession}
        {#key ownerSession}
          <RealOwnerWorkspace session={ownerSession} {screen} onNavigate={(next) => screen = next} />
        {/key}
      {:else}
        <IdentityAuthGate
          customerSurface={customerSurface}
          {customerTenantId}
          authNotice={customerAuthNotice || ownerAuthNotice}
          initialIdentitySession={identityForSwitch}
          {restoreAllowed}
          onOwnerSession={acceptOwnerSession}
          onCustomerSession={acceptCustomerSession}
        />
      {/if}
    </main>
  </div>
</div>
