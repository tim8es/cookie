<script lang="ts">
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
</script>

{#if screen === "home"}
  <RealOwnerOverviewPage
    {session}
    onOpenLocations={() => onNavigate("locations")}
    onOpenServices={() => onNavigate("services")}
    onOpenStaff={() => onNavigate("staff")}
  />
{:else if screen === "services"}
  <RealOwnerServicesPage {session} />
{:else if screen === "staff"}
  <RealOwnerStaffPage {session} onOpenServices={() => onNavigate("services")} />
{:else if screen === "locations"}
  <RealOwnerLocationsPage {session} />
{:else if screen === "calendar"}
  <RealOwnerCalendarPage {session} />
{:else if screen === "schedule"}
  <RealOwnerSchedulePage {session} onOpenStaff={() => onNavigate("staff")} />
{:else if screen === "appearance"}
  {#key session.accessToken}
    <RealOwnerAppearancePage {session} />
  {/key}
{:else if screen === "booking"}
  <RealOwnerUnavailablePage {screen} onReturn={() => onNavigate("home")} />
{/if}
