<script lang="ts">
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import RealOwnerServicesPage from "./RealOwnerServicesPage.svelte";
  import RealOwnerStaffPage from "./RealOwnerStaffPage.svelte";

  export let session: VerifiedOwnerSession;
  export let onLogout: () => void;

  let section: "services" | "staff" = "services";
</script>

<nav class="real-owner-nav" aria-label="Разделы кабинета владельца">
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
</nav>
{#if section === "services"}
  <RealOwnerServicesPage {session} {onLogout} />
{:else}
  <RealOwnerStaffPage {session} onOpenServices={() => (section = "services")} />
{/if}
