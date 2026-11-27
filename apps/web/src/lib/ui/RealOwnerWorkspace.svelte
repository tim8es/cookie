<script lang="ts">
  import { onDestroy } from "svelte";
  import { createOwnerReads } from "../owner-reads";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import type { Screen } from "../navigation";
  import RealOwnerServicesPage from "./RealOwnerServicesPage.svelte";
  import RealOwnerStaffPage from "./RealOwnerStaffPage.svelte";
  import RealOwnerLocationsPage from "./RealOwnerLocationsPage.svelte";
  import PageHeader from "../components/rhythm/PageHeader.svelte";
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
  {#await import("./RealOwnerSchedulePage.svelte")}
    <PageHeader title="Расписание" organization={session.organizationName} />
    <p class="card" role="status">Загружаем расписание…</p>
  {:then module}
    <svelte:component this={module.default} {session} {reads} onOpenStaff={() => onNavigate("staff")} />
  {:catch}
    <PageHeader title="Расписание" organization={session.organizationName} />
    <section class="card">
      <p role="alert">Не удалось загрузить расписание.</p>
      <Button type="button" variant="outline" onclick={() => window.location.reload()}>Перезагрузить страницу</Button>
    </section>
  {/await}
{:else if screen === "appearance"}
  <PageHeader title="Оформление" organization={session.organizationName} />
  {#key session.accessToken}
    {#await import("./RealOwnerAppearancePage.svelte")}
      <section class="card" role="status">Загружаем редактор оформления…</section>
    {:then module}
      <svelte:component this={module.default} {session} {reads} />
    {:catch}
      <section class="card">
        <p role="alert">Не удалось загрузить редактор оформления. Проверьте соединение и перезагрузите страницу.</p>
        <Button type="button" variant="outline" onclick={() => window.location.reload()}>Перезагрузить страницу</Button>
      </section>
    {/await}
  {/key}
{:else if screen === "booking"}
  <RealOwnerUnavailablePage {screen} organizationName={session.organizationName} onReturn={() => onNavigate("home")} />
{/if}
