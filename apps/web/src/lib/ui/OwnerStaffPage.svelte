<script lang="ts">
  import type { DemoSnapshot } from "../model";
  import StaffForm from "./StaffForm.svelte";

  export let data: DemoSnapshot;
  export let staffName: string;
  export let staffTitle: string;
  export let staffService: string;
  export let getService: (id: string) => string;
  export let onNameChange: (value: string) => void;
  export let onTitleChange: (value: string) => void;
  export let onServiceChange: (value: string) => void;
  export let onOpenServices: () => void;
  export let onSubmit: () => void;
</script>

<div class="section-head"><div><span class="eyebrow">ВАША КОМАНДА</span><h1>Мастера</h1><p>Профили и услуги мастеров. Доступы и права здесь не назначаются.</p></div><span class="counter-pill">{data.staff.length} специалистов</span></div>
        <div class="workspace-grid"><section class="card"><span class="eyebrow">КОМАНДА</span><h2>Специалисты салона</h2>
          {#if data.staff.length === 0}<div class="empty-mini"><span>♧</span><strong>Команда пока пуста</strong><p>Добавьте мастера с синтетическим именем.</p></div>{:else}
            <div class="list-items">{#each data.staff as member}<div class="entity-row"><span class="staff-avatar">{member.displayName.slice(0, 1)}</span><div class="entity-text"><strong>{member.displayName}</strong><small>{member.positionTitle} · {member.serviceIds.map(getService).join(", ")}</small></div><span class="status-pill">Демо</span></div>{/each}</div>
          {/if}
        </section>
        <StaffForm
            services={data.services}
            {staffName}
            {staffTitle}
            {staffService}
            {onNameChange}
            {onTitleChange}
            {onServiceChange}
            {onOpenServices}
            {onSubmit}
          /></div>
