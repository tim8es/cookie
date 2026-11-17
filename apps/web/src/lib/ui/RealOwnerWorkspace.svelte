<script lang="ts">
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import RealOwnerServicesPage from "./RealOwnerServicesPage.svelte";
  import RealOwnerStaffPage from "./RealOwnerStaffPage.svelte";
  import RealOwnerLocationsPage from "./RealOwnerLocationsPage.svelte";
  import RealOwnerOverviewPage from "./RealOwnerOverviewPage.svelte";

  export let session: VerifiedOwnerSession;
  export let onLogout: () => void;

  let section: "overview" | "services" | "staff" | "locations" = "services";
</script>

<nav class="real-owner-nav" aria-label="Разделы кабинета владельца">
  <Button
    type="button"
    variant={section === "overview" ? "default" : "outline"}
    aria-current={section === "overview" ? "page" : undefined}
    onclick={() => (section = "overview")}
  >Обзор</Button>
  <Button
    type="button"
    variant={section === "services" ? "default" : "outline"}
    aria-current={section === "services" ? "page" : undefined}
    onclick={() => (section = "services")}
  >Услуги</Button>
  <Button
    type="button"
    variant={section === "staff" ? "default" : "outline"}
    aria-current={section === "staff" ? "page" : undefined}
    onclick={() => (section = "staff")}
  >Мастера</Button>
  <Button
    type="button"
    variant={section === "locations" ? "default" : "outline"}
    aria-current={section === "locations" ? "page" : undefined}
    onclick={() => (section = "locations")}
  >Филиалы</Button>
  <Button type="button" variant="outline" onclick={onLogout}>Выйти</Button>
</nav>
{#if section === "overview"}
  <RealOwnerOverviewPage
    {session}
    onOpenLocations={() => (section = "locations")}
    onOpenServices={() => (section = "services")}
    onOpenStaff={() => (section = "staff")}
  />
{:else if section === "services"}
  <RealOwnerServicesPage {session} {onLogout} />
{:else if section === "staff"}
  <RealOwnerStaffPage {session} onOpenServices={() => (section = "services")} />
{:else}
  <RealOwnerLocationsPage {session} />
{/if}
