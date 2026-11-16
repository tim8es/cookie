<script lang="ts">
  import { money } from "../dates";
  import type { DemoSnapshot } from "../model";
  import ServiceForm from "./ServiceForm.svelte";

  export let data: DemoSnapshot;
  export let serviceName: string;
  export let serviceDuration: number;
  export let servicePrice: number;
  export let onNameChange: (value: string) => void;
  export let onDurationChange: (value: number) => void;
  export let onPriceChange: (value: number) => void;
  export let onSubmit: () => void;
</script>

<div class="section-head"><div><span class="eyebrow">КАТАЛОГ САЛОНА</span><h1>Услуги и цены</h1><p>Единая длительность и базовая цена на уровне организации.</p></div><span class="counter-pill">{data.services.length} услуг</span></div>
        <div class="workspace-grid"><section class="card"><div class="card-title"><div><span class="eyebrow">КАТАЛОГ</span><h2>Ваши услуги</h2></div></div>
          {#if data.services.length === 0}<div class="empty-mini"><span>◇</span><strong>Здесь появятся услуги</strong><p>Добавьте услугу через форму создания.</p></div>{:else}
            <div class="list-items">{#each data.services as service}<div class="entity-row"><span class="service-tile">✳</span><div class="entity-text"><strong>{service.name}</strong><small>{service.durationMinutes} мин · единая длительность</small></div><strong class="price-label">{money(service.basePriceRub)}</strong></div>{/each}</div>
          {/if}
        </section>
        <ServiceForm
            {serviceName}
            {serviceDuration}
            {servicePrice}
            {onNameChange}
            {onDurationChange}
            {onPriceChange}
            {onSubmit}
          /></div>
