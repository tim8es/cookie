<script lang="ts">
  import { onMount } from "svelte";
  import type { ViewState } from "./lib/model";
  import { defaultOwnerScreen, ownerRouteHref, ownerScreenFromPath, type Screen } from "./lib/navigation";
  import Sidebar from "./lib/ui/Sidebar.svelte";
  import Topbar from "./lib/ui/Topbar.svelte";
  import OnboardingHeader from "./lib/ui/OnboardingHeader.svelte";
  import OwnerAuthGate from "./lib/ui/OwnerAuthGate.svelte";
  import StagingCustomerGate from "./lib/ui/StagingCustomerGate.svelte";
  import RealOwnerWorkspace from "./lib/ui/RealOwnerWorkspace.svelte";
  import {
    authenticateTelegramOwner,
    loadTelegramInitData,
    revokeTelegramOwnerSession,
    watchOwnerSessionExpiry,
    type VerifiedOwnerSession,
  } from "./lib/owner-auth";
  import "./styles.css";
  import "./visual-system.css";

  // Presentation selection is not a trusted tenant or role claim.
  const customerSurface = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("surface") === "customer-staging";
  let screen: Screen = typeof window === "undefined" ? defaultOwnerScreen : ownerScreenFromPath(window.location.pathname) ?? defaultOwnerScreen;
  let preview: ViewState = "normal";
  let ownerSession: VerifiedOwnerSession | null = null;
  let ownerAuthPhase: "unavailable" | "loading" | "verified" | "error" | "signing-out" | "signed-out" | "logout-failed" | "expired" = "unavailable";
  let stopOwnerExpiry: (() => void) | null = null;
  let ownerMounted = false;

  $: verifiedOwner = !customerSurface && ownerAuthPhase === "verified" && ownerSession !== null;

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
    ownerMounted = true;
    const onPopState = () => syncOwnerLocation(verifiedOwner);
    window.addEventListener("popstate", onPopState);
    if (!customerSurface) void authenticateOwner();
    return () => {
      window.removeEventListener("popstate", onPopState);
      ownerMounted = false;
      stopOwnerExpiry?.();
      ownerSession = null;
    };
  });

  async function authenticateOwner(): Promise<void> {
    ownerAuthPhase = "loading";
    try {
      const initData = await loadTelegramInitData(window, document);
      if (!ownerMounted) return;
      if (!initData) {
        ownerAuthPhase = "unavailable";
        return;
      }
      const session = await authenticateTelegramOwner(initData);
      if (!ownerMounted) {
        await revokeTelegramOwnerSession(session).catch(() => undefined);
        return;
      }
      stopOwnerExpiry?.();
      ownerSession = session;
      ownerAuthPhase = "verified";
      syncOwnerLocation(true);
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
    } catch {
      if (!ownerMounted) return;
      ownerSession = null;
      ownerAuthPhase = "error";
    }
  }

  async function logoutOwner(): Promise<void> {
    const session = ownerSession;
    if (!session || ownerAuthPhase !== "verified") return;
    // Discard the bearer immediately; even failed remote revocation cannot
    // restore any owner permissions in the current browser session.
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
  <title>{customerSurface ? "kuki — вход клиента (staging)" : "kuki — кабинет салона"}</title>
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
      <OnboardingHeader apiMode={true} />
    {/if}
    <main class="content">
      {#if customerSurface}
        <StagingCustomerGate />
      {:else if ownerAuthPhase === "verified" && ownerSession}
        <RealOwnerWorkspace session={ownerSession} {screen} onNavigate={navigateOwner} />
      {:else}
        <OwnerAuthGate phase={ownerAuthPhase} onLogout={() => void logoutOwner()} />
      {/if}
    </main>
  </div>
</div>
