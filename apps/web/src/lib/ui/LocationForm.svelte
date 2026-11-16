<script lang="ts">
  import { ArrowUpRight, Info } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Input } from "../components/ui/input/index.js";
  import OwnerFormHeader from "./OwnerFormHeader.svelte";

  export let locationName: string;
  export let locationAddress: string;
  export let onNameChange: (value: string) => void;
  export let onAddressChange: (value: string) => void;
  export let onSubmit: () => void;
</script>

<Card.Root class="owner-form-panel">
  <form class="owner-form" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <OwnerFormHeader kind="location" eyebrow="ФИЛИАЛЫ / 04"
      title="Новый филиал" description="Добавьте тестовую точку обслуживания." />
    <div class="owner-form-fields">
      <label class="field">
        Название филиала
        <Input value={locationName} oninput={(event) => onNameChange(event.currentTarget.value)}
          required maxlength={80} placeholder="Второй филиал (демо)" />
      </label>
      <label class="field">
        Демонстрационный адрес
        <Input value={locationAddress} oninput={(event) => onAddressChange(event.currentTarget.value)}
          maxlength={120} placeholder="Тестовый адрес" />
      </label>
    </div>
    <div class="owner-form-note">
      <Info size={16} aria-hidden="true" />
      <span>Адрес нужен только для проверки отображения и выбора филиала. Не вводите реальные персональные данные.</span>
    </div>
    <Button class="owner-submit" type="submit" size="lg">
      Добавить демо-филиал <ArrowUpRight size={17} aria-hidden="true" />
    </Button>
  </form>
</Card.Root>
