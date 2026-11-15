<script lang="ts">
  export let serviceName: string;
  export let serviceDuration: number;
  export let servicePrice: number;
  export let onNameChange: (value: string) => void;
  export let onDurationChange: (value: number) => void;
  export let onPriceChange: (value: number) => void;
  export let onSubmit: () => void;
</script>

<form class="card" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
  <span class="eyebrow">ДОБАВИТЬ УСЛУГУ</span>
  <h2>Новая услуга</h2>
  <p class="muted">
    Базовая цена без скидок и надбавок. Никаких вычислений стоимости в браузере.
  </p>
  <label class="field">
    Название
    <input
      value={serviceName}
      oninput={(event) => onNameChange(event.currentTarget.value)}
      required
      maxlength="100"
    />
  </label>
  <div class="form-pair">
    <label class="field">
      Длительность, мин
      <input
        type="number"
        value={serviceDuration}
        oninput={(event) => onDurationChange(event.currentTarget.valueAsNumber)}
        min="1"
        step="1"
        required
      />
    </label>
    <label class="field">
      Базовая цена, ₽
      <input
        type="number"
        value={servicePrice}
        oninput={(event) => onPriceChange(event.currentTarget.valueAsNumber)}
        min="0"
        step="1"
        required
      />
    </label>
  </div>
  <button class="btn btn-primary btn-wide" type="submit">
    Добавить демо-услугу <span aria-hidden="true">→</span>
  </button>
</form>
