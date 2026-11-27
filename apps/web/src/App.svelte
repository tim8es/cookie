<script lang="ts">
  import { onMount } from "svelte";
  import { defaultOwnerScreen, ownerRouteHref, ownerScreenFromPath, type Screen } from "./lib/navigation";
  import Sidebar from "./lib/ui/Sidebar.svelte";
  import { Button } from "./lib/components/ui/button/index.js";
  import OnboardingHeader from "./lib/ui/OnboardingHeader.svelte";
  import IdentityAuthGate from "./lib/ui/IdentityAuthGate.svelte";
  import RealOwnerWorkspace from "./lib/ui/RealOwnerWorkspace.svelte";
  import {
    revokeTelegramOwnerSession,
    watchOwnerSessionExpiry,
    type VerifiedCustomerSession,
    type VerifiedOwnerSession,
  } from "./lib/owner-auth";
  import { canRetainGlobalIdentity, watchBrowserIdentitySession, type IdentityAuthSession } from "./lib/identity-auth";
  import { writeLogoutPending, writeWorkspaceHint } from "./lib/workspace-hint";
  import "./styles.css";
  import "./visual-system.css";
  import "./lib/components/rhythm/workspace.css";

  // URL selects a customer presentation only; all access is checked by the API.
  let customerSurface = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("surface") === "customer-staging";
  let customerTenantId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tenantId") ?? "" : "";
  let screen: Screen = typeof window === "undefined"
    ? defaultOwnerScreen
    : ownerScreenFromPath(window.location.pathname) ?? defaultOwnerScreen;
  let ownerSession: VerifiedOwnerSession | null = null;
  let customerSession: VerifiedCustomerSession | null = null;
  let customerAuthNotice = "";
  let failedCustomerLoadLogoutPending = false;
  let ownerAuthPhase: "unavailable" | "verified" | "signing-out" | "signed-out" | "logout-failed" | "expired" | "denied" = "unavailable";
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
        : ownerAuthPhase === "denied"
          ? "Доступ к кабинету не подтверждён сервером. Войдите снова или выберите другой кабинет."
          : "";

  function syncOwnerLocation(canonicalize: boolean): void {
    screen = ownerScreenFromPath(window.location.pathname) ?? defaultOwnerScreen;
    if (!canonicalize || customerSurface) return;
    const target = ownerRouteHref(screen, window.location);
    if (target !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(window.history.state, "", target);
    }
  }

  function rememberVerifiedOwner(): void {
    if (!verifiedOwner || !ownerSession) return;
    writeWorkspaceHint(window.history, ownerSession.browserBound
      ? { role: "business", tenantId: ownerSession.tenantId }
      : null);
  }

  function navigateOwner(next: Screen): void {
    if (!verifiedOwner) return;
    const target = ownerRouteHref(next, window.location);
    if (target !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.pushState(null, "", target);
      rememberVerifiedOwner();
    }
    screen = next;
  }

  onMount(() => {
    const onPopState = () => {
      syncOwnerLocation(verifiedOwner);
      rememberVerifiedOwner();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      stopOwnerExpiry?.();
      stopBrowserWatch?.();
      ownerSession = null;
      customerSession = null;
    };
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
    syncOwnerLocation(true);
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

  function denyOwnerSession(session: VerifiedOwnerSession): void {
    if (ownerSession !== session) return;
    stopBrowserWatch?.();
    stopBrowserWatch = null;
    stopOwnerExpiry?.();
    stopOwnerExpiry = null;
    identityForSwitch = session.accessToken.startsWith("is_")
      ? {
          accessToken: session.accessToken,
          expiresAtUnixSeconds: session.expiresAtUnixSeconds,
          browserBound: session.browserBound,
        }
      : null;
    writeWorkspaceHint(window.history, null);
    restoreAllowed = identityForSwitch !== null;
    ownerSession = null;
    ownerAuthPhase = "denied";
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

  async function leaveDeniedCustomerContext(): Promise<void> {
    const current = customerSession;
    if (!current) return;
    // The child has already hidden all customer data. Only re-enter the
    // chooser if this exact account is still authenticated independently.
    const retain = await canRetainGlobalIdentity(current);
    if (customerSession !== current) return;
    if (retain && current.expiresAtUnixSeconds > Math.floor(Date.now() / 1000)) {
      switchAccountContext();
      customerAuthNotice = "Доступ к клиентскому кабинету не подтверждён. Выберите доступный кабинет.";
      return;
    }
    clearCustomerSession("expired");
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

  async function logoutAfterCustomerLoadFailure(): Promise<void> {
    const session = customerSession;
    if (!session || failedCustomerLoadLogoutPending) return;
    const globalIdentity = session.accessToken.startsWith("is_");
    if (globalIdentity) writeLogoutPending(window.history, true);
    failedCustomerLoadLogoutPending = true;
    try {
      await revokeTelegramOwnerSession(session);
      if (customerSession !== session) return;
      if (globalIdentity) writeLogoutPending(window.history, false);
      clearCustomerSession("signed-out");
    } catch {
      if (customerSession === session) clearCustomerSession("logout-failed");
    } finally {
      failedCustomerLoadLogoutPending = false;
    }
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
    window.history.replaceState(
      window.history.state,
      "",
      ownerRouteHref("services", url),
    );
  }

  async function logoutOwner(): Promise<void> {
    const session = ownerSession;
    if (!session || ownerAuthPhase !== "verified") return;
    if (session.accessToken.startsWith("is_")) writeLogoutPending(window.history, true);
    else writeWorkspaceHint(window.history, null);
    stopBrowserWatch?.();
    stopOwnerExpiry?.();
    stopOwnerExpiry = null;
    restoreAllowed = false;
    identityForSwitch = null;
    ownerSession = null;
    ownerAuthPhase = "signing-out";
    try {
      await revokeTelegramOwnerSession(session);
      if (session.accessToken.startsWith("is_")) writeLogoutPending(window.history, false);
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

<div class="app-shell real-owner-shell" data-cookie-mode="api" class:verified-owner-shell={verifiedOwner} class:rhythm-scope={verifiedOwner}>
  {#if verifiedOwner}
    <Sidebar {screen} stepCount={0} realOwner={true} onNavigate={navigateOwner}
      organizationName={ownerSession?.organizationName} onLogout={() => void logoutOwner()}
      onSwitchAccount={ownerSession?.accessToken.startsWith("is_") ? switchAccountContext : undefined} />
  {/if}
  <div class="main-area">
    {#if !verifiedOwner}
      <OnboardingHeader apiMode={true} label={customerMode ? "Клиентский staging" : "Вход и регистрация"} />
    {/if}
    <main class="content">
      {#if customerSession}
        {#await import("./lib/ui/StagingCustomerGate.svelte")}
          <p class="card" role="status">Загружаем кабинет клиента…</p>
        {:then module}
          <svelte:component this={module.default} initialSession={customerSession} onContextDenied={() => void leaveDeniedCustomerContext()} onSessionCleared={clearCustomerSession} onSwitchAccount={customerSession.accessToken.startsWith("is_") ? switchAccountContext : undefined} />
        {:catch}
          <section class="card">
            <p role="alert">Не удалось загрузить кабинет клиента.</p>
            <div class="customer-load-actions">
              <Button variant="outline" href={window.location.href}>Перезагрузить страницу</Button>
              {#if customerSession.accessToken.startsWith("is_")}
                <Button type="button" variant="outline" disabled={failedCustomerLoadLogoutPending}
                  onclick={switchAccountContext}>Сменить кабинет</Button>
              {/if}
              <Button type="button" variant="outline" disabled={failedCustomerLoadLogoutPending}
                onclick={() => void logoutAfterCustomerLoadFailure()}>
                {failedCustomerLoadLogoutPending ? "Завершаем сеанс…" : "Выйти"}
              </Button>
            </div>
          </section>
        {/await}
      {:else if verifiedOwner && ownerSession}
        {#key ownerSession}
          <RealOwnerWorkspace session={ownerSession} {screen} onNavigate={navigateOwner} onAccessDenied={denyOwnerSession} />
        {/key}
      {:else if ownerAuthPhase === "signing-out"}
        <section class="state-card feedback-state" aria-label="Завершение сеанса">
          <h1>Завершаем сеанс</h1>
          <p role="status">Ожидаем подтверждение выхода от сервера.</p>
        </section>
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
