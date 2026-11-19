<script lang="ts">
  import { onMount } from "svelte";
  import type { ViewState } from "./lib/model";
  import { defaultOwnerScreen, ownerRouteHref, ownerScreenFromPath, type Screen } from "./lib/navigation";
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
  import "./styles.css";
  import "./visual-system.css";

  // URL selects a customer presentation only; all access is checked by the API.
  const customerSurface = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("surface") === "customer-staging";
  const customerTenantId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tenantId") ?? "" : "";
  let screen: Screen = typeof window === "undefined" ? defaultOwnerScreen : ownerScreenFromPath(window.location.pathname) ?? defaultOwnerScreen;
  let preview: ViewState = "normal";
  let ownerSession: VerifiedOwnerSession | null = null;
  let customerSession: VerifiedCustomerSession | null = null;
  let customerAuthNotice = "";
  let ownerAuthPhase: "unavailable" | "verified" | "signing-out" | "signed-out" | "logout-failed" | "expired" = "unavailable";
  let stopOwnerExpiry: (() => void) | null = null;

  $: customerMode = customerSurface || customerSession !== null;
  $: verifiedOwner = !customerMode && ownerAuthPhase === "verified" && ownerSession !== null;
  $: ownerAuthNotice = ownerAuthPhase === "signed-out"
    ? "Вы вышли. Серверная сессия отозвана."
    : ownerAuthPhase === "logout-failed"
      ? "Локальный вход закрыт, но сервер не подтвердил отзыв. Старая сессия может действовать до истечения срока."
      : ownerAuthPhase === "expired"
        ? "Срок действия сеанса истёк. Войдите снова."
        : "";

  function syncOwnerLocation(canonicalize: boolean): void {
    screen = ownerScreenFromPath(window.location.pathname) ?? defaultOwnerScreen;
    if (!canonicalize || customerSurface) return;
    const target = ownerRouteHref(screen, window.location);
    if (target !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(window.history.state, "", target);
    }
  }

  function navigateOwner(next: Screen): void {
    if (!verifiedOwner) return;
    const target = ownerRouteHref(next, window.location);
    if (target !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.pushState(null, "", target);
    }
    screen = next;
  }

  onMount(() => {
    const onPopState = () => syncOwnerLocation(verifiedOwner);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      stopOwnerExpiry?.();
      ownerSession = null;
      customerSession = null;
    };
  });

  function acceptOwnerSession(session: VerifiedOwnerSession): void {
    stopOwnerExpiry?.();
    ownerSession = session;
    ownerAuthPhase = "verified";
    syncOwnerLocation(customerSession === null);
    stopOwnerExpiry = watchOwnerSessionExpiry(
      session.expiresAtUnixSeconds,
      () => {
        if (ownerSession !== session) return;
        ownerSession = null;
        ownerAuthPhase = "expired";
      },
      window,
      document,
    );
  }

  function acceptCustomerSession(session: VerifiedCustomerSession): void {
    customerAuthNotice = "";
    customerSession = session;
  }

  function clearCustomerSession(reason: "expired" | "signed-out" | "logout-failed"): void {
    customerSession = null;
    customerAuthNotice = reason === "signed-out"
      ? "Вы вышли. Серверная сессия отозвана."
      : reason === "logout-failed"
        ? "Локальный клиентский вход закрыт, но сервер не подтвердил отзыв. Не используйте эту сессию."
        : "Клиентская сессия завершена или отозвана. Войдите снова.";
  }

  async function logoutOwner(): Promise<void> {
    const session = ownerSession;
    if (!session || ownerAuthPhase !== "verified") return;
    stopOwnerExpiry?.();
    stopOwnerExpiry = null;
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
    <Sidebar {screen} stepCount={0} realOwner={true} onNavigate={navigateOwner} />
  {/if}
  <div class="main-area">
    {#if verifiedOwner}
      <Topbar {screen} bind:preview canCreateBooking={false} demoMode={false} onNavigate={navigateOwner} onLogout={() => void logoutOwner()} />
    {:else}
      <OnboardingHeader apiMode={true} label={customerMode ? "Клиентский staging" : "Вход и регистрация"} />
    {/if}
    <main class="content">
      {#if customerSession}
        <StagingCustomerGate initialSession={customerSession} onSessionCleared={clearCustomerSession} />
      {:else if verifiedOwner && ownerSession}
        {#key ownerSession}
          <RealOwnerWorkspace session={ownerSession} {screen} onNavigate={navigateOwner} />
        {/key}
      {:else}
        <IdentityAuthGate
          customerSurface={customerSurface}
          {customerTenantId}
          authNotice={customerAuthNotice || ownerAuthNotice}
          onOwnerSession={acceptOwnerSession}
          onCustomerSession={acceptCustomerSession}
        />
      {/if}
    </main>
  </div>
</div>
