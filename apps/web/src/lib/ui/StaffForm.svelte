<script lang="ts">
  import type { Service } from "../model";

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

<form class="card" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
  <span class="eyebrow">ДОБАВИТЬ МАСТЕРА</span>
  <h2>Новый специалист</h2>
  <label class="field">
    Псевдоним мастера
    <input
      value={staffName}
      oninput={(event) => onNameChange(event.currentTarget.value)}
      required
      maxlength="80"
      placeholder="Алекс Демо"
    />
  </label>
  <label class="field">
    Название на витрине
    <input
      value={staffTitle}
      oninput={(event) => onTitleChange(event.currentTarget.value)}
      maxlength="80"
      placeholder="Стилист"
    />
  </label>
  <label class="field">
    Услуга
    <select
      value={staffService}
      onchange={(event) => onServiceChange(event.currentTarget.value)}
      required
    >
      <option value="" disabled>Выберите услугу</option>
      {#each services as service (service.id)}
        <option value={service.id}>{service.name}</option>
      {/each}
    </select>
  </label>
  {#if services.length === 0}
    <p class="inline-note">Сначала добавьте хотя бы одну услугу.</p>
    <button type="button" class="btn btn-secondary btn-wide" onclick={onOpenServices}>
      К услугам →
    </button>
  {:else}
    <button type="submit" class="btn btn-primary btn-wide">
      Добавить демо-мастера <span aria-hidden="true">→</span>
    </button>
  {/if}
</form>
