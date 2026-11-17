<script lang="ts">
  import { ArrowUpRight, Info } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";

  export let serviceName: string;
  export let serviceDuration: number;
  export let servicePrice: number;
  export let onNameChange: (value: string) => void;
  export let onDurationChange: (value: number) => void;
  export let onPriceChange: (value: number) => void;
  export let onSubmit: () => void;
  export let apiMode = false;
  export let busy = false;
</script>

<Card.Root class="owner-form-panel">
  <form class="owner-form" onsubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(); }}>
    <OwnerFormHeader kind="service" eyebrow="КАТАЛОГ / 01"
      title="Новая услуга" description={apiMode ? "Создайте сохранённый черновик услуги." : "Добавьте позицию для тестовой записи."} />
    <div class="owner-form-fields">
      <label class="field">
        Название услуги
        <Input value={serviceName} oninput={(event) => onNameChange(event.currentTarget.value)}
          required disabled={busy} maxlength={100} placeholder="Например, женская стрижка" />
      </label>
      <div class="form-pair">
        <label class="field">
          Длительность · мин
          <Input type="number" value={serviceDuration}
            oninput={(event) => onDurationChange(event.currentTarget.valueAsNumber)}
            min={1} max={1440} step={1} required disabled={busy} />
        </label>
        <label class="field">
          Базовая цена · ₽
          <Input type="number" value={servicePrice}
            oninput={(event) => onPriceChange(event.currentTarget.valueAsNumber)}
            min={0} max={9999999999} step={1} required disabled={busy} />
        </label>
      </div>
    </div>
    <div class="owner-form-note">
      <Info size={16} aria-hidden="true" />
      <span>Указана цена по каталогу, без скидок и надбавок. Итоговую стоимость рассчитывает только backend.</span>
    </div>
    <Button class="owner-submit" type="submit" size="lg" disabled={busy}>
      {apiMode ? (busy ? "Сохраняем…" : "Сохранить черновик") : "Добавить демо-услугу"} <ArrowUpRight size={17} aria-hidden="true" />
    </Button>
  </form>
</Card.Root>
