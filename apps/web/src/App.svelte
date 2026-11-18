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
  import "./styles.css";
  import "./visual-system.css";

  // URL selects a customer presentation only; all access is checked by the API.
  const customerSurface = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("surface") === "customer-staging";
  const customerTenantId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tenantId") ?? "" : "";
  let screen: Screen = "services";
  let preview: ViewState = "normal";
  let ownerSession: VerifiedOwnerSession | null = null;
  let customerSession: VerifiedCustomerSession | null = null;
  let ownerAuthPhase: "unavailable" | "verified" | "signing-out" | "signed-out" | "logout-failed" | "expired" = "unavailable";
  let stopOwnerExpiry: (() => void) | null = null;

  $: customerMode = customerSurface || customerSession !== null;
  $: verifiedOwner = !customerMode && ownerAuthPhase === "verified" && ownerSession !== null;
  $: ownerAuthNotice = ownerAuthPhase === "signed-out"
    ? "Вы вышли. Серверная сессия отозвана."
    : ownerAuthPhase === "logout-failed"
      ? "Локальный вход закрыт, но сервер не подтвердил отзыв. Старая сессия может действовать до истечения срока."
      : ownerAuthPhase === "expired"
        ? "Срок действия входа истёк. Войдите снова."
        : "";

  onMount(() => () => {
    stopOwnerExpiry?.();
    ownerSession = null;
    customerSession = null;
  });

  function acceptOwnerSession(session: VerifiedOwnerSession): void {
    stopOwnerExpiry?.();
    ownerSession = session;
    ownerAuthPhase = "verified";
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
    customerSession = session;
  }

  function clearCustomerSession(): void {
    customerSession = null;
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
  <title>{customerMode ? "kuki — вход клиента (staging)" : "kuki — вход и кабинет салона"}</title>
  <meta name="description" content="kuki: защищённый кабинет услуг и мастеров." />
</svelte:head>

<div class="app-shell real-owner-shell" data-cookie-mode="api" class:verified-owner-shell={verifiedOwner}>
  {#if verifiedOwner}
    <Sidebar {screen} stepCount={0} realOwner={true} onNavigate={(next) => screen = next} />
  {/if}
  <div class="main-area">
    {#if verifiedOwner}
      <Topbar {screen} bind:preview canCreateBooking={false} demoMode={false} onNavigate={(next) => screen = next} onLogout={() => void logoutOwner()} />
    {:else}
      <OnboardingHeader apiMode={true} label={customerMode ? "Клиентский staging" : "Вход и регистрация"} />
    {/if}
    <main class="content">
      {#if customerSession}
        <StagingCustomerGate initialSession={customerSession} onSessionCleared={clearCustomerSession} />
      {:else if verifiedOwner && ownerSession}
        <RealOwnerWorkspace session={ownerSession} {screen} onNavigate={(next) => screen = next} />
      {:else}
        <IdentityAuthGate
          customerSurface={customerSurface}
          {customerTenantId}
          authNotice={ownerAuthNotice}
          onOwnerSession={acceptOwnerSession}
          onCustomerSession={acceptCustomerSession}
        />
      {/if}
    </main>
  </div>
</div>
