<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { branchToday, createOwnerReads } from "../owner-reads";
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

  const reads = createOwnerReads(session);

  async function prepareCalendar(): Promise<void> {
    // Let the first screen finish its main read before starting background work.
    if (screen === "services") await reads.services.load();
    else if (screen === "home") await reads.overview.load();
    else return;
    if (screen !== "services" && screen !== "home") return;
    const branch = (await reads.calendarBranches()).find((item) => item.timeZone);
    if (branch?.timeZone) await reads.calendar(branch.id, branchToday(branch.timeZone), 1).load();
  }

  onMount(() => {
    void prepareCalendar().catch(() => undefined);
  });
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
