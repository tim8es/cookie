<script lang="ts">
  import { ArrowUpRight, Info } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { Service } from "../model";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";

  export let services: ReadonlyArray<Pick<Service, "id" | "name">>;
  export let locations: ReadonlyArray<{ id: string; displayName: string }> = [];
  export let staffLocation = "";
  export let onLocationChange: (value: string) => void = () => undefined;
  export let apiMode = false;
  export let busy = false;
  export let staffName: string;
  export let staffTitle: string;
  export let staffService: string;
  export let onNameChange: (value: string) => void;
  export let onTitleChange: (value: string) => void;
  export let onServiceChange: (value: string) => void;
  export let onSubmit: () => void;
  export let onOpenServices: () => void;
</script>

<Card.Root class="owner-form-panel">
  <form class="owner-form" onsubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(); }}>
    <OwnerFormHeader kind="staff" eyebrow="КОМАНДА / 02"
      title="Новый специалист" description={apiMode ? "Сохраните профиль мастера и начальное назначение услуги." : "Создайте демонстрационный профиль мастера."} />
    <div class="owner-form-fields">
      <label class="field">
        Псевдоним мастера
        <Input value={staffName} oninput={(event) => onNameChange(event.currentTarget.value)}
          required disabled={busy} maxlength={80} placeholder="Алекс Демо" />
      </label>
      <label class="field">
        Роль на витрине
        <Input value={staffTitle} oninput={(event) => onTitleChange(event.currentTarget.value)}
          maxlength={80} disabled={busy} placeholder="Стилист" />
      </label>
      {#if apiMode}
        <label class="field">
          Филиал
          <select value={staffLocation}
            onchange={(event) => onLocationChange(event.currentTarget.value)} required disabled={busy}>
            <option value="" disabled>Выберите филиал</option>
            {#each locations as location (location.id)}
              <option value={location.id}>{location.displayName}</option>
            {/each}
          </select>
        </label>
      {/if}
      <label class="field">
        Услуга мастера
        <select value={staffService}
          onchange={(event) => onServiceChange(event.currentTarget.value)} required disabled={busy}>
          <option value="" disabled>Выберите услугу</option>
          {#each services as service (service.id)}
            <option value={service.id}>{service.name}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="owner-form-note">
      <Info size={16} aria-hidden="true" />
      <span>{apiMode ? "Профиль и назначения сохраняются как черновики без публикации. Название должности не предоставляет системных прав." : "Для демо используйте вымышленные имена. Настоящие права доступа здесь не назначаются."}</span>
    </div>
    {#if services.length === 0}
      <Button class="owner-submit owner-submit-secondary" variant="outline" type="button" size="lg" onclick={onOpenServices}>
        Сначала добавьте услугу <ArrowUpRight size={17} aria-hidden="true" />
      </Button>
    {:else}
      <Button class="owner-submit" type="submit" size="lg" disabled={busy || (apiMode && locations.length === 0)}>
        {apiMode ? (busy ? "Сохраняем…" : "Сохранить профиль") : "Добавить демо-мастера"} <ArrowUpRight size={17} aria-hidden="true" />
      </Button>
    {/if}
  </form>
</Card.Root>
