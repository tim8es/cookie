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
  import RealOwnerAppearancePage from "./RealOwnerAppearancePage.svelte";

  export let session: VerifiedOwnerSession;
  export let screen: Screen;
  export let onNavigate: (next: Screen) => void;
  export let onAccessDenied: (session: VerifiedOwnerSession) => void;

  // Capture the keyed session. Do not trigger a hidden calendar permission
  // check while the owner is working in an unrelated section.
  const current = session;
  const reads = createOwnerReads(current, () => onAccessDenied(current));
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
    <RealOwnerAppearancePage {session} />
  {/key}
{:else if screen === "booking"}
  <RealOwnerUnavailablePage {screen} onReturn={() => onNavigate("home")} />
{/if}
