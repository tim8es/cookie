<script lang="ts">
  import type { DemoSnapshot } from "../model";
  import LocationForm from "./LocationForm.svelte";

  export let data: DemoSnapshot;
  export let locationName: string;
  export let locationAddress: string;
  export let onNameChange: (value: string) => void;
  export let onAddressChange: (value: string) => void;
  export let onSubmit: () => void;
</script>

<div class="section-head"><div><span class="eyebrow">СТРУКТУРА САЛОНА</span><h1>Филиалы</h1><p>Синтетические адреса для демонстрации переключения локаций.</p></div></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">ЛОКАЦИИ</span><h2>Филиалы организации</h2>
          <div class="list-items">{#each data.locations as location}<div class="entity-row"><span class="service-tile">⌂</span><div class="entity-text"><strong>{location.name}</strong><small>{location.address}</small></div><span class="status-pill">Демо</span></div>{/each}</div>
        </section>
        <LocationForm
            {locationName}
            {locationAddress}
            {onNameChange}
            {onAddressChange}
            {onSubmit}
          /></div>
