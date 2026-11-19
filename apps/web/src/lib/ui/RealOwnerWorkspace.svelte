<script lang="ts">
  import { onDestroy } from "svelte";
  import { createOwnerReads } from "../owner-reads";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import type { Screen } from "../navigation";
  import RealOwnerServicesPage from "./RealOwnerServicesPage.svelte";
  import RealOwnerStaffPage from "./RealOwnerStaffPage.svelte";
  import RealOwnerLocationsPage from "./RealOwnerLocationsPage.svelte";
  import RealOwnerSchedulePage from "./RealOwnerSchedulePage.svelte";
  import RealOwnerCalendarPage from "./RealOwnerCalendarPage.svelte";
  import RealOwnerOverviewPage from "./RealOwnerOverviewPage.svelte";
  import RealOwnerUnavailablePage from "./RealOwnerUnavailablePage.svelte";
  import { Button } from "../components/ui/button/index.js";

  export let session: VerifiedOwnerSession;
  export let screen: Screen;
  export let onNavigate: (next: Screen) => void;
  export let onAccessDenied: (session: VerifiedOwnerSession) => void;

  const currentSession = session;
  const reads = createOwnerReads(
    currentSession,
    () => onAccessDenied(currentSession),
  );
  onDestroy(reads.close);
</script>

{#if screen === "home"}
  <RealOwnerOverviewPage
    {session}
    {reads}
    onOpenLocations={() => onNavigate("locations")}
    onOpenServices={() => onNavigate("services")}
    onOpenStaff={() => onNavigate("staff")}
  />
{:else if screen === "services"}
  <RealOwnerServicesPage {session} {reads} />
{:else if screen === "staff"}
  <RealOwnerStaffPage {session} {reads} onOpenServices={() => onNavigate("services")} />
{:else if screen === "locations"}
  <RealOwnerLocationsPage {session} {reads} />
{:else if screen === "calendar"}
  <RealOwnerCalendarPage {session} {reads} />
{:else if screen === "schedule"}
  <RealOwnerSchedulePage {session} {reads} onOpenStaff={() => onNavigate("staff")} />
{:else if screen === "appearance"}
  {#key session.accessToken}
    {#await import("./RealOwnerAppearancePage.svelte")}
      <div class="section-head"><h1>Оформление</h1></div>
      <section class="card" role="status">Загружаем редактор оформления…</section>
    {:then module}
      <svelte:component this={module.default} {session} {reads} />
    {:catch}
      <div class="section-head"><h1>Оформление</h1></div>
      <section class="card">
        <p role="alert">Не удалось загрузить редактор оформления. Проверьте соединение и перезагрузите страницу.</p>
        <Button type="button" variant="outline" onclick={() => window.location.reload()}>Перезагрузить страницу</Button>
      </section>
    {/await}
  {/key}
{:else if screen === "booking"}
  <RealOwnerUnavailablePage {screen} onReturn={() => onNavigate("home")} />
{/if}
