<script lang="ts">
  import { ArrowUpRight, Info } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";

  export let serviceName: string;
  export let serviceDuration: number | undefined;
  export let servicePrice: number | undefined;
  export let onNameChange: (value: string) => void;
  export let onDurationChange: (value: number) => void;
  export let onPriceChange: (value: number) => void;
  export let onSubmit: () => void;
  export let apiMode = false;
  export let busy = false;
  export let editing = false;
  export let frozen = false;
  export let onCancelEdit: () => void = () => undefined;
</script>

<Card.Root class="owner-form-panel">
  <form class="owner-form" onsubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(); }}>
    <OwnerFormHeader kind="service" eyebrow="КАТАЛОГ / 01"
      title={editing ? "Редактирование услуги" : "Новая услуга"} description={editing ? "Измените сохранённый черновик." : apiMode ? "Создайте сохранённый черновик услуги." : "Добавьте позицию для тестовой записи."} />
    <div class="owner-form-fields">
      <label class="field">
        Название услуги
        <Input value={serviceName} oninput={(event) => onNameChange(event.currentTarget.value)}
          required maxlength={apiMode ? 200 : 100} disabled={busy || frozen} placeholder="Например, женская стрижка" />
      </label>
      <div class="form-pair">
        <label class="field">
          Длительность · мин
          <Input type="number" value={serviceDuration ?? ""}
            oninput={(event) => onDurationChange(event.currentTarget.valueAsNumber)}
            min={1} max={1440} step={1} required disabled={busy || frozen} />
        </label>
        <label class="field">
          Базовая цена · ₽
          <Input type="number" value={servicePrice ?? ""}
            oninput={(event) => onPriceChange(event.currentTarget.valueAsNumber)}
            min={0} max={apiMode ? 9999999999.99 : 9999999999} step={apiMode ? 0.01 : 1} required disabled={busy || frozen} />
        </label>
      </div>
    </div>
    <div class="owner-form-note">
      <Info size={16} aria-hidden="true" />
      <span>Указана цена по каталогу, без скидок и надбавок. Итоговую стоимость рассчитывает только backend.</span>
    </div>
    <Button class="owner-submit" type="submit" size="lg" disabled={busy}>
      {apiMode ? (busy ? "Сохраняем…" : editing ? "Сохранить изменения" : "Сохранить черновик") : "Добавить демо-услугу"} <ArrowUpRight size={17} aria-hidden="true" />
    </Button>
    {#if editing}
      <Button type="button" variant="outline" disabled={busy || frozen} onclick={onCancelEdit}>Отменить редактирование</Button>
    {/if}
  </form>
</Card.Root>
