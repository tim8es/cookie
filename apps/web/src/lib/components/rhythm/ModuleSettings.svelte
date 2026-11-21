<script lang="ts">
  import type { ModuleDisplay } from "./contracts.js";

  let {
    modules,
    onToggle,
    title = "Модули",
  }: {
    modules: readonly ModuleDisplay[];
    onToggle: (id: string, enabled: boolean) => void | Promise<void>;
    title?: string;
  } = $props();

  let pending = $state<string[]>([]);
  let error = $state("");
  async function request(id: string, enabled: boolean) {
    if (pending.includes(id)) return;
    pending = [...pending, id];
    error = "";
    try {
      await onToggle(id, enabled);
    } catch {
      error = "Не удалось изменить модуль. Повторите попытку.";
    } finally {
      pending = pending.filter((candidate) => candidate !== id);
    }
  }
</script>

<section class="rhythm-panel rhythm-stack" data-component="ModuleSettings" aria-label={title}>
  <h3 class="rhythm-subhead">{title}</h3>
  <div class="rhythm-module-grid">
    {#each modules as module (module.id)}
      <div class="rhythm-module-item">
        <div class="rhythm-copy">
          <strong>{module.label}</strong>
          {#if module.description}<small class="rhythm-muted">{module.description}</small>{/if}
        </div>
        <button type="button" role="switch" class="rhythm-module-switch"
          aria-label={module.label}
          aria-checked={module.enabled}
          aria-busy={pending.includes(module.id)}
          disabled={module.locked || pending.includes(module.id)}
          onclick={() => request(module.id, !module.enabled)}>
          <span class="sr-only">{module.enabled ? "Отключить" : "Включить"} {module.label}</span>
        </button>
      </div>
    {/each}
  </div>
  {#if error}<p role="alert" class="rhythm-error">{error}</p>{/if}
</section>
