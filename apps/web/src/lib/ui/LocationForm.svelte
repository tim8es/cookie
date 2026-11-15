<script lang="ts">
  export let locationName: string;
  export let locationAddress: string;
  export let onNameChange: (value: string) => void;
  export let onAddressChange: (value: string) => void;
  export let onSubmit: () => void;
</script>

<form class="card" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
  <span class="eyebrow">НОВЫЙ ФИЛИАЛ</span>
  <h2>Добавить локацию</h2>
  <label class="field">
    Название
    <input
      value={locationName}
      oninput={(event) => onNameChange(event.currentTarget.value)}
      maxlength="80"
      required
    />
  </label>
  <label class="field">
    Демонстрационный адрес
    <input
      value={locationAddress}
      oninput={(event) => onAddressChange(event.currentTarget.value)}
      maxlength="120"
    />
  </label>
  <button class="btn btn-primary btn-wide" type="submit">
    Добавить демо-филиал →
  </button>
</form>
