<script lang="ts">
  import { ArrowUpRight, Info } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { Service } from "../model";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";

  export let services: Service[];
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
  <form class="owner-form" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <OwnerFormHeader kind="staff" eyebrow="КОМАНДА / 02"
      title="Новый специалист" description="Создайте демонстрационный профиль мастера." />
    <div class="owner-form-fields">
      <label class="field">
        Псевдоним мастера
        <Input value={staffName} oninput={(event) => onNameChange(event.currentTarget.value)}
          required maxlength={80} placeholder="Алекс Демо" />
      </label>
      <label class="field">
        Роль на витрине
        <Input value={staffTitle} oninput={(event) => onTitleChange(event.currentTarget.value)}
          maxlength={80} placeholder="Стилист" />
      </label>
      <label class="field">
        Услуга мастера
        <select value={staffService}
          onchange={(event) => onServiceChange(event.currentTarget.value)} required>
          <option value="" disabled>Выберите услугу</option>
          {#each services as service (service.id)}
            <option value={service.id}>{service.name}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="owner-form-note">
      <Info size={16} aria-hidden="true" />
      <span>Для демо используйте вымышленные имена. Настоящие права доступа здесь не назначаются.</span>
    </div>
    {#if services.length === 0}
      <Button class="owner-submit owner-submit-secondary" variant="outline" type="button" size="lg" onclick={onOpenServices}>
        Сначала добавьте услугу <ArrowUpRight size={17} aria-hidden="true" />
      </Button>
    {:else}
      <Button class="owner-submit" type="submit" size="lg">
        Добавить демо-мастера <ArrowUpRight size={17} aria-hidden="true" />
      </Button>
    {/if}
  </form>
</Card.Root>
